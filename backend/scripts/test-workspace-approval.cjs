const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const root = path.resolve(__dirname, '../..');
const suite = process.argv[2] || 'workspace-approval.spec.ts';
if (!['workspace-approval.spec.ts', 'activity.spec.ts'].includes(suite)) throw Error('Unknown browser suite');
const dbName = `unichat_join_browser_${crypto.randomBytes(8).toString('hex')}`;
const uri = `mongodb://127.0.0.1:27017/${dbName}`;
const children = [];
async function freePort() { const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function launch(args, cwd, env) { const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; }); const exited = once(child, 'exit'); children.push({ child, exited }); return { child, exited, output: () => output }; }
async function ready(url, process) { for (let i = 0; i < 100; i++) { if (process.child.exitCode !== null) throw Error(process.output()); try { if ((await fetch(url)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw Error(`Server unavailable: ${process.output()}`); }
(async () => {
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const apiUrl = `http://127.0.0.1:${apiPort}`; const webUrl = `http://127.0.0.1:${webPort}`;
  const backend = launch(['src/index.js'], path.join(root, 'backend'), { ENV_FILE: '.unused-approval-test', NODE_ENV: 'development', PORT: String(apiPort), MONGODB_URI: uri, JWT_SECRET: crypto.randomBytes(40).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(40).toString('hex'), ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', REQUIRE_EMAIL_VERIFICATION: 'false', ALLOWED_REGISTRATION_DOMAIN: '', AUTO_JOIN_DEFAULT_WORKSPACE: 'false', WORKSPACE_CREATION: 'members', REDIS_URL: '', PUBLIC_API_URL: `${apiUrl}/api`, ALLOWED_ORIGINS: webUrl, FILE_STORAGE: 'local', EMAIL_TRANSPORT: 'file' });
  await ready(`${apiUrl}/health`, backend);
  const web = launch(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], path.join(root, 'web'), { VITE_API_URL: `${apiUrl}/api`, VITE_SOCKET_URL: apiUrl });
  await ready(webUrl, web);
  const test = launch(['node_modules/@playwright/test/cli.js', 'test', '--config', 'web/playwright.config.ts', suite], root, { PLAYWRIGHT_BASE_URL: webUrl, APPROVAL_TEST_API: `${apiUrl}/api` });
  const [code] = await test.exited; console.log(test.output());
  if (code !== 0) throw Error(`Workspace browser test failed\n${backend.output()}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(({ exited }) => exited));
  if (!/^unichat_join_browser_[a-f0-9]{16}$/.test(dbName)) throw Error('Unexpected test database');
  await mongoose.connect(uri); await mongoose.connection.dropDatabase(); await mongoose.disconnect();
});
