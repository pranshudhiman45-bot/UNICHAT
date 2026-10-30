const path = require('node:path');
const { boot, assert } = require('./lib/harness');
const t = boot({ LOCAL_UPLOAD_DIR: require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'unichat-idem-')) });
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const Channel = require('../src/models/Channel');
  const Message = require('../src/models/Message');
  const StoredAttachment = require('../src/models/StoredAttachment');
  const [alice, bob] = [await register('alice'), await register('bob')];
  const workspace = ok(await call('/workspaces', { method: 'POST', token: alice.token, body: { name: 'Idem' } }), 201).workspace;
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: { user: bob.id, role: 'member' } } });
  const channels = ok(await call(`/channels/workspace/${workspace._id}`, { token: alice.token })).channels;
  const general = channels.find((c) => c.name === 'general'); const random = channels.find((c) => c.name === 'random');
  await Channel.updateMany({ _id: { $in: [general._id, random._id] } }, { $push: { members: { user: bob.id, role: 'member' } } });
  const send = (token, body) => call('/messages', { method: 'POST', token, body: { workspaceId: workspace._id, channelId: general._id, ...body } });

  const listener = connect(`http://127.0.0.1:${port}`, { auth: { token: bob.token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const broadcasts = []; listener.on('message:new', (m) => broadcasts.push(m));
  await new Promise((resolve) => listener.once('connect', resolve)); await sleep(300);

  // 1. Retry returns the original; exactly one row and one broadcast.
  const key = 'idem-key-0001';
  const first = ok(await send(alice.token, { content: 'once', clientMessageId: key }), 201);
  const retry = ok(await send(alice.token, { content: 'once', clientMessageId: key }), 200);
  assert.equal(retry.message._id, first.message._id); assert.equal(retry.duplicate, true);
  assert.equal(await Message.countDocuments({ clientMessageId: key }), 1);
  await sleep(300);
  assert.equal(broadcasts.filter((m) => m.content === 'once').length, 1, 'no duplicate Socket.IO broadcast');
  console.log('ok - retry returns original; one row, one broadcast');

  // 2. Parallel identical requests (client retry racing the original).
  const results = await Promise.all(Array.from({ length: 8 }, () => send(alice.token, { content: 'race', clientMessageId: 'idem-race-0001' })));
  results.forEach((r) => assert.ok([200, 201].includes(r.status), JSON.stringify(r.body)));
  assert.equal(new Set(results.map((r) => r.body.message._id)).size, 1);
  assert.equal(await Message.countDocuments({ clientMessageId: 'idem-race-0001' }), 1);
  await sleep(300);
  assert.equal(broadcasts.filter((m) => m.content === 'race').length, 1);
  console.log('ok - 8 concurrent identical sends create exactly one message');

  // 3. Server-side failure after the message is committed: client still sees success, retry is harmless.
  const original = Channel.findByIdAndUpdate; let armed = true;
  Channel.findByIdAndUpdate = function (...args) { if (armed) { armed = false; throw new Error('simulated post-commit failure'); } return original.apply(this, args); };
  const flaky = await send(alice.token, { content: 'flaky', clientMessageId: 'idem-flaky-01' });
  Channel.findByIdAndUpdate = original;
  assert.equal(flaky.status, 201, 'post-commit failure does not surface as an error');
  const flakyRetry = ok(await send(alice.token, { content: 'flaky', clientMessageId: 'idem-flaky-01' }), 200);
  assert.equal(flakyRetry.message._id, flaky.body.message._id); assert.equal(await Message.countDocuments({ clientMessageId: 'idem-flaky-01' }), 1);
  console.log('ok - post-commit failure + retry yields exactly one message');

  // 4. Scoping and validation.
  assert.equal((await call('/messages', { method: 'POST', token: alice.token, body: { workspaceId: workspace._id, channelId: random._id, content: 'x', clientMessageId: key } })).status, 409, 'key reuse across conversations is rejected');
  const bobSame = ok(await send(bob.token, { content: 'bob', clientMessageId: key }), 201);
  assert.notEqual(bobSame.message._id, first.message._id, 'keys are per sender');
  assert.equal((await send(alice.token, { content: 'x', clientMessageId: 'short' })).status, 400);
  assert.equal((await send(alice.token, { content: 'x', clientMessageId: 'has spaces and !!' })).status, 400);
  assert.equal((await send(alice.token, { content: 'no key at all' })).status, 201, 'key is optional (backward compatible)');
  console.log('ok - scoped per sender/conversation, validated, optional');

  // 5. A retry with attachments (already consumed) still resolves.
  const form = new FormData(); form.append('workspaceId', workspace._id); form.append('channelId', general._id);
  form.append('files', new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)])], { type: 'application/pdf' }), 'a.pdf');
  const up = await (await fetch(`http://127.0.0.1:${port}/api/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${alice.token}`, 'x-forwarded-for': '198.51.100.7' }, body: form })).json();
  const body = { content: 'with file', attachmentIds: [up.attachments[0].uploadId], clientMessageId: 'idem-file-0001' };
  const sent = ok(await send(alice.token, body), 201);
  const again = ok(await send(alice.token, body), 200);
  assert.equal(again.message._id, sent.message._id);
  assert.equal((await StoredAttachment.findById(up.attachments[0].uploadId)).status, 'attached');
  console.log('ok - retry with attachments resolves to the original');
  listener.disconnect();
});
