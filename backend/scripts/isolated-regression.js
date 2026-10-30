process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.PASSWORD_RECOVERY_MODE = 'admin';
process.env.AUTO_JOIN_DEFAULT_WORKSPACE = 'true';
process.env.WORKSPACE_CREATION = 'admin';
process.env.TRUST_PROXY_HOPS = '1';
// Seeds and tests an isolated local database; never touches the configured app database.
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const dbName = `unichat_regression_${crypto.randomBytes(6).toString('hex')}`;
const uri = `mongodb://127.0.0.1:27017/${dbName}`;
const adminPassword = crypto.randomBytes(20).toString('hex');
const env = { ...process.env, PRESENCE_GRACE_MS: '0', NODE_ENV: 'development', MONGODB_URI: uri, JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'), ADMIN_EMAIL: 'regression-admin@example.test', ADMIN_PASSWORD_HASH: bcrypt.hashSync(adminPassword, 12), SMOKE_ADMIN_EMAIL: 'regression-admin@example.test', SMOKE_ADMIN_PASSWORD: adminPassword };
let serverProcess;
function child(file, options = {}) {
  const proc = spawn(process.execPath, [file, ...(options.args || [])], { cwd: `${__dirname}/..`, env: { ...env, ...options.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (chunk) => { output += chunk; });
  proc.stderr.on('data', (chunk) => { output += chunk; });
  return { proc, output: () => output };
}
function finished(proc) { return new Promise((resolve) => proc.once('exit', (code) => resolve(code))); }
async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return; } catch { /* Not yet listening. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Isolated server did not become healthy');
}
async function run() {
  const port = await freePort();
  // Destructive seed is allowed here only because the database name is freshly generated and local.
  const seeded = child('src/utils/seed.js', { args: ['--confirm-destroy-all-data'], env: { NODE_ENV: 'test' } });
  if (await finished(seeded.proc) !== 0) throw new Error(`Isolated seed failed:\n${seeded.output()}`);
  serverProcess = child('src/index.js', { env: { PORT: String(port), PUBLIC_API_URL: `http://127.0.0.1:${port}/api` } });
  await waitForHealth(port);
  const smoke = child('scripts/smoke.js', { env: { SMOKE_API_URL: `http://127.0.0.1:${port}/api`, SMOKE_SOCKET_URL: `http://127.0.0.1:${port}` } });
  const hardStop = setTimeout(() => { console.error('Smoke timed out after 150s. Output so far:\n' + smoke.output().split('\n').slice(-15).join('\n')); smoke.proc.kill('SIGKILL'); }, 150000);
  const code = await finished(smoke.proc);
  clearTimeout(hardStop);
  if (code !== 0) throw new Error(`Existing regression smoke failed:\n${smoke.output()}\nServer output:\n${serverProcess.output()}`);
  console.log(smoke.output());
  console.log('Isolated Sprint 1-4 regression: PASS');
}
run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (serverProcess) {
    serverProcess.proc.kill();
    await Promise.race([finished(serverProcess.proc), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  if (!/^unichat_regression_[a-f0-9]{12}$/.test(dbName)) throw new Error('Refusing to clean up a non-test database');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  if (mongoose.connection.name !== dbName) throw new Error('Refusing to clean up a non-test database');
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
