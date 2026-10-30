const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const mongoose = require('mongoose');

const dbName = `unichat_upload_test_${crypto.randomBytes(6).toString('hex')}`;
const uri = `mongodb://127.0.0.1:27017/${dbName}`;
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unichat-store-'));
const TMP = path.join(os.tmpdir(), 'unichat-uploads');
const MAX_MB = 20; const MAX_FILES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const tmpFiles = () => (fs.existsSync(TMP) ? fs.readdirSync(TMP).length : 0);

let server; let port; let counter = 0;
const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)]).toString().trim()) / 1024; // MB
async function api(route, { method = 'GET', body, token } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++counter % 250 + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Streams a multipart/form-data body generated on the fly (the client never holds the payload in memory).
function upload({ token, fields, files, chunkDelayMs = 0, declareLength = true }) {
  return new Promise((resolve, reject) => {
    const boundary = `----t${crypto.randomBytes(8).toString('hex')}`;
    const head = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const fileHead = (f) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: ${f.type}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const parts = [...Object.entries(fields).map(([k, v]) => head(k, v).length)].reduce((a, b) => a + b, 0)
      + files.reduce((a, f) => a + fileHead(f).length + f.size + 2, 0) + tail.length - 2;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/files/upload', method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-forwarded-for': `198.51.100.${++counter % 250 + 1}`,
      ...(declareLength ? { 'content-length': parts + files.length * 0 } : {}),
    } }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : {} })); });
    req.on('error', (error) => { if (error.code === 'EPIPE' || error.code === 'ECONNRESET') return; reject(error); });
    (async () => {
      for (const [k, v] of Object.entries(fields)) req.write(head(k, v));
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        req.write(fileHead(f));
        let remaining = f.size; let first = true;
        while (remaining > 0 && !req.destroyed) {
          const size = Math.min(remaining, 256 * 1024);
          const chunk = Buffer.alloc(size, 7);
          if (first && f.magic) { f.magic.copy(chunk); first = false; }
          remaining -= size;
          if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
          if (chunkDelayMs) await sleep(chunkDelayMs);
        }
        req.write(i === files.length - 1 ? tail.subarray(0, 0) : Buffer.from('\r\n'));
      }
      req.end(tail.subarray(0));
    })().catch(reject);
  });
}
const PDF = Buffer.from('%PDF-1.4\n'); const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

