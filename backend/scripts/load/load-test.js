#!/usr/bin/env node
// Load/soak test for the API + Socket.IO. Spawns its own server against a THROWAWAY database, seeds users directly
// (no registration/bcrypt cost), opens real WebSocket clients and drives a realistic mix of traffic.
//
//   node scripts/load/load-test.js --users 100 --seconds 30
//   node scripts/load/load-test.js --users 500 --seconds 60 --redis            # also run a local redis-server
//   node scripts/load/load-test.js --users 200 --real-limits                    # keep production rate limits ON
//
// IMPORTANT: client and server share this machine, so numbers are a LOWER BOUND for the server and say nothing
// about your production hardware. Use the same script against a staging environment (--url) for real capacity numbers.
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { io: connect } = require(path.resolve(__dirname, '../../../web/node_modules/socket.io-client'));

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const USERS = Number(arg('users', 100)); const SECONDS = Number(arg('seconds', 30)); const USE_REDIS = Boolean(arg('redis', false)); const REAL_LIMITS = Boolean(arg('real-limits', false));
const CHANNELS = Math.max(5, Math.round(USERS / 25)); const MONGO = 'mongodb://127.0.0.1:27017'; const dbName = `unichat_load_${crypto.randomBytes(4).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const secrets = { JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex') };
const procs = [];
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
const ps = (pid) => { try { const [rss, cpu] = execFileSync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)]).toString().trim().split(/\s+/).map(Number); return { rssMb: rss / 1024, cpu }; } catch { return null; } };
const metrics = { ops: new Map(), errors: new Map(), delivery: [], reconnect: [], sockets: { connected: 0, failed: 0, dropped: 0 } };
const record = (op, ms, status) => { if (!metrics.ops.has(op)) metrics.ops.set(op, []); metrics.ops.get(op).push(ms); if (!(status >= 200 && status < 300)) { const k = `${op} ${status}`; metrics.errors.set(k, (metrics.errors.get(k) || 0) + 1); } };

(async () => {
  let redisPort; let redisProc;
  if (USE_REDIS) {
    redisPort = await freePort(); redisProc = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }); procs.push(redisProc); await sleep(600);
  }
  const apiPort = await freePort();
  const limitEnv = REAL_LIMITS ? {} : { API_RATE_LIMIT_USER: '1000000000', API_RATE_LIMIT_IP: '1000000000', MESSAGE_SEND_LIMIT_PER_MINUTE: '1000000000', UPLOAD_LIMIT_PER_10_MIN: '1000000000' };
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(apiPort), MONGODB_URI: `${MONGO}/${dbName}`, ...secrets, REQUIRE_EMAIL_VERIFICATION: 'false', FILE_STORAGE: 'local', LOCAL_UPLOAD_DIR: `/tmp/${dbName}-uploads`, EMAIL_TRANSPORT: 'file', DEV_EMAIL_DIR: `/tmp/${dbName}-mail`,
    TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: 'http://localhost:5173', ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', PUBLIC_API_URL: `http://127.0.0.1:${apiPort}/api`, ...(USE_REDIS ? { REDIS_URL: `redis://127.0.0.1:${redisPort}` } : {}), ...limitEnv,
  } });
  procs.push(server);
  let serverLog = ''; server.stdout.on('data', (c) => { serverLog += c; }); server.stderr.on('data', (c) => { serverLog += c; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${apiPort}/health/live`)).ok) break; } catch { /* starting */ } await sleep(100); }
  const base = `http://127.0.0.1:${apiPort}/api`;

  // ---- seed ---------------------------------------------------------------------------------------------------------
  await mongoose.connect(`${MONGO}/${dbName}`);
  const db = mongoose.connection.db; const oid = () => new mongoose.Types.ObjectId();
  const users = Array.from({ length: USERS }, (_, i) => { const sessionId = crypto.randomUUID(); const _id = oid(); return { _id, sessionId, i, doc: { _id, username: `load${i}`, email: `load${i}@example.test`, password: 'x'.repeat(60), displayName: `Load User ${i}`, role: 'USER', accountStatus: 'active', sessionVersion: 0, status: 'offline', refreshSessions: [{ sessionId, tokenHash: crypto.randomBytes(32).toString('hex'), createdAt: new Date() }], workspaces: [], createdAt: new Date(), updatedAt: new Date() }, token: jwt.sign({ userId: String(_id), sid: sessionId, ver: 0, role: 'USER' }, secrets.JWT_SECRET, { expiresIn: '3h' }) }; });
  const extra = Array.from({ length: Math.min(60, Math.max(10, USERS / 5)) }, (_, i) => { const sessionId = crypto.randomUUID(); const _id = oid(); return { _id, doc: { _id, username: `joiner${i}`, email: `joiner${i}@example.test`, password: 'x'.repeat(60), displayName: `Joiner ${i}`, role: 'USER', accountStatus: 'active', sessionVersion: 0, status: 'offline', refreshSessions: [{ sessionId, tokenHash: 'h'.repeat(64), createdAt: new Date() }], workspaces: [], createdAt: new Date(), updatedAt: new Date() }, token: jwt.sign({ userId: String(_id), sid: sessionId, ver: 0, role: 'USER' }, secrets.JWT_SECRET, { expiresIn: '3h' }) }; });
  await db.collection('users').insertMany([...users, ...extra].map((u) => u.doc));
  const wsId = oid(); const inviteCode = crypto.randomBytes(8).toString('hex').toUpperCase();
  await db.collection('workspaces').insertOne({ _id: wsId, name: 'Load Test Org', slug: `load-${dbName.slice(-6)}`, description: '', owner: users[0]._id, inviteCode, plan: 'free', members: users.map((u, i) => ({ user: u._id, role: i === 0 ? 'owner' : 'member', joinedAt: new Date() })), joinRequests: [], settings: { defaultChannels: [], allowGuestAccess: false, messageRetentionDays: 0 }, isArchived: false, deletedAt: null, createdAt: new Date(), updatedAt: new Date() });
  const channelDocs = Array.from({ length: CHANNELS }, (_, c) => { const everyone = c === 0; const members = users.filter(() => everyone || Math.random() < 0.2); return { _id: oid(), workspace: wsId, name: everyone ? 'general' : `chan-${c}`, description: '', type: 'public', createdBy: users[0]._id, isDefault: everyone, isArchived: false, topic: '', lastActivity: new Date(), messageCount: 0, pinnedMessages: [], members: members.map((u) => ({ user: u._id, role: 'member', lastRead: new Date(Date.now() - 3600e3), notificationLevel: 'all', joinedAt: new Date() })), createdAt: new Date(), updatedAt: new Date() }; });
  await db.collection('channels').insertMany(channelDocs);
  const seedMessages = []; for (const ch of channelDocs) for (let k = 0; k < 60; k++) seedMessages.push({ workspace: wsId, channel: ch._id, sender: pick(ch.members).user, content: `seed ${k}`, isDeleted: false, attachments: [], reactions: [], mentions: [], thread: { parentMessage: null, replyCount: 0, participants: [] }, createdAt: new Date(Date.now() - (60 - k) * 60e3), updatedAt: new Date(Date.now() - (60 - k) * 60e3) });
  await db.collection('messages').insertMany(seedMessages);
  const chanIdsOf = new Map(users.map((u) => [String(u._id), channelDocs.filter((c) => c.members.some((m) => String(m.user) === String(u._id))).map((c) => String(c._id))]));
  console.log(`seeded: ${USERS} users, ${CHANNELS} channels, ${seedMessages.length} messages  (db ${dbName}${REAL_LIMITS ? ', REAL rate limits' : ', rate limits lifted'}${USE_REDIS ? ', with Redis' : ''})`);
  const mongoStats = async () => { const s = await db.admin().serverStatus(); return { ...s.opcounters, connections: s.connections.current, residentMb: s.mem?.resident }; };
  const mongoBefore = await mongoStats();

  // ---- sampling ---------------------------------------------------------------------------------------------------------
  const samples = { node: [], mongod: [], redis: [], nodeClient: [] };
  let mongodPid; try { mongodPid = Number(execFileSync('pgrep', ['-x', 'mongod']).toString().trim().split('\n')[0]); } catch { /* not found */ }
  const sampler = setInterval(() => { const a = ps(server.pid); if (a) samples.node.push(a); const b = mongodPid && ps(mongodPid); if (b) samples.mongod.push(b); if (redisProc) { const c = ps(redisProc.pid); if (c) samples.redis.push(c); } const d = ps(process.pid); if (d) samples.nodeClient.push(d); }, 1000);

  // ---- clients ---------------------------------------------------------------------------------------------------------
  const pendingDelivery = new Map(); // clientMessageId -> sentAt
  const api = async (op, user, method, route, body) => {
    const start = performance.now(); let status = 0;
    try { const r = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${user.token}`, 'x-forwarded-for': `10.${user.i % 250}.${rand(250)}.${rand(250)}` }, body: body && JSON.stringify(body) }); status = r.status; await r.arrayBuffer(); }
    catch { status = 'network'; }
    record(op, performance.now() - start, status); return status;
  };
  const clients = [];
  const openSocket = (user) => new Promise((resolve) => {
    const started = performance.now(); const socket = connect(`http://127.0.0.1:${apiPort}`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true });
    socket.on('message:new', (m) => { const sent = m.clientMessageId && pendingDelivery.get(m.clientMessageId); if (sent && m.sender?._id !== String(user._id)) metrics.delivery.push(performance.now() - sent); });
    socket.once('connect', () => { metrics.sockets.connected++; record('socket connect', performance.now() - started, 200); resolve(socket); });
    socket.once('connect_error', () => { metrics.sockets.failed++; record('socket connect', performance.now() - started, 'error'); resolve(null); });
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') metrics.sockets.dropped++; });
  });
  let running = true;
  const behave = async (client) => {
    const { user } = client;
    while (running) {
      await sleep(1500 + rand(3000)); if (!running) break;
      const roll = Math.random(); const chans = chanIdsOf.get(String(user._id)); const channelId = pick(chans);
      if (roll < 0.55) {
        const id = `ld_${crypto.randomBytes(9).toString('hex')}`; pendingDelivery.set(id, performance.now());
        await api('send message', user, 'POST', '/messages', { workspaceId: String(wsId), channelId, content: `load ${id}`, clientMessageId: id });
        setTimeout(() => pendingDelivery.delete(id), 15000);
      } else if (roll < 0.75) await api('message history', user, 'GET', `/messages/channel/${channelId}?limit=50`);
      else if (roll < 0.85) await api('channel list + unread', user, 'GET', `/channels/workspace/${wsId}`);
      else if (roll < 0.92) { const h = await fetch(`${base}/messages/channel/${channelId}?limit=1`, { headers: { authorization: `Bearer ${user.token}`, 'x-forwarded-for': '10.0.0.1' } }).then((r) => r.json()).catch(() => null); const target = h?.messages?.[0]?._id; if (target) await api('react', user, 'POST', `/messages/${target}/react`, { emoji: pick(['👍', '🎉', '❤️', '👀']) }); }
      else if (roll < 0.97) await api('notifications unread-count', user, 'GET', `/notifications/unread-count?scope=activity&workspaceId=${wsId}`);
      else await api('mark read', user, 'PUT', `/channels/${channelId}/mark-read`);
    }
  };

  const t0 = performance.now();
  for (let i = 0; i < users.length; i += 50) { await Promise.all(users.slice(i, i + 50).map(async (user) => { const socket = await openSocket(user); if (socket) { const client = { user, socket }; clients.push(client); void behave(client); } })); await sleep(150); }
  console.log(`ramp complete in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${metrics.sockets.connected} sockets connected, ${metrics.sockets.failed} failed`);

  const phase = async (label, fraction, fn) => { await sleep(SECONDS * 1000 * fraction); console.log(`  [t+${((performance.now() - t0) / 1000).toFixed(0)}s] ${label}`); await fn(); };
  const steadyStart = performance.now();
  await Promise.all([
    phase('reconnect storm: 20% of sockets drop and reconnect together + catch-up sync', 0.45, async () => {
      const victims = clients.slice(0, Math.max(5, Math.floor(clients.length * 0.2)));
      victims.forEach((c) => c.socket.disconnect());
      await Promise.all(victims.map(async (c) => { const start = performance.now(); const s = await openSocket(c.user); if (s) { c.socket = s; metrics.reconnect.push(performance.now() - start); await api('reconnect sync', c.user, 'GET', `/messages/channel/${pick(chanIdsOf.get(String(c.user._id)))}/sync?since=${encodeURIComponent(new Date(Date.now() - 20000).toISOString())}`); } }));
    }),
    phase('join-request burst: new users submit the code at once, owner approves', 0.65, async () => {
      await Promise.all(extra.map((u, i) => api('join request', { ...u, i }, 'POST', `/workspaces/join/${inviteCode}`)));
      const list = await fetch(`${base}/workspaces/${wsId}/join-requests`, { headers: { authorization: `Bearer ${users[0].token}`, 'x-forwarded-for': '10.0.0.2' } }).then((r) => r.json()).catch(() => ({ requests: [] }));
      await Promise.all((list.requests || []).map((r) => api('approve join request', users[0], 'POST', `/workspaces/${wsId}/join-requests/${r._id}/approve`)));
    }),
    phase('upload burst: 10 simultaneous 1 MB uploads', 0.8, async () => {
      const general = String(channelDocs[0]._id);
      await Promise.all(Array.from({ length: 10 }, async (_, k) => { const user = users[k + 1]; const form = new FormData(); form.append('workspaceId', String(wsId)); form.append('channelId', general); form.append('files', new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(1024 * 1024)])], { type: 'application/pdf' }), 'load.pdf'); const start = performance.now(); let status = 0; try { const r = await fetch(`${base}/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${user.token}`, 'x-forwarded-for': `10.9.${k}.1` }, body: form }); status = r.status; await r.arrayBuffer(); } catch { status = 'network'; } record('file upload 1MB', performance.now() - start, status); }));
    }),
    sleep(SECONDS * 1000),
  ]);
  running = false; await sleep(1500);
  const steadySeconds = (performance.now() - steadyStart) / 1000;
  clearInterval(sampler);
  const mongoAfter = await mongoStats();
  const connectedAtEnd = clients.filter((c) => c.socket.connected).length;

  // ---- report ---------------------------------------------------------------------------------------------------------
  const total = [...metrics.ops.values()].reduce((a, v) => a + v.length, 0); const failed = [...metrics.errors.values()].reduce((a, v) => a + v, 0);
  console.log(`\n=== RESULTS: ${USERS} concurrent users, ${SECONDS}s steady state (${total} HTTP/socket operations, ${(total / steadySeconds).toFixed(0)}/s) ===`);
  console.log('operation'.padEnd(28) + 'count'.padStart(7) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + 'max'.padStart(9) + '   (ms)');
  for (const [op, xs] of [...metrics.ops.entries()].sort()) console.log(op.padEnd(28) + String(xs.length).padStart(7) + pct(xs, 0.5).toFixed(0).padStart(9) + pct(xs, 0.95).toFixed(0).padStart(9) + pct(xs, 0.99).toFixed(0).padStart(9) + Math.max(...xs).toFixed(0).padStart(9));
  console.log(`message delivery latency (send -> other user's socket): n=${metrics.delivery.length}  p50=${pct(metrics.delivery, 0.5).toFixed(0)}ms  p95=${pct(metrics.delivery, 0.95).toFixed(0)}ms  p99=${pct(metrics.delivery, 0.99).toFixed(0)}ms`);
  console.log(`socket reconnect after drop: n=${metrics.reconnect.length}  p50=${pct(metrics.reconnect, 0.5).toFixed(0)}ms  p95=${pct(metrics.reconnect, 0.95).toFixed(0)}ms`);
  console.log(`error rate: ${failed}/${total} = ${((failed / Math.max(1, total)) * 100).toFixed(2)}%   ${[...metrics.errors.entries()].map(([k, v]) => `${k}:${v}`).join('  ') || '(none)'}`);
  console.log(`sockets: ${metrics.sockets.connected} connected, ${metrics.sockets.failed} failed to connect, ${metrics.sockets.dropped} unexpected drops, ${connectedAtEnd}/${clients.length} still connected at end`);
  const stat = (xs, key) => (xs.length ? `avg ${(xs.reduce((a, v) => a + v[key], 0) / xs.length).toFixed(0)} / peak ${Math.max(...xs.map((v) => v[key])).toFixed(0)}` : 'n/a');
  console.log(`API node process:   RSS MB ${stat(samples.node, 'rssMb')}   CPU% ${stat(samples.node, 'cpu')}  (100% = one core)`);
  console.log(`mongod process:     RSS MB ${stat(samples.mongod, 'rssMb')}   CPU% ${stat(samples.mongod, 'cpu')}`);
  if (samples.redis.length) console.log(`redis-server:       RSS MB ${stat(samples.redis, 'rssMb')}   CPU% ${stat(samples.redis, 'cpu')}`);
  console.log(`load generator:     RSS MB ${stat(samples.nodeClient, 'rssMb')}   CPU% ${stat(samples.nodeClient, 'cpu')}  (if this is near 100% the generator, not the server, is the limit)`);
  const dOps = (k) => mongoAfter[k] - mongoBefore[k];
  console.log(`MongoDB ops during run: query ${dOps('query')}, insert ${dOps('insert')}, update ${dOps('update')}, command ${dOps('command')}, getmore ${dOps('getmore')}  (~${((dOps('query') + dOps('insert') + dOps('update') + dOps('command')) / steadySeconds).toFixed(0)} ops/s); connections ${mongoAfter.connections}`);
  console.log(`server log: ${serverLog.split('\n').filter((l) => /error|Unhandled|failed/i.test(l)).length} error-ish lines`);
  // slowest operation by p95 = first bottleneck candidate
  const slowest = [...metrics.ops.entries()].filter(([, xs]) => xs.length >= 5).sort((a, b) => pct(b[1], 0.95) - pct(a[1], 0.95))[0];
  if (slowest) console.log(`SLOWEST p95: "${slowest[0]}" at ${pct(slowest[1], 0.95).toFixed(0)} ms`);
  clients.forEach((c) => c.socket.disconnect());
  await cleanup(0);
})().catch(async (e) => { console.error(e); await cleanup(1); });

async function cleanup(code) {
  try { await mongoose.connection.dropDatabase(); } catch { /* none */ }
  procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  require('node:fs').rmSync(`/tmp/${dbName}-uploads`, { recursive: true, force: true }); require('node:fs').rmSync(`/tmp/${dbName}-mail`, { recursive: true, force: true });
  process.exit(code);
}
