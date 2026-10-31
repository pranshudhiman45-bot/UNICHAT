require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
require('./utils/asyncErrors'); // must load before any router is created

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');
const mongoose = require('mongoose');
const socketHandler = require('./socket/socketHandler');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const workspaceRoutes = require('./routes/workspaces');
const channelRoutes = require('./routes/channels');
const messageRoutes = require('./routes/messages');
const dmRoutes = require('./routes/dms');
const fileRoutes = require('./routes/files');
const searchRoutes = require('./routes/search');
const notificationRoutes = require('./routes/notifications');
const starredRoutes = require('./routes/starred');
const savedRoutes = require('./routes/saved');
const adminRoutes = require('./routes/admin');
const passwordResetRoutes = require('./routes/passwordResets');
const identityRoutes = require('./routes/identity');
const { limiter, connectRedis, closeRedis, redisReady, redisStatus } = require('./services/redis');
const { cleanupOrphanedAttachments, startCleanupScheduler, cleanupStats } = require('./utils/cleanupAttachments');
const { secureAttachmentLinks } = require('./services/attachmentAccess');
const { describeError } = require('./utils/logSafe');
const { requestKey, isUserKey } = require('./middleware/rateKeys');
const { migrateStarredToSaved } = require('./utils/migrations');

const PORT = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.CLIENT_URL || '')
  .split(',')
  // Browsers send Origin without a trailing slash; tolerate "https://app.example/" in configuration.
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

function validateConfig() {
  const missing = [];
  if (!process.env.MONGODB_URI && !process.env.MONGO_URI) missing.push('MONGODB_URI');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.JWT_REFRESH_SECRET) missing.push('JWT_REFRESH_SECRET');
  if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_API_URL) missing.push('PUBLIC_API_URL');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  // Any internet-facing deployment (production, or a staging/demo profile served over HTTPS) needs strong, distinct
  // signing secrets; plain-HTTP local development keeps its short test secrets.
  const deployed = process.env.NODE_ENV === 'production' || /^https:\/\//i.test(process.env.PUBLIC_API_URL || '');
  if (deployed && (process.env.JWT_SECRET.length < 32 || process.env.JWT_REFRESH_SECRET.length < 32)) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must each contain at least 32 characters when deployed');
  }
  if (deployed && process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) throw new Error('Use distinct access and refresh signing secrets');
  if (Boolean(process.env.ADMIN_EMAIL) !== Boolean(process.env.ADMIN_PASSWORD_HASH)) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD_HASH must be configured together');
  if (process.env.ADMIN_PASSWORD_HASH && !/^\$2[aby]\$(?:1[2-9]|2\d|3[01])\$[./A-Za-z0-9]{53}$/.test(process.env.ADMIN_PASSWORD_HASH)) throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash with cost 12 or higher');
  if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_HASH)) throw new Error('Admin credentials are required in production');
  if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_API_URL.startsWith('https://')) throw new Error('PUBLIC_API_URL must use HTTPS in production');
  if (process.env.NODE_ENV === 'production') {
    // Not fatal, but each of these silently weakens a protection, so say so loudly at startup.
    if (!process.env.REDIS_URL) console.warn('WARNING: REDIS_URL is not set. Rate limits and Socket.IO are single-instance; do NOT run more than one API instance.');
    if (Number(process.env.TRUST_PROXY_HOPS || 0) === 0) console.warn('WARNING: TRUST_PROXY_HOPS=0 in production. Behind a load balancer every client appears to share one IP, which collapses per-IP rate limits and audit logs. Set it to the exact number of proxies in front of the API.');
    if (process.env.REFRESH_REUSE_WINDOW_SECONDS === undefined) console.warn('NOTE: refresh tokens have a 30s reuse window (default) so a lost response does not log users out. Set REFRESH_REUSE_WINDOW_SECONDS=0 for strict single-use.');
    if (process.env.EMAIL_TRANSPORT === 'file') throw new Error('File email delivery is only available for local testing');
    if (process.env.FILE_STORAGE === 'local') throw new Error('Local file storage is only available for testing; configure Cloudinary for production');
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) throw new Error('SMTP_HOST and SMTP_FROM are required in production');
    if (process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) throw new Error('Use distinct access and refresh signing secrets');
    if (!allowedOrigins.length || allowedOrigins.some((origin) => !origin.startsWith('https://'))) throw new Error('Configure HTTPS ALLOWED_ORIGINS');
  }
}

// A web app on another site (e.g. *.vercel.app calling *.onrender.com) only keeps its refresh cookie with
// COOKIE_SAMESITE=none. Without it, sign-in works but every reload signs the user out, so say so at startup.
function warnIfCrossSiteCookieMisconfigured() {
  if (process.env.COOKIE_SAMESITE === 'none' || !process.env.PUBLIC_API_URL) return;
  const site = (url) => { try { return new URL(url).hostname.split('.').slice(-2).join('.'); } catch { return null; } };
  const apiSite = site(process.env.PUBLIC_API_URL);
  const crossSite = allowedOrigins.filter((origin) => site(origin) && site(origin) !== apiSite);
  if (crossSite.length) console.warn(`WARNING: ${crossSite.join(', ')} is a different site than the API (${apiSite}). Set COOKIE_SAMESITE=none or users will be signed out on every reload.`);
}

