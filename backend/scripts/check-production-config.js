#!/usr/bin/env node
// Production configuration checklist. Prints a status per setting and NEVER prints a secret value (names and
// pass/fail reasons only). Exit code 1 when anything required is MISSING or UNSAFE.
//
//   npm --prefix backend run check:prod-config                      # checks the current process environment
//   ENV_FILE=/path/to/production.env npm --prefix backend run check:prod-config
//   node scripts/check-production-config.js --env-file /path/to/production.env
//
// Statuses:  CORRECT  required/recommended and fine   |  MISSING  required but absent
//            UNSAFE   present but dangerous           |  WARN     works, but weakens a protection
//            OPTIONAL not set, and that is fine       |  INFO     informational
const fs = require('node:fs');
const dotenv = require('dotenv');

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--env-file');
const envFile = flagIndex >= 0 ? args[flagIndex + 1] : process.env.ENV_FILE;
const env = { ...(envFile && fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {}), ...(envFile ? {} : process.env) };
if (envFile && !fs.existsSync(envFile)) { console.error(`Env file not found: ${envFile}`); process.exit(2); }

const results = [];
const add = (status, name, note) => results.push({ status, name, note });
const get = (name) => String(env[name] ?? '').trim();
const has = (name) => get(name).length > 0;
const placeholder = /(change[-_ ]?this|your[-_ ]|example|placeholder|changeme|secret-key|^test|password123|^dev)/i;
const isHttps = (value) => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
const isLocalHost = (value) => { try { return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(new URL(value).hostname); } catch { return /localhost|127\.0\.0\.1/.test(value); } };
const uniqueChars = (value) => new Set(value).size;

function secret(name, { distinctFrom } = {}) {
  const value = get(name);
  if (!value) return add('MISSING', name, 'required');
  if (value.length < 32) return add('UNSAFE', name, `shorter than 32 characters (${value.length})`);
  if (placeholder.test(value)) return add('UNSAFE', name, 'looks like a placeholder/sample value');
  if (uniqueChars(value) < 12) return add('UNSAFE', name, 'very low entropy (too few distinct characters)');
  if (distinctFrom && value === get(distinctFrom)) return add('UNSAFE', name, `identical to ${distinctFrom}; use independent secrets`);
  return add('CORRECT', name, `${value.length} characters, not a placeholder${distinctFrom ? `, distinct from ${distinctFrom}` : ''}`);
}

// --- environment mode -------------------------------------------------------------------------------------------
if (get('NODE_ENV') === 'production') add('CORRECT', 'NODE_ENV', 'exactly "production"');
else add('UNSAFE', 'NODE_ENV', `must be exactly "production" (is ${has('NODE_ENV') ? 'a different value' : 'unset'}); any other value silently enables development behaviour: insecure cookies, HTTP allowed, local file email/storage`);
for (const leftover of ['DEV_EMAIL_DIR', 'LOCAL_UPLOAD_DIR', 'SEED_ALLOW_REMOTE']) if (has(leftover)) add('UNSAFE', leftover, 'development/test-only variable set in a production environment');
if (/\.env\.test|\.env\.local/.test(get('ENV_FILE'))) add('UNSAFE', 'ENV_FILE', 'points at a test/local env file');