(async () => {
  port = await freePort();
  server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env: {
    ...process.env, NODE_ENV: 'test', PORT: String(port), MONGODB_URI: uri, JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
    REQUIRE_EMAIL_VERIFICATION: 'false', FILE_STORAGE: 'local', LOCAL_UPLOAD_DIR: uploadsDir, EMAIL_TRANSPORT: 'file', TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: 'http://localhost:5173',
    ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', REDIS_URL: '', MAX_FILE_SIZE_MB: String(MAX_MB), MAX_ATTACHMENTS: String(MAX_FILES), MAX_CONCURRENT_UPLOADS: '2', PUBLIC_API_URL: `http://127.0.0.1:${port}/api`,
  }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) break; } catch { /* starting */ } await sleep(100); }

  const user = async (name) => (await api('/auth/register', { method: 'POST', body: { email: `${name}@example.test`, username: name, displayName: name, password: 'A memorable test passphrase 42!' } })).body;
  const alice = await user('alice'); const mallory = await user('mallory');
  const W = (await api('/workspaces', { method: 'POST', token: alice.accessToken, body: { name: 'Uploads' } })).body.workspace;
  const general = (await api(`/channels/workspace/${W._id}`, { token: alice.accessToken })).body.channels.find((c) => c.name === 'general');
  const priv = (await api('/channels', { method: 'POST', token: alice.accessToken, body: { workspaceId: W._id, name: 'vault', type: 'private' } })).body.channel;
  await mongoose.connect(uri);
  await mongoose.connection.collection('workspaces').updateOne({ _id: new mongoose.Types.ObjectId(W._id) }, { $push: { members: { user: new mongoose.Types.ObjectId(mallory.user._id), role: 'member', joinedAt: new Date() } } });
  const ctx = (channelId) => ({ workspaceId: W._id, channelId });
  const before = tmpFiles();
  const MB = 1024 * 1024;

  // Valid upload works and spooled temp files are removed afterwards.
  const good = await upload({ token: alice.accessToken, fields: ctx(general._id), files: [{ name: 'a.pdf', type: 'application/pdf', size: 3 * MB, magic: PDF }] });
  assert.equal(good.status, 201, JSON.stringify(good.body)); assert.equal(good.body.attachments[0].size, 3 * MB);
  assert.equal(tmpFiles(), before, 'temp file removed after success');
  console.log('ok - valid upload stored; spool cleaned');

  // Size, count and declared-length limits.
  const tooBig = await upload({ token: alice.accessToken, fields: ctx(general._id), files: [{ name: 'big.pdf', type: 'application/pdf', size: (MAX_MB + 2) * MB, magic: PDF }], declareLength: false });
  assert.equal(tooBig.status, 413); assert.equal(tmpFiles(), before, 'partial file removed after limit hit');
  const tooMany = await upload({ token: alice.accessToken, fields: ctx(general._id), files: Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.pdf`, type: 'application/pdf', size: 1024, magic: PDF })) });
  assert.equal(tooMany.status, 400); assert.equal(tmpFiles(), before);
  const huge = await new Promise((resolve) => { // lie about Content-Length: rejected before reading the body
    const s = net.connect(port, '127.0.0.1', () => s.write(`POST /api/files/upload HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${alice.accessToken}\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: 9999999999\r\nX-Forwarded-For: 198.51.100.200\r\n\r\n`));
    let data = ''; s.on('data', (c) => { data += c; if (data.includes('\r\n\r\n')) { s.destroy(); resolve(data.split('\r\n')[0]); } }); s.on('error', () => resolve(data.split('\r\n')[0]));
  });
  assert.match(huge, /413/);
  console.log('ok - oversize file, too many files and absurd Content-Length are rejected');

  // Content validation does not trust the client's MIME type.
  assert.equal((await upload({ token: alice.accessToken, fields: ctx(general._id), files: [{ name: 'x.png', type: 'image/png', size: 4096, magic: Buffer.from('MZ\x90\x00') }] })).status, 400, 'EXE disguised as PNG');
  assert.equal((await upload({ token: alice.accessToken, fields: ctx(general._id), files: [{ name: 'x.png', type: 'image/png', size: 4096, magic: PDF }] })).status, 400, 'PDF declared as PNG');
  assert.equal((await upload({ token: alice.accessToken, fields: ctx(general._id), files: [{ name: 'x.sh', type: 'application/x-sh', size: 100, magic: Buffer.from('#!/bin/sh') }] })).status, 400, 'disallowed type');
  assert.equal(tmpFiles(), before, 'rejected files leave nothing behind');
  console.log('ok - spoofed and disallowed types rejected, nothing left on disk');

  // Authorization happens before file bytes are accepted.
  const denied = await upload({ token: mallory.accessToken, fields: ctx(priv._id), files: [{ name: 'a.pdf', type: 'application/pdf', size: 15 * MB, magic: PDF }] });
  assert.equal(denied.status, 403); assert.equal(tmpFiles(), before, 'unauthorized upload stored nothing');
  assert.equal((await upload({ token: mallory.accessToken, fields: { workspaceId: W._id, channelId: new mongoose.Types.ObjectId().toString() }, files: [{ name: 'a.pdf', type: 'application/pdf', size: 1024, magic: PDF }] })).status, 404);
  console.log('ok - unauthorized uploads are refused before storing anything');

  // Memory stays flat under heavy concurrent uploads (>400 MB of request bodies in total).
  await sleep(500); const baseline = rss(); let peak = baseline; const sampler = setInterval(() => { peak = Math.max(peak, rss()); }, 40);
  const heavy = () => upload({ token: alice.accessToken, fields: ctx(general._id), files: Array.from({ length: 3 }, (_, i) => ({ name: `h${i}.pdf`, type: 'application/pdf', size: 18 * MB, magic: PDF })) });
  const results = []; for (let wave = 0; wave < 4; wave++) results.push(...await Promise.all([heavy(), heavy()])); // 2 at a time (the configured concurrency)
  clearInterval(sampler);
  results.forEach((r) => assert.equal(r.status, 201, JSON.stringify(r.body)));
  const growth = peak - baseline;
  console.log(`  server RSS: baseline ${baseline.toFixed(0)} MB, peak ${peak.toFixed(0)} MB (+${growth.toFixed(0)} MB) while receiving ${(8 * 3 * 18)} MB`);
  assert.ok(growth < 150, `memory growth ${growth.toFixed(0)} MB suggests buffering`);
  assert.equal(tmpFiles(), before, 'all spooled files removed');
  console.log('ok - bounded memory under heavy concurrent uploads');

  // Concurrency cap protects the server instead of queueing unbounded work.
  const slow = () => upload({ token: alice.accessToken, fields: ctx(general._id), files: [{ name: 's.pdf', type: 'application/pdf', size: 2 * MB, magic: PDF }], chunkDelayMs: 40 });
  const burst = await Promise.all([slow(), slow(), slow(), slow()]);
  const busy = burst.filter((r) => r.status === 429);
  assert.ok(busy.length >= 1 && busy.every((r) => r.headers['retry-after']), `expected some 429s with Retry-After, got ${burst.map((r) => r.status)}`);
  assert.ok(burst.some((r) => r.status === 201));
  console.log('ok - concurrent upload cap returns 429 + Retry-After');

  // The server survived all of this.
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
})().then(() => { console.log('all tests passed'); return finish(0); }).catch((error) => { console.error(error); return finish(1); });

async function finish(code) {
  try { await mongoose.connection.dropDatabase(); } catch { /* none */ }
  try { server.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  process.exit(code);
}