function isAllowedOrigin(origin) {
  return !origin || allowedOrigins.includes(origin);
}

const app = express();
const httpServer = http.createServer(app);
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
}));
morgan.token('request-path', (req) => req.path);
app.use(morgan(':method :request-path :status :response-time ms'));
// Messages are capped well below 1 MB (40k chars + 120k rich-text chars); file uploads use multipart, not JSON.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
// Unauthenticated liveness probe for the hosting platform (registered before the HTTPS/origin guards).
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => {
  if (process.env.NODE_ENV === 'production' && !req.secure) return res.status(426).json({ error: 'HTTPS required' });
  if (req.get('Origin') && !isAllowedOrigin(req.get('Origin'))) return res.status(403).json({ error: 'Origin not allowed' });
  // Cookie authentication requires a custom header and a same-origin/CORS JSON
  // request. Reject form posts before any login or refresh cookies can change.
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.path.startsWith('/auth') && !req.is('application/json')) return res.status(415).json({ error: 'Use application/json' });
  next();
});
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => json(req.userId ? secureAttachmentLinks(body, req) : body);
  next();
});

if (process.env.NODE_ENV !== 'development') {
  // Per-user budget for signed-in traffic, per-IP budget for everything anonymous. Both are configurable.
  const userBudget = Number(process.env.API_RATE_LIMIT_USER || 1500);
  const anonymousBudget = Number(process.env.API_RATE_LIMIT_IP || 300);
  const apiLimiter = limiter('api', {
    windowMs: 15 * 60 * 1000,
    limit: (req) => (isUserKey(req) ? userBudget : anonymousBudget),
    keyGenerator: requestKey,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api/', apiLimiter);
}

app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
// Readiness: the database is required. Redis is optional, so its absence reports "degraded" with HTTP 200;
// failing the probe would make a load balancer pull every instance during a Redis outage, turning a
// partial degradation into a total one.
app.get('/health', (req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  const redis = redisStatus();
  const status = !databaseReady ? 'not_ready' : redisReady() ? 'ok' : 'degraded';
  res.status(databaseReady ? 200 : 503).json({ status, checks: { database: databaseReady ? 'ready' : 'unavailable', redis: redis.status === 'disabled' ? 'disabled' : redisReady() ? 'ready' : 'unavailable' }, redis, cleanup: cleanupStats() });
});

app.use('/api/auth', authRoutes);
app.use('/api/auth', identityRoutes);
app.use('/api/auth/password-resets', passwordResetRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/users', userRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/dms', dmRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/starred', starredRoutes);
app.use('/api/saved', savedRoutes);

socketHandler(io);
app.set('io', io);

app.use((err, req, res, next) => {
  console.error(err.name === 'ValidationError' || err.name === 'CastError' ? describeError(err) : (err.stack || describeError(err)));
  const status = err.status || (err.name === 'ValidationError' || err.name === 'CastError' || err.type === 'entity.parse.failed' ? 400 : err.code === 11000 ? 409 : 500);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : status === 409 ? 'This item already exists' : err.message || 'Invalid request' });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

let stopCleanup = () => undefined;
let safetyNetsInstalled = false;
// Last resort only: request-level errors are already contained (see utils/asyncErrors). Anything reaching here is
// a bug in background work; it is logged loudly instead of silently killing every connected user.
function installProcessSafetyNets() {
  if (safetyNetsInstalled) return;
  safetyNetsInstalled = true;
  process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason));
}
async function startServer() {
  try {
    validateConfig();
    warnIfCrossSiteCookieMisconfigured();
    installProcessSafetyNets();
    await connectDB();
    await connectRedis(io);
    await migrateStarredToSaved().then((count) => { if (count) console.log(`Migrated ${count} starred message(s) into saved messages`); }).catch((error) => console.error('Starred migration failed:', error.message));
    await cleanupOrphanedAttachments().catch((error) => console.error('Attachment cleanup failed:', error));
    await new Promise((resolve, reject) => {
      const onError = (error) => { httpServer.off('listening', onListening); reject(error); };
      const onListening = () => { httpServer.off('error', onError); resolve(); };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(PORT);
    });
    stopCleanup = startCleanupScheduler();
    console.log(`HTTP API listening on port ${PORT}`);
    console.log('Socket.IO server ready');
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    const shutdown = () => {
      stopCleanup();
      const deadline = setTimeout(() => process.exit(1), 10000).unref();
      io.close(async () => { await mongoose.disconnect(); await closeRedis(); clearTimeout(deadline); });
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Startup failed: port ${PORT} is already in use. Another backend may already be running.`);
      console.error('Use either npm run dev from the project root (API + web, testing env) or separate backend/web terminals, not both.');
      console.error(`Stop the existing server first, or set a different PORT and update the clients' API/socket URLs.`);
    } else {
      console.error(`Startup failed: ${err.message}`);
    }
    process.exitCode = 1;
    // Failed startup must release database/Redis connections and socket timers.
    const deadline = setTimeout(() => process.exit(1), 10000).unref();
    try {
      await new Promise((resolve) => io.close(resolve));
      await Promise.all([mongoose.disconnect(), closeRedis()]);
    } catch (cleanupError) {
      console.error(`Startup cleanup failed: ${cleanupError.message}`);
    } finally {
      clearTimeout(deadline);
    }
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, io, startServer };
