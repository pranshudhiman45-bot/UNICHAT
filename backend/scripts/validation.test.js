const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unichat-val-'));
const { boot, assert } = require('./lib/harness');
const t = boot({ DEV_EMAIL_DIR: mailDir });
let crashed = null; process.on('uncaughtException', (e) => { crashed = e; });

t.main(async ({ call, ok, register, sleep, port }) => {
  const StoredAttachment = require('../src/models/StoredAttachment');
  const Workspace = require('../src/models/Workspace');
  const alice = await register('alice');
  const W = ok(await call('/workspaces', { method: 'POST', token: alice.token, body: { name: 'Validation' } }), 201).workspace;
  const raw = (route, init = {}) => fetch(`http://127.0.0.1:${port}${route}`, { ...init, headers: { 'x-forwarded-for': '198.51.100.31', ...(init.headers || {}) } });

  // 1. A failing database call inside an async route becomes a 500 for that request, not a dead server.
  const original = StoredAttachment.findOne; StoredAttachment.findOne = () => Promise.reject(new Error('simulated database failure'));
  const failed = await call('/files/507f1f77bcf86cd799439011', { method: 'DELETE', token: alice.token });
  StoredAttachment.findOne = original;
  assert.equal(failed.status, 500); assert.equal(typeof failed.body.error, 'string'); assert.ok(!/simulated database failure/.test(JSON.stringify(failed.body)), 'internal error text is not leaked');
  await sleep(100); assert.equal(crashed, null, 'no uncaught exception'); assert.equal((await call('/auth/me', { token: alice.token })).status, 200, 'server still healthy');
  console.log('ok - async route failures are contained (500, no crash, no leak)');

  // 2. Login response time does not reveal whether an email is registered.
  const time = async (email) => { const s = process.hrtime.bigint(); await call('/auth/login', { method: 'POST', body: { email, password: 'wrong password entirely' } }); return Number(process.hrtime.bigint() - s) / 1e6; };
  await time('warmup@example.test');
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const known = []; const unknown = [];
  for (let i = 0; i < 4; i++) { known.push(await time('alice@example.test')); unknown.push(await time(`nobody${i}@example.test`)); }
  const gap = Math.abs(median(known) - median(unknown));
  console.log(`  median login time: registered ${median(known).toFixed(0)} ms vs unknown ${median(unknown).toFixed(0)} ms`);
  assert.ok(gap < 120, `timing gap ${gap.toFixed(0)}ms could reveal registered emails`);
  console.log('ok - login timing is equalized');

  // 3. Registration does not reveal whether an email/username exists unless the caller proved mailbox ownership.
  process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
  const body = (email, username, extra = {}) => ({ email, username, displayName: 'X', password: 'A memorable test passphrase 42!', ...extra });
  const takenNoProof = await call('/auth/register', { method: 'POST', body: body('alice@example.test', 'someoneelse') });
  const freeNoProof = await call('/auth/register', { method: 'POST', body: body('fresh@example.test', 'freshuser') });
  assert.equal(takenNoProof.status, 400); assert.equal(freeNoProof.status, 400);
  assert.deepEqual(takenNoProof.body, freeNoProof.body, 'identical answer for registered and unregistered email without proof');
  const takenUsernameNoProof = await call('/auth/register', { method: 'POST', body: body('fresh2@example.test', 'alice') });
  assert.deepEqual(takenUsernameNoProof.body, freeNoProof.body, 'username existence is not revealed either');
  // With a genuine proof for that address, conflicts are reported (the caller owns the mailbox).
  const proofFor = async (email) => {
    ok(await call('/auth/email-verification/request', { method: 'POST', body: { email } }));
    const mail = fs.readdirSync(mailDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8'))).filter((m) => m.to === email).pop();
    return ok(await call('/auth/email-verification/verify', { method: 'POST', body: { email, code: mail.text.match(/\b(\d{6})\b/)[1] } })).emailVerificationToken;
  };
  const proof = await proofFor('alice@example.test');
  assert.equal((await call('/auth/register', { method: 'POST', body: body('alice@example.test', 'newname', { emailVerificationToken: proof }) })).status, 409);
  const proof2 = await proofFor('brandnew@example.test');
  assert.equal((await call('/auth/register', { method: 'POST', body: body('brandnew@example.test', 'brandnew', { emailVerificationToken: proof2 }) })).status, 201, 'legitimate verified registration still works');
  assert.equal((await call('/auth/register', { method: 'POST', body: body('brandnew@example.test', 'brandnew2', { emailVerificationToken: proof2 }) })).status, 400, 'a proof is single-use');
  process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
  console.log('ok - registration is not an email-existence oracle');

  // 4. Uniform, safe error shape: JSON with a string `error`, correct status, no stack traces.
  const bad = [
    ['GET', '/channels/nope'], ['GET', '/messages/channel/zzz'], ['GET', '/dms/zzz/messages'], ['GET', '/workspaces/zzz'], ['GET', '/notifications?filter=bogus'],
    ['GET', '/search?q='], ['GET', '/search?workspaceId=x&q=a'], ['POST', '/messages', {}], ['POST', '/channels', { name: '' }], ['POST', '/dms', {}],
    ['PUT', '/messages/zzz', { content: 'x' }], ['DELETE', '/messages/zzz'], ['POST', '/files/urls', { uploadIds: 'x' }], ['GET', '/users/search?q=a&workspaceId=zzz'],
    ['POST', '/saved', {}], ['GET', '/no/such/route'], ['POST', '/workspaces', { name: 'x' }], ['PUT', '/users/profile', { displayName: '' }], ['PUT', '/users/notification-settings', { sounds: 'yes' }], ['POST', '/users/push-token', { token: 1 }],
  ];
  for (const [method, route, payload] of bad) {
    const r = await call(route, { method, token: alice.token, body: payload });
    assert.ok(r.status >= 400 && r.status < 500, `${method} ${route} -> ${r.status}`);
    assert.equal(typeof r.body.error, 'string', `${method} ${route} lacks an error string`);
    assert.ok(!/at .*\.js:\d+/.test(JSON.stringify(r.body)), 'no stack traces');
  }
  assert.equal((await raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })).status, 400);
  assert.equal((await raw('/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415, 'form/plain posts to auth routes are rejected');
  assert.equal((await raw('/api/auth/me', { headers: { origin: 'https://evil.example' } })).status, 403, 'unlisted browser origins are refused');
  console.log(`ok - ${bad.length + 3} bad requests return the uniform JSON error shape`);

  // 5. Oversized JSON is refused outright.
  const huge = await raw('/api/messages', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` }, body: JSON.stringify({ content: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
  const overLimit = await call('/messages', { method: 'POST', token: alice.token, body: { workspaceId: W._id, channelId: (await Workspace.findById(W._id) && ok(await call(`/channels/workspace/${W._id}`, { token: alice.token })).channels[0]._id), content: 'y'.repeat(41000) } });
  assert.ok([400, 413].includes(overLimit.status), `message over the content limit rejected (${overLimit.status})`);
  console.log('ok - body and content size limits enforced');
});