// --- secrets & admin --------------------------------------------------------------------------------------------
secret('JWT_SECRET');
secret('JWT_REFRESH_SECRET', { distinctFrom: 'JWT_SECRET' });
if (has('PASSWORD_RESET_PEPPER')) secret('PASSWORD_RESET_PEPPER', { distinctFrom: 'JWT_SECRET' });
else add('WARN', 'PASSWORD_RESET_PEPPER', 'unset: recovery-code hashes fall back to JWT_SECRET. Set an independent value so rotating JWT_SECRET does not invalidate pending recoveries');
const ttl = get('JWT_EXPIRES_IN');
if (!ttl) add('OPTIONAL', 'JWT_EXPIRES_IN', 'unset: default 15m');
else { const match = ttl.match(/^(\d+)([smhd])$/); const seconds = match ? Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2]] : NaN; add(seconds <= 3600 ? 'CORRECT' : 'WARN', 'JWT_EXPIRES_IN', seconds <= 3600 ? 'access tokens live an hour or less' : 'access tokens live longer than an hour; revocation is only checked per request, keep this short'); }
if (!has('ADMIN_EMAIL')) add('MISSING', 'ADMIN_EMAIL', 'required in production');
else add('CORRECT', 'ADMIN_EMAIL', 'set');
const hash = get('ADMIN_PASSWORD_HASH');
if (!hash) add('MISSING', 'ADMIN_PASSWORD_HASH', 'required in production (generate with: npm --prefix backend run hash:admin-password)');
else if (!/^\$2[aby]\$(?:1[2-9]|2\d|3[01])\$[./A-Za-z0-9]{53}$/.test(hash)) add('UNSAFE', 'ADMIN_PASSWORD_HASH', 'not a bcrypt hash with cost 12 or higher (is a plaintext password stored here?)');
else add('CORRECT', 'ADMIN_PASSWORD_HASH', 'bcrypt hash, cost >= 12');

// --- network / HTTPS / CORS / cookies ---------------------------------------------------------------------------
if (!has('PUBLIC_API_URL')) add('MISSING', 'PUBLIC_API_URL', 'required in production (used for signed attachment links)');
else add(isHttps(get('PUBLIC_API_URL')) && !isLocalHost(get('PUBLIC_API_URL')) ? 'CORRECT' : 'UNSAFE', 'PUBLIC_API_URL', isHttps(get('PUBLIC_API_URL')) && !isLocalHost(get('PUBLIC_API_URL')) ? 'public https URL' : 'must be a public https:// URL');
const origins = (get('ALLOWED_ORIGINS') || get('CLIENT_URL')).split(',').map((v) => v.trim()).filter(Boolean);
if (!origins.length) add('MISSING', 'ALLOWED_ORIGINS', 'required: exact https origins of your web app (CLIENT_URL is the fallback)');
else if (origins.some((o) => o === '*' || o.includes('*'))) add('UNSAFE', 'ALLOWED_ORIGINS', 'wildcard origin');
else if (origins.some((o) => !isHttps(o))) add('UNSAFE', 'ALLOWED_ORIGINS', 'contains a non-https origin');
else if (origins.some(isLocalHost)) add('UNSAFE', 'ALLOWED_ORIGINS', 'contains a localhost origin');
else add('CORRECT', 'ALLOWED_ORIGINS', `${origins.length} exact https origin(s), no wildcards`);
if (has('CLIENT_URL')) add(isHttps(get('CLIENT_URL')) && !isLocalHost(get('CLIENT_URL')) ? 'CORRECT' : 'UNSAFE', 'CLIENT_URL', 'must be a public https URL');
const hops = Number(get('TRUST_PROXY_HOPS') || 0);
add(Number.isInteger(hops) && hops >= 1 ? 'CORRECT' : 'UNSAFE', 'TRUST_PROXY_HOPS', Number.isInteger(hops) && hops >= 1 ? `${hops} trusted proxy hop(s): verify it equals the exact number of proxies in front of the API` : '0/unset: behind a load balancer all clients share one IP, which collapses per-IP rate limits and audit logs; also makes req.secure false so every API call is rejected with 426');
add('INFO', 'cookies', 'refresh cookie is HttpOnly + SameSite=Strict + Secure (when NODE_ENV=production) + Path=/api/auth; set by code, no variable');

