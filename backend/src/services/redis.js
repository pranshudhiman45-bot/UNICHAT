const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const { RedisStore } = require('rate-limit-redis');
const rateLimit = require('express-rate-limit');

// Redis provides two optional capabilities: shared rate-limit counters and Socket.IO fan-out across
// instances. The API must keep working when it is unavailable, so every use degrades instead of failing:
//   * rate limits fall back to a per-instance in-memory limiter with the SAME limits (never "unlimited"),
//   * the client reconnects forever with capped exponential backoff and recovers automatically,
//   * /health reports "degraded" rather than failing, so a load balancer does not drain every instance.
const STARTUP_WAIT_MS = Number(process.env.REDIS_STARTUP_WAIT_MS || 10000);
const MAX_BACKOFF_MS = 10000;

const client = process.env.REDIS_URL ? createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: (retries) => Math.min(250 * 2 ** Math.min(retries, 6), MAX_BACKOFF_MS) + Math.floor(Math.random() * 250),
  },
}) : null;
let subscriber;
let markConnected;
const connected = new Promise((resolve) => { markConnected = resolve; });

const state = { status: client ? 'connecting' : 'disabled', since: Date.now(), lastError: null, outages: 0, fallbackRequests: 0 };
let lastErrorLog = 0;
function transition(status) {
  if (state.status === status) return;
  const downFor = Math.round((Date.now() - state.since) / 1000);
  if (status === 'ready') console.log(state.outages ? `Redis recovered after ${downFor}s` : 'Redis connected');
  else if (state.status === 'ready') { state.outages++; console.warn('Redis connection lost; running in degraded mode (per-instance rate limits, no cross-instance fan-out)'); }
  state.status = status;
  state.since = Date.now();
}
function wire(connection, label, drivesStatus = true) {
  if (drivesStatus) { // only the main client defines health; the pub/sub duplicate just logs
    connection.on('ready', () => { state.lastError = null; transition('ready'); });
    connection.on('reconnecting', () => transition('reconnecting'));
    connection.on('end', () => transition('down'));
  }
  connection.on('error', (error) => {
    state.lastError = error.code || error.message;
    // Errors repeat on every retry: log at most once every 30 seconds, and never the connection URL.
    if (Date.now() - lastErrorLog > 30000) { lastErrorLog = Date.now(); console.error(`Redis ${label} unavailable (${state.lastError}); retrying`); }
  });
}
if (client) wire(client, 'client');

const redisReady = () => !client || client.isReady;

function limiter(name, options) {
  // Local fallback with identical limits. Counts are per instance, so it is looser across several
  // instances than the shared store, but it is always enforced.
  const local = rateLimit({ ...options });
  if (!client) return local;
  const shared = rateLimit({
    ...options,
    store: new RedisStore({
      prefix: `unichat:limit:${name}:`,
      sendCommand: async (...args) => {
        await connected; // rate-limit-redis loads its Lua scripts at construction; wait for the first connection
        if (!client.isReady) throw new Error('Redis unavailable');
        return client.sendCommand(args);
      },
    }),
  });
  return (req, res, next) => {
    const fallback = () => { state.fallbackRequests++; return local(req, res, next); };
    if (!client.isReady) return fallback();
    return shared(req, res, (error) => (error ? fallback() : next()));
  };
}

async function connectRedis(io) {
  if (!client) return;
  client.connect().catch((error) => console.error(`Redis connect failed: ${error.code || error.message}`));
  await Promise.race([connected.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), STARTUP_WAIT_MS))]);
  if (!client.isReady) {
    // Multi-instance correctness depends on the shared adapter, so production refuses to start without it.
    // Everywhere else we start degraded; the client keeps retrying in the background.
    if (process.env.NODE_ENV === 'production' && process.env.REDIS_OPTIONAL !== 'true') {
      throw new Error('REDIS_URL is configured but Redis is unreachable. Fix Redis or set REDIS_OPTIONAL=true to start in degraded single-instance mode.');
    }
    console.warn('Redis unreachable at startup; starting degraded (rate limits are per instance, Socket.IO is single-instance)');
    return;
  }
  markConnected();
  subscriber = client.duplicate();
  wire(subscriber, 'subscriber', false);
  await subscriber.connect();
  io.adapter(createAdapter(client, subscriber));
}
// markConnected must also fire when Redis becomes ready after a degraded start.
client?.once('ready', () => markConnected());

async function closeRedis() {
  await Promise.all([client, subscriber].filter((connection) => connection?.isOpen).map((connection) => connection.quit().catch(() => connection.disconnect())));
}

const redisStatus = () => ({ status: state.status, since: new Date(state.since).toISOString(), lastError: state.lastError, outages: state.outages, fallbackRequests: state.fallbackRequests });
module.exports = { limiter, connectRedis, closeRedis, redisReady, redisStatus };
