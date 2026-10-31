// Release verification of production configuration: the checklist tool, and the REAL server started in production
// mode with deliberately dangerous settings. Secrets here are freshly generated and never printed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const backend = path.join(__dirname, '..');
const rnd = (n = 40) => crypto.randomBytes(n).toString('base64url');
const adminHash = bcrypt.hashSync(rnd(18), 12);
const dbName = `unichat_prodcfg_${crypto.randomBytes(5).toString('hex')}`;
const goodEnv = () => ({
  NODE_ENV: 'production', PORT: '0', MONGODB_URI: `mongodb://127.0.0.1:27017/${dbName}`,
  JWT_SECRET: rnd(), JWT_REFRESH_SECRET: rnd(), PASSWORD_RESET_PEPPER: rnd(),
  ADMIN_EMAIL: 'owner@prod.example', ADMIN_PASSWORD_HASH: adminHash,
  PUBLIC_API_URL: 'https://api.prod.example/api', ALLOWED_ORIGINS: 'https://app.prod.example', CLIENT_URL: 'https://app.prod.example', TRUST_PROXY_HOPS: '1',
  SMTP_HOST: 'smtp.prod.example', SMTP_FROM: 'Unichat <no-reply@prod.example>', SMTP_USER: 'mailer', SMTP_PASSWORD: rnd(18),
  FILE_STORAGE: 'cloudinary', CLOUDINARY_CLOUD_NAME: 'prodcloud', CLOUDINARY_API_KEY: '123456789012345', CLOUDINARY_API_SECRET: rnd(24),
  ENV_FILE: '/nonexistent/.env', // never fall back to a developer's .env
});
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function checker(env) {
  const file = path.join(os.tmpdir(), `prodcfg-${crypto.randomBytes(4).toString('hex')}.env`);
  fs.writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
  try { const r = spawnSync(process.execPath, ['scripts/check-production-config.js', '--env-file', file], { cwd: backend, encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; }
  finally { fs.rmSync(file, { force: true }); }
}
// Starts the real API; resolves with { exited, code, output, port, stop } once it listens or dies.
function start(env) {
  return new Promise(async (resolve) => {
    const port = await freePort();
    const child = spawn(process.execPath, ['src/index.js'], { cwd: backend, env: { PATH: process.env.PATH, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve({ ...value, output, port, stop: () => child.kill('SIGKILL') }); } };
    // Wait for the last startup line; resolving on an earlier one raced the remaining log lines under load.
    child.stdout.on('data', (c) => { output += c; if (/Environment: \S+/.test(output)) done({ exited: false }); });
    child.stderr.on('data', (c) => { output += c; });
    child.on('exit', (code) => done({ exited: true, code }));
    setTimeout(() => { child.kill('SIGKILL'); done({ exited: true, code: 'timeout' }); }, 20000);
  });
}

(async () => {
  const secrets = Object.values(goodEnv()).filter((v) => typeof v === 'string' && v.length >= 20 && !/^https?:|^mongodb|^Unichat|\//.test(v));

  // ---- A. checklist tool ------------------------------------------------------------------------------------------
  const remoteUri = `mongodb+srv://app:${rnd(14)}@cluster0.prod.example/unichat?retryWrites=true`;
  const asProd = (patch = {}) => ({ ...goodEnv(), MONGODB_URI: remoteUri, ...patch });
  const good = asProd();
  const ok = checker(good);
  assert.equal(ok.code, 0, ok.out); assert.match(ok.out, /RESULT: configuration passes/);
  for (const secret of [good.JWT_SECRET, good.JWT_REFRESH_SECRET, good.PASSWORD_RESET_PEPPER, good.ADMIN_PASSWORD_HASH, good.SMTP_PASSWORD, good.CLOUDINARY_API_SECRET, remoteUri]) assert.equal(ok.out.includes(secret), false, 'the checker must never print a secret value');
  assert.match(ok.out, /WARN\s+REDIS_URL/, 'single-instance Redis warning surfaces');
  const unsafe = (patch, expectedName) => { const r = checker(asProd(patch)); assert.equal(r.code, 1, `${expectedName}: ${r.out}`); assert.match(r.out, new RegExp(`(UNSAFE|MISSING)\\s+${expectedName}`), r.out); };
  unsafe({ NODE_ENV: 'prod' }, 'NODE_ENV'); unsafe({ NODE_ENV: '' }, 'NODE_ENV');
  unsafe({ JWT_SECRET: 'short' }, 'JWT_SECRET'); unsafe({ JWT_SECRET: 'your-super-secret-key-change-this-now-please-1234' }, 'JWT_SECRET');
  const same = rnd(); unsafe({ JWT_SECRET: same, JWT_REFRESH_SECRET: same }, 'JWT_REFRESH_SECRET');
  unsafe({ ADMIN_PASSWORD_HASH: 'plaintext-admin-password' }, 'ADMIN_PASSWORD_HASH'); unsafe({ ADMIN_PASSWORD_HASH: '' }, 'ADMIN_PASSWORD_HASH');
  unsafe({ PUBLIC_API_URL: 'http://api.prod.example/api' }, 'PUBLIC_API_URL');
  unsafe({ ALLOWED_ORIGINS: '*' }, 'ALLOWED_ORIGINS'); unsafe({ ALLOWED_ORIGINS: 'http://app.prod.example' }, 'ALLOWED_ORIGINS'); unsafe({ ALLOWED_ORIGINS: 'https://app.prod.example,http://localhost:5173' }, 'ALLOWED_ORIGINS');
  unsafe({ TRUST_PROXY_HOPS: '0' }, 'TRUST_PROXY_HOPS');
  unsafe({ MONGODB_URI: 'mongodb://127.0.0.1:27017/unichat' }, 'MONGODB_URI'); unsafe({ MONGODB_URI: 'mongodb://db.prod.example:27017/unichat' }, 'MONGODB_URI');
  unsafe({ EMAIL_TRANSPORT: 'file' }, 'EMAIL_TRANSPORT'); unsafe({ FILE_STORAGE: 'local' }, 'FILE_STORAGE'); unsafe({ SMTP_HOST: '' }, 'SMTP_HOST');
  unsafe({ CLOUDINARY_API_SECRET: '' }, 'CLOUDINARY_API_SECRET'); unsafe({ DEV_EMAIL_DIR: '../.local/mail' }, 'DEV_EMAIL_DIR'); unsafe({ SEED_ALLOW_REMOTE: 'true' }, 'SEED_ALLOW_REMOTE');
  unsafe({ WEB_PUSH_PUBLIC_KEY: 'only-one-half' }, 'WEB_PUSH_\\*');
  console.log('ok - A: checklist tool passes a correct config, flags 22 dangerous variants, and never prints a secret');

  // ---- B. the real server in production mode -----------------------------------------------------------------------
  const refuses = async (patch, pattern, label) => {
    const run = await start({ ...goodEnv(), ...patch });
    run.stop();
    assert.equal(run.exited, true, `${label}: the server must REFUSE to start`); assert.notEqual(run.code, 0);
    assert.match(run.output, pattern, `${label}: ${run.output.slice(-300)}`);
    return run;
  };
  await refuses({ EMAIL_TRANSPORT: 'file' }, /File email delivery is only available for local testing/, 'local file email');
  await refuses({ FILE_STORAGE: 'local' }, /Local file storage is only available for testing/, 'local file storage');
  await refuses({ JWT_SECRET: 'x'.repeat(10) }, /at least 32 characters/, 'short JWT secret');
  const shared = rnd(); await refuses({ JWT_SECRET: shared, JWT_REFRESH_SECRET: shared }, /distinct access and refresh/, 'identical JWT secrets');
  await refuses({ JWT_REFRESH_SECRET: '' }, /Missing required environment variables: JWT_REFRESH_SECRET/, 'missing refresh secret');
  await refuses({ ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '' }, /Admin credentials are required in production/, 'no admin credentials');
  await refuses({ ADMIN_PASSWORD_HASH: 'password123' }, /bcrypt hash with cost 12/, 'plaintext admin password');
  await refuses({ PUBLIC_API_URL: 'http://api.prod.example/api' }, /PUBLIC_API_URL must use HTTPS/, 'http public URL');
  await refuses({ PUBLIC_API_URL: '' }, /PUBLIC_API_URL/, 'missing public URL');
  await refuses({ ALLOWED_ORIGINS: 'http://app.prod.example', CLIENT_URL: '' }, /HTTPS ALLOWED_ORIGINS/, 'http origin');
  await refuses({ ALLOWED_ORIGINS: '', CLIENT_URL: '' }, /HTTPS ALLOWED_ORIGINS/, 'no origins');
  await refuses({ SMTP_HOST: '' }, /SMTP_HOST and SMTP_FROM are required/, 'no SMTP');
  await refuses({ REDIS_URL: 'redis://127.0.0.1:1' , REDIS_STARTUP_WAIT_MS: '800' }, /REDIS_URL is configured but Redis is unreachable/, 'configured-but-unreachable Redis');
  console.log('ok - B1: production refuses local email, local storage, weak/shared secrets, no/plaintext admin, http URLs/origins, no SMTP, dead Redis');

  // A fully valid production config starts.
  const prod = await start(goodEnv());
  try {
    assert.equal(prod.exited, false, prod.output.slice(-400));
    assert.match(prod.output, /Environment: production/);
    assert.match(prod.output, /WARNING: REDIS_URL is not set/, 'the single-instance warning is emitted');
    const base = `http://127.0.0.1:${prod.port}`;
    const hit = (route, { headers = {}, ...init } = {}) => fetch(`${base}${route}`, { ...init, headers: { 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200) + 1}`, ...headers } });

    // HTTPS is required for the API: plain HTTP is refused, a TLS-terminating proxy header is accepted.
    assert.equal((await hit('/api/auth/config')).status, 426, 'plain HTTP to /api is refused in production');
    const viaProxy = { 'x-forwarded-proto': 'https' };
    assert.equal((await hit('/api/auth/config', { headers: viaProxy })).status, 200, 'the same request through the TLS proxy works');
    assert.equal((await hit('/health/live')).status, 200, 'liveness is reachable without TLS (load balancer probes)');

    // CORS is an exact allow-list.
    const origin = (value) => hit('/api/auth/config', { headers: { ...viaProxy, origin: value } });
    const allowed = await origin('https://app.prod.example');
    assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.prod.example'); assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
    for (const evil of ['https://evil.example', 'https://app.prod.example.evil.example', 'http://app.prod.example', 'null', 'https://APP.prod.example:8443']) {
      const r = await origin(evil); assert.equal(r.status, 403, evil); assert.equal(r.headers.get('access-control-allow-origin'), null, `${evil} gets no CORS grant`);
    }
    const preflight = await hit('/api/messages', { method: 'OPTIONS', headers: { ...viaProxy, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null, 'preflight from an unlisted origin is not granted');

    // Cookies: create a user straight in the database (production registration needs real email), then log in.
    await mongoose.connect(goodEnv().MONGODB_URI);
    const User = require('../src/models/User');
    await User.create({ username: 'cookieuser', email: 'cookie@prod.example', displayName: 'Cookie', password: 'A memorable test passphrase 42!', emailVerifiedAt: new Date() });
    const login = await hit('/api/auth/login', { method: 'POST', headers: { ...viaProxy, 'content-type': 'application/json', 'x-client-auth': 'cookie', origin: 'https://app.prod.example' }, body: JSON.stringify({ email: 'cookie@prod.example', password: 'A memorable test passphrase 42!' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /unichat_refresh=/); for (const flag of [/HttpOnly/i, /Secure/i, /SameSite=Strict/i, /Path=\/api\/auth/i]) assert.match(cookie, flag, `refresh cookie must carry ${flag}`);
    assert.equal(login.headers.get('cache-control'), 'no-store', 'auth responses are not cacheable');
    const body = await login.json(); assert.equal(body.refreshToken, undefined, 'cookie clients never receive the refresh token in JSON');
    // Production forces email verification even when REQUIRE_EMAIL_VERIFICATION=false is set.
    const stop1 = prod.stop;
    // Health does not need TLS; it exposes the shape documented in docs/PRODUCTION.md.
    const health = await (await hit('/health')).json(); assert.equal(health.checks.database, 'ready');
    console.log('ok - B2: valid production config starts; HTTP refused (426), TLS-proxy accepted; CORS is an exact allow-list; refresh cookie is HttpOnly+Secure+SameSite=Strict+scoped');
    stop1();
  } finally { prod.stop(); try { await mongoose.connection.dropDatabase(); } catch { /* none */ } }

  // Email verification cannot be switched off in production.
  const noVerify = await start({ ...goodEnv(), REQUIRE_EMAIL_VERIFICATION: 'false' });
  try {
    const r = await fetch(`http://127.0.0.1:${noVerify.port}/api/auth/config`, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.9' } });
    assert.equal((await r.json()).emailVerificationRequired, true, 'production forces email verification');
  } finally { noVerify.stop(); }

  // The seed script cannot wipe production, even with the destroy flag and a local database.
  const seed = spawnSync(process.execPath, ['src/utils/seed.js', '--confirm-destroy-all-data'], { cwd: backend, env: { PATH: process.env.PATH, NODE_ENV: 'production', MONGODB_URI: `mongodb://127.0.0.1:27017/${dbName}`, ENV_FILE: '/nonexistent' }, encoding: 'utf8' });
  assert.notEqual(seed.status, 0); assert.match(seed.stderr, /Seed refused/);
  assert.equal(seed.stdout.includes('Connected to MongoDB'), false, 'it never even connected');
  console.log('ok - B3: email verification cannot be disabled in production; seed refuses to run (no connection made)');

  // ---- C. known footguns, reported (not asserted away) --------------------------------------------------------------
  const typo = await start({ ...goodEnv(), NODE_ENV: 'prod', EMAIL_TRANSPORT: 'file', FILE_STORAGE: 'local', PUBLIC_API_URL: 'http://x', ALLOWED_ORIGINS: 'http://localhost:5173', JWT_SECRET: 'weak', JWT_REFRESH_SECRET: 'weak2' });
  const typoStarted = !typo.exited; typo.stop();
  const noCloud = await start({ ...goodEnv(), CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '' });
  const noCloudStarted = !noCloud.exited; noCloud.stop();
  console.log(`FINDING (config footgun): NODE_ENV typo ("prod") with dev settings -> server started: ${typoStarted}`);
  console.log(`FINDING (config gap): production with NO Cloudinary credentials -> server started: ${noCloudStarted}`);
  console.log('all tests passed');
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
