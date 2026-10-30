const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');

async function run() {
  const blocker = http.createServer((req, res) => res.end('occupied'));
  blocker.listen(0);
  await once(blocker, 'listening');
  const port = blocker.address().port;
  const dbName = `unichat_startup_test_${crypto.randomBytes(8).toString('hex')}`;
  const uri = `mongodb://127.0.0.1:27017/${dbName}`;
  const env = { ...process.env, ENV_FILE: '.env.startup-test-unused', NODE_ENV: 'test', PORT: String(port),
    MONGODB_URI: uri, JWT_SECRET: crypto.randomBytes(40).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(40).toString('hex'),
    ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', REDIS_URL: '', FILE_STORAGE: 'local', EMAIL_TRANSPORT: 'file' };
  let child;
  const launch = () => {
    child = spawn(process.execPath, ['src/index.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    return { exited: once(child, 'exit'), output: () => output };
  };
  const deadline = setTimeout(() => { child?.kill('SIGKILL'); }, 20000);
  try {
    const duplicate = launch();
    const [code] = await duplicate.exited;
    assert.equal(code, 1, duplicate.output());
    assert.match(duplicate.output(), /port .* is already in use/);
    assert.doesNotMatch(duplicate.output(), /Unhandled 'error' event/);
    assert.equal(await (await fetch(`http://localhost:${port}`)).text(), 'occupied');
    await new Promise(resolve => blocker.close(resolve));
    const normal = launch();
    for (let attempt = 0; attempt < 100 && !normal.output().includes('Socket.IO server ready'); attempt++) {
      if (child.exitCode !== null) throw new Error(normal.output());
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const health = await fetch(`http://localhost:${port}/health`);
    assert.equal(health.status, 200, normal.output());
    child.kill('SIGTERM');
    const [normalCode] = await normal.exited;
    assert.equal(normalCode, 0, normal.output());
    console.log('PASS: duplicate port exits cleanly, occupied server is preserved, normal startup and graceful shutdown succeed.');
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null) child.kill('SIGKILL');
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    await mongoose.connect(uri);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
