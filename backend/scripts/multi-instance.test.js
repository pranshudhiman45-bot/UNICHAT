const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mongoose = require('mongoose');
const { createClient } = require('redis');
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const dbName = `unichat_multi_${crypto.randomBytes(6).toString('hex')}`; const uri = `mongodb://127.0.0.1:27017/${dbName}`;
const secrets = { JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex') };
const procs = [];
let counter = 0;

async function startRedis(port) {
  procs.push(spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' }));
  for (let i = 0; i < 50; i++) { try { const c = createClient({ url: `redis://127.0.0.1:${port}` }); c.on('error', () => {}); await c.connect(); await c.quit(); return; } catch { await sleep(100); } }
  throw new Error('redis did not start');
}
async function startApi(redisPort) {
  const port = await freePort();
  procs.push(spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: {
    ...process.env, ...secrets, NODE_ENV: 'test', PORT: String(port), MONGODB_URI: uri, REDIS_URL: `redis://127.0.0.1:${redisPort}`, REQUIRE_EMAIL_VERIFICATION: 'false', FILE_STORAGE: 'local',
    EMAIL_TRANSPORT: 'file', TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: 'http://localhost:5173', ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', PRESENCE_GRACE_MS: '2000', PUBLIC_API_URL: `http://127.0.0.1:${port}/api`,
  } }));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) return port; } catch { /* starting */ } await sleep(100); }
  throw new Error('api did not start');
}
const api = (port) => async (route, { method = 'GET', body, token } = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++counter % 250 + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
async function socketTo(port, token) {
  const socket = connect(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const seen = []; socket.onAny((event, payload) => seen.push({ event, payload }));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  await sleep(300);
  return { socket, seen };
}

(async () => {
  const redisPort = await freePort(); await startRedis(redisPort);
  const portA = await startApi(redisPort); const portB = await startApi(redisPort);
  const A = api(portA); const B = api(portB);
  await mongoose.connect(uri);
  const reg = async (name) => (await A('/auth/register', { method: 'POST', body: { email: `${name}@example.test`, username: name, displayName: name, password: 'A memorable test passphrase 42!' } })).body;
  const [u1, u2, u3] = [await reg('one'), await reg('two'), await reg('three')];
  const W = (await A('/workspaces', { method: 'POST', token: u1.accessToken, body: { name: 'Scale' } })).body.workspace;
  const oid = (id) => new mongoose.Types.ObjectId(id);
  await mongoose.connection.collection('workspaces').updateOne({ _id: oid(W._id) }, { $push: { members: { $each: [u2, u3].map((u) => ({ user: oid(u.user._id), role: 'member', joinedAt: new Date() })) } } });
  const priv = (await A('/channels', { method: 'POST', token: u1.accessToken, body: { workspaceId: W._id, name: 'cross', type: 'private', memberIds: [u2.user._id] } })).body.channel;

  const s1 = await socketTo(portA, u1.accessToken);   // user one lives on instance A
  const s2 = await socketTo(portB, u2.accessToken);   // user two lives on instance B
  const s3 = await socketTo(portB, u3.accessToken);   // user three (not in the channel) on B
  const send = (text) => A('/messages', { method: 'POST', token: u1.accessToken, body: { workspaceId: W._id, channelId: priv._id, content: text } });

  // Messages posted via A reach the socket on B, and still not the non-member on B.
  assert.equal((await send('hello across instances')).status, 201); await sleep(500);
  assert.ok(s2.seen.some((e) => e.event === 'message:new' && e.payload.content === 'hello across instances'), 'cross-instance delivery');
  assert.equal(JSON.stringify(s3.seen).includes('hello across instances'), false, 'privacy holds across instances');
  console.log('ok - messages cross instances; non-members on the other instance still receive nothing');

  // Typing is relayed across instances with no per-process state.
  s1.socket.emit('typing:start', { roomType: 'channel', roomId: priv._id }); await sleep(500);
  const typing = s2.seen.find((e) => e.event === 'typing:update');
  assert.ok(typing && typing.payload.userId === u1.user._id && typing.payload.action === 'start', 'typing start relayed A -> B');
  s1.socket.emit('typing:stop', { roomType: 'channel', roomId: priv._id }); await sleep(400);
  assert.ok(s2.seen.some((e) => e.event === 'typing:update' && e.payload.action === 'stop'), 'typing stop relayed');
  s1.socket.emit('typing:start', { roomType: 'channel', roomId: priv._id }); await sleep(1200); s2.seen.length = 0;
  s1.socket.disconnect(); await sleep(600);
  assert.ok(s2.seen.some((e) => e.event === 'typing:update' && e.payload.action === 'stop' && e.payload.userId === u1.user._id), 'a disconnect clears typing on other instances');
  console.log('ok - typing relayed across instances; disconnect clears it');

  // Revocation reaches a socket living on a different instance than the one handling the request.
  s2.seen.length = 0;
  assert.equal((await A(`/channels/${priv._id}/members/${u2.user._id}`, { method: 'DELETE', token: u1.accessToken })).status, 200); await sleep(500);
  await send('after removal'); await sleep(500);
  assert.equal(JSON.stringify(s2.seen).includes('after removal'), false, 'removed user on the OTHER instance stops receiving immediately');
  assert.ok(s2.seen.some((e) => e.event === 'channel:removed'), 'and is told');
  console.log('ok - revocation works across instances');

  // Moving between instances inside the grace window never shows the user offline.
  s2.socket.disconnect(); await sleep(2800); // user two has no other connection now
  const watcher = await socketTo(portB, u3.accessToken);
  const m1 = await socketTo(portA, u2.accessToken); await sleep(300); watcher.seen.length = 0;
  m1.socket.disconnect(); const m2 = await socketTo(portB, u2.accessToken); // reconnects to the other instance at once
  await sleep(3500);
  assert.equal(watcher.seen.filter((e) => e.event === 'user:presence_update' && e.payload.userId === u2.user._id && e.payload.status === 'offline').length, 0, 'no offline flicker when failing over between instances');
  m2.socket.disconnect(); await sleep(3500);
  assert.ok(watcher.seen.some((e) => e.event === 'user:presence_update' && e.payload.userId === u2.user._id && e.payload.status === 'offline'), 'genuinely leaving does go offline');
  [s3, watcher].forEach((s) => s.socket.disconnect());
  console.log('ok - presence stable while failing over between instances');
})().then(() => { console.log('all tests passed'); return finish(0); }).catch((error) => { console.error(error); return finish(1); });

async function finish(code) {
  try { await mongoose.connection.dropDatabase(); } catch { /* none */ }
  procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  process.exit(code);
}
