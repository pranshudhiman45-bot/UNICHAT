const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const mongoose = require('mongoose');
const { io } = require('../../web/node_modules/socket.io-client');
const children = [], sockets = [];
const dbName = `unichat_redis_test_${crypto.randomBytes(6).toString('hex')}`;
const uri = `mongodb://127.0.0.1:27017/${dbName}`;
let output = '';
async function port() { const listener = net.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); }); const value = listener.address().port; await new Promise((resolve) => listener.close(resolve)); return value; }
function start(command, args, env) { const child = spawn(command, args, { cwd: `${__dirname}/..`, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; }); child.on('error', (error) => { output += error.message; }); return child; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function healthy(base) { for (let count = 0; count < 100; count++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch {} await pause(100); } throw new Error(`Server not ready\n${output}`); }
async function run() {
  const [redisPort, portA, portB] = await Promise.all([port(), port(), port()]);
  start('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], process.env);
  const env = { ...process.env, NODE_ENV: 'development', MONGODB_URI: uri, REDIS_URL: `redis://127.0.0.1:${redisPort}`, JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', AUTO_JOIN_DEFAULT_WORKSPACE: 'false', ALLOWED_REGISTRATION_DOMAIN: '', REQUIRE_EMAIL_VERIFICATION: 'false', WORKSPACE_CREATION: 'members', TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: 'http://localhost:5173' };
  const bases = [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`];
  for (const [index, base] of bases.entries()) start(process.execPath, ['src/index.js'], { ...env, PORT: String(index ? portB : portA), PUBLIC_API_URL: `${base}/api` });
  await Promise.all(bases.map(healthy));
  async function request(index, route, body, token, ip = '203.0.113.1') { const response = await fetch(`${bases[index]}/api${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; }
  const account = await request(0, '/auth/register', { email: 'redis@example.test', username: 'redis_user', displayName: 'Redis User', password: 'Redis test passphrase 42!' });
  assert.equal(account.status, 201, JSON.stringify(account.data));
  const workspace = await request(0, '/workspaces', { name: 'Redis Team' }, account.data.accessToken);
  assert.equal(workspace.status, 201);
  for (const base of bases) {
    const socket = io(base, { transports: ['websocket'], auth: { token: account.data.accessToken } }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    await socket.timeout(3000).emitWithAck('channel:join', workspace.data.channels[0]._id);
  }
  const received = new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('Cross-instance message was not delivered')), 5000); sockets[1].once('message:new', (message) => { clearTimeout(timeout); resolve(message); }); });
  const sent = await request(0, '/messages', { workspaceId: workspace.data.workspace._id, channelId: workspace.data.channels[0]._id, content: 'Across two API instances' }, account.data.accessToken);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal((await received).content, 'Across two API instances');
  for (let count = 0; count < 10; count++) assert.equal((await request(count % 2, '/auth/login', { email: 'missing@example.test', password: 'wrong password' }, null, '203.0.113.99')).status, 401);
  assert.equal((await request(1, '/auth/login', { email: 'missing@example.test', password: 'wrong password' }, null, '203.0.113.99')).status, 429, 'Login rate limit must be shared across instances');
  console.log('PASS: two API instances share rate limits and deliver Socket.IO messages through Redis.');
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  sockets.forEach((socket) => socket.disconnect());
  for (const child of children.reverse()) child.kill('SIGTERM');
  await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(3000).then(() => child.kill('SIGKILL'))])));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.name === dbName) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