// --- datastores -------------------------------------------------------------------------------------------------
const mongo = get('MONGODB_URI') || get('MONGO_URI');
if (!mongo) add('MISSING', 'MONGODB_URI', 'required');
else {
  const local = /\/\/(?:[^@/]*@)?(?:localhost|127\.0\.0\.1|\[::1\])[:/]/.test(mongo);
  const creds = /\/\/[^/@]+:[^/@]+@/.test(mongo);
  const tls = mongo.startsWith('mongodb+srv://') || /[?&]tls=true|[?&]ssl=true/.test(mongo);
  if (local) add('UNSAFE', 'MONGODB_URI', 'points at localhost');
  else if (!creds) add('UNSAFE', 'MONGODB_URI', 'no embedded credentials: database authentication appears to be off');
  else add(tls ? 'CORRECT' : 'WARN', 'MONGODB_URI', tls ? 'remote, authenticated, TLS' : 'remote and authenticated, but TLS is not requested (add tls=true unless on a private network)');
  if (!/maxPoolSize=/.test(mongo)) add('INFO', 'MONGODB_URI (pool)', 'maxPoolSize not set: driver default (100 per instance). Size it so instances x pool stays below the database connection limit');
}
if (!has('REDIS_URL')) add('WARN', 'REDIS_URL', 'unset: acceptable ONLY for a single API instance (rate limits and Socket.IO are per-process). Required for 2+ instances');
else if (get('REDIS_URL').startsWith('rediss://')) add('CORRECT', 'REDIS_URL', 'TLS (rediss://)');
else add(isLocalHost(get('REDIS_URL')) ? 'UNSAFE' : 'WARN', 'REDIS_URL', isLocalHost(get('REDIS_URL')) ? 'points at localhost' : 'not TLS (redis://): acceptable only on a private network');
add(get('REDIS_OPTIONAL') === 'true' ? 'WARN' : 'CORRECT', 'REDIS_OPTIONAL', get('REDIS_OPTIONAL') === 'true' ? 'true: the API starts without Redis even if REDIS_URL is set (degraded, single-instance)' : 'startup fails if REDIS_URL is set but Redis is unreachable');

// --- email ------------------------------------------------------------------------------------------------------
add(get('EMAIL_TRANSPORT') === 'file' ? 'UNSAFE' : 'CORRECT', 'EMAIL_TRANSPORT', get('EMAIL_TRANSPORT') === 'file' ? 'file transport writes codes to disk (the server refuses to start with it in production)' : 'smtp');
for (const name of ['SMTP_HOST', 'SMTP_FROM']) add(has(name) ? 'CORRECT' : 'MISSING', name, has(name) ? 'set' : 'required in production');
for (const name of ['SMTP_USER', 'SMTP_PASSWORD']) add(has(name) ? 'CORRECT' : 'WARN', name, has(name) ? 'set' : 'unset: only valid for an unauthenticated internal relay');
if (has('SMTP_PORT')) add(['587', '465', '25'].includes(get('SMTP_PORT')) ? 'CORRECT' : 'WARN', 'SMTP_PORT', 'standard submission port');
if (get('PASSWORD_RECOVERY_MODE') === 'admin') add(isHttps(get('RECOVERY_APPROVAL_URL')) ? 'CORRECT' : 'MISSING', 'RECOVERY_APPROVAL_URL', 'admin recovery mode needs an absolute https approval URL');
else add('OPTIONAL', 'PASSWORD_RECOVERY_MODE', 'email (default): one-time code emailed to the account owner');

// --- file storage -----------------------------------------------------------------------------------------------
add(get('FILE_STORAGE') === 'local' ? 'UNSAFE' : 'CORRECT', 'FILE_STORAGE', get('FILE_STORAGE') === 'local' ? 'local disk storage is for tests only (the server refuses to start with it in production)' : 'cloudinary');
for (const name of ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) add(has(name) ? 'CORRECT' : 'MISSING', name, has(name) ? 'set' : 'required: startup does NOT verify it, so without it every upload fails with 503 at runtime');
const maxMb = Number(get('MAX_FILE_SIZE_MB') || 25);
add(maxMb > 0 && maxMb <= 100 ? 'CORRECT' : 'WARN', 'MAX_FILE_SIZE_MB', `${maxMb} MB per file`);

