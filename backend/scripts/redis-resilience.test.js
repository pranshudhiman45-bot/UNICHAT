const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createClient } = require('redis');

function freePort() { return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); }); }
(async () => {
  const redisPort = await freePort();
  let redisProc;
  const startRedis = async () => {
    redisProc = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) { try { const c = createClient({ url: `redis://127.0.0.1:${redisPort}` }); c.on('error', () => {}); await c.connect(); await c.quit(); return; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    throw new Error('redis-server did not start');
  };
  const stopRedis = () => new Promise((resolve) => { redisProc.once('exit', resolve); redisProc.kill('SIGKILL'); });
  await startRedis();
  process.on('exit', () => { try { redisProc.kill('SIGKILL'); } catch { /* already gone */ } });

  const { boot, assert } = require('./lib/harness');
  const t = boot({ REDIS_URL: `redis://127.0.0.1:${redisPort}`, PRESENCE_GRACE_MS: '0' });
  const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

  t.main(async ({ call, ok, register, sleep, port }) => {
    const inspector = createClient({ url: `redis://127.0.0.1:${redisPort}` }); inspector.on('error', () => {}); await inspector.connect();
    const raw = async (route) => { const r = await fetch(`http://127.0.0.1:${port}${route}`); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const health = async () => (await raw('/health')).body;
    const waitFor = async (check, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await sleep(250); } throw new Error(`Timed out waiting for ${label}`); };

    const alice = await register('alice'); const bob = await register('bob');
    assert.equal((await health()).status, 'ok'); assert.equal((await health()).checks.redis, 'ready');
    const login = (ip, password = 'wrong wrong wrong') => call('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: { email: 'alice@example.test', password } });

    // 1. Healthy: the shared Redis store enforces the login limit (10 / 15 min).
    const statuses = []; for (let i = 0; i < 12; i++) statuses.push((await login('198.51.100.50')).status);
    assert.deepEqual(statuses.slice(0, 10).every((s) => s === 401), true); assert.equal(statuses[10], 429);
    assert.ok((await inspector.keys('unichat:limit:login:*')).length > 0, 'counters live in Redis while it is up');
    console.log('ok - shared rate limit enforced through Redis');

    // 2. A live socket exists before the outage.
    const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: bob.token }, transports: ['websocket'], reconnection: true, forceNew: true });
    const seen = []; socket.on('message:new', (m) => seen.push(m.content));
    await new Promise((resolve) => socket.once('connect', resolve)); await sleep(300);
    const W = ok(await call('/workspaces', { method: 'POST', token: alice.token, body: { name: 'Resilient' } }), 201).workspace;
    const Workspace = require('../src/models/Workspace'); const Channel = require('../src/models/Channel');
    await Workspace.updateOne({ _id: W._id }, { $push: { members: { user: bob.id, role: 'member' } } });
    const general = ok(await call(`/channels/workspace/${W._id}`, { token: alice.token })).channels.find((c) => c.name === 'general');
    await Channel.updateOne({ _id: general._id }, { $push: { members: { user: bob.id, role: 'member' } } });
    await socket.disconnect().connect(); await sleep(500);

    // 3. Redis dies hard.
    await stopRedis();
    await waitFor(async () => (await health()).status === 'degraded', 'degraded health');
    const degraded = await raw('/health');
    assert.equal(degraded.status, 200, 'readiness stays 200 so the load balancer keeps the instance'); assert.equal(degraded.body.checks.redis, 'unavailable'); assert.equal(degraded.body.checks.database, 'ready');
    const live = await raw('/health/live'); assert.equal(live.status, 200);
    // Ordinary API traffic keeps working...
    const start = Date.now();
    ok(await call('/auth/me', { token: alice.token }));
    ok(await call('/messages', { method: 'POST', token: alice.token, body: { workspaceId: W._id, channelId: general._id, content: 'during-outage' } }), 201);
    assert.ok(Date.now() - start < 3000, 'requests are not stalled waiting for Redis');
    await sleep(500);
    assert.ok(seen.includes('during-outage'), 'same-instance realtime delivery continues during the outage');
    // ...and security limits are still enforced (per-instance), not silently disabled.
    const degradedStatuses = []; for (let i = 0; i < 12; i++) degradedStatuses.push((await login('198.51.100.77')).status);
    assert.equal(degradedStatuses.slice(0, 10).every((s) => s === 401), true, JSON.stringify(degradedStatuses)); assert.equal(degradedStatuses[10], 429, 'login brute-force limit still enforced without Redis');
    console.log('ok - outage: API stays up, realtime works, limits fall back to per-instance enforcement');

    // 4. Redis returns: automatic recovery, shared limiting resumes.
    await startRedis();
    await waitFor(async () => (await health()).status === 'ok', 'automatic recovery', 40000);
    const recovered = await health(); assert.equal(recovered.redis.status, 'ready'); assert.ok(recovered.redis.outages >= 1);
    await inspector.quit().catch(() => {});
    const inspector2 = createClient({ url: `redis://127.0.0.1:${redisPort}` }); inspector2.on('error', () => {}); await inspector2.connect();
    const before = (await inspector2.keys('unichat:limit:login:*')).length;
    await login('198.51.100.99');
    assert.ok((await inspector2.keys('unichat:limit:login:*')).length > before, 'limiter is using Redis again after recovery');
    ok(await call('/messages', { method: 'POST', token: alice.token, body: { workspaceId: W._id, channelId: general._id, content: 'after-recovery' } }), 201);
    await sleep(500); assert.ok(seen.includes('after-recovery'));
    await inspector2.quit();
    socket.disconnect();
    console.log('ok - automatic recovery; shared limits and delivery resume without a restart');
  });
})();