// --- push -------------------------------------------------------------------------------------------------------
const vapid = ['WEB_PUSH_PUBLIC_KEY', 'WEB_PUSH_PRIVATE_KEY', 'WEB_PUSH_SUBJECT'].filter(has).length;
if (vapid === 0) add('OPTIONAL', 'WEB_PUSH_*', 'unset: browser notifications work only while a tab is open');
else if (vapid < 3) add('UNSAFE', 'WEB_PUSH_*', 'partially configured: set PUBLIC_KEY, PRIVATE_KEY and SUBJECT together or none');
else add(/^(mailto:|https:\/\/)/.test(get('WEB_PUSH_SUBJECT')) ? 'CORRECT' : 'WARN', 'WEB_PUSH_*', 'VAPID keys and subject set (keep the same pair across deployments)');
add(has('EXPO_ACCESS_TOKEN') ? 'CORRECT' : 'OPTIONAL', 'EXPO_ACCESS_TOKEN', has('EXPO_ACCESS_TOKEN') ? 'set (recommended; enables push security in Expo)' : 'unset: Expo push works without it but is not account-secured');

// --- product behaviour ------------------------------------------------------------------------------------------
add(has('GOOGLE_CLIENT_IDS') || has('GOOGLE_WEB_CLIENT_ID') ? 'INFO' : 'CORRECT', 'GOOGLE_CLIENT_IDS', has('GOOGLE_CLIENT_IDS') ? 'set: Google sign-in is ENABLED. Unichat does not require it; unset to keep it off' : 'unset: Google sign-in disabled, as intended');
add(get('AUTO_JOIN_DEFAULT_WORKSPACE') === 'true' ? 'WARN' : 'CORRECT', 'AUTO_JOIN_DEFAULT_WORKSPACE', get('AUTO_JOIN_DEFAULT_WORKSPACE') === 'true' ? 'true: legacy bootstrap; membership must come only from approved join requests' : 'false: no automatic membership');
add(get('REQUIRE_EMAIL_VERIFICATION') === 'false' ? 'INFO' : 'CORRECT', 'REQUIRE_EMAIL_VERIFICATION', get('REQUIRE_EMAIL_VERIFICATION') === 'false' ? 'false, but the server forces verification in production regardless' : 'verification required');
const reuse = Number(get('REFRESH_REUSE_WINDOW_SECONDS') || 30);
add(reuse <= 60 ? 'CORRECT' : 'WARN', 'REFRESH_REUSE_WINDOW_SECONDS', `${reuse}s (0 = strict single-use refresh tokens)`);
for (const name of ['API_RATE_LIMIT_USER', 'API_RATE_LIMIT_IP', 'MESSAGE_SEND_LIMIT_PER_MINUTE', 'UPLOAD_LIMIT_PER_10_MIN', 'MAX_CONCURRENT_UPLOADS']) {
  if (has(name)) add(Number(get(name)) > 0 ? 'CORRECT' : 'UNSAFE', name, Number(get(name)) > 0 ? 'positive number' : 'must be a positive number (0/NaN would disable or break the limit)');
}

// --- report -----------------------------------------------------------------------------------------------------
const order = ['UNSAFE', 'MISSING', 'WARN', 'CORRECT', 'OPTIONAL', 'INFO'];
const width = Math.max(...results.map((r) => r.name.length));
for (const status of order) for (const row of results.filter((r) => r.status === status)) console.log(`${status.padEnd(8)} ${row.name.padEnd(width)}  ${row.note}`);
const count = (status) => results.filter((r) => r.status === status).length;
console.log(`\n${count('CORRECT')} correct, ${count('WARN')} warnings, ${count('UNSAFE')} unsafe, ${count('MISSING')} missing, ${count('OPTIONAL')} optional-unset`);
const blocked = count('UNSAFE') + count('MISSING');
console.log(blocked ? `RESULT: NOT READY (${blocked} blocking item${blocked === 1 ? '' : 's'})` : 'RESULT: configuration passes (review the warnings)');
process.exit(blocked ? 1 : 0);
