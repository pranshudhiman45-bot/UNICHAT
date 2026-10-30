const path = require('node:path');
const { boot, assert } = require('./lib/harness');
const t = boot();
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const SavedMessage = require('../src/models/SavedMessage');
  const StarredMessage = require('../src/models/StarredMessage');
  const { migrateStarredToSaved } = require('../src/utils/migrations');
  const [alice, bob] = [await register('alice'), await register('bob')];
  const W = ok(await call('/workspaces', { method: 'POST', token: alice.token, body: { name: 'Saved Co' } }), 201).workspace;
  await Workspace.updateOne({ _id: W._id }, { $push: { members: { user: bob.id, role: 'member' } } });
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: alice.token })).channels.find((c) => c.name === 'general');
  const say = async (text, channelId = general._id) => ok(await call('/messages', { method: 'POST', token: alice.token, body: { workspaceId: W._id, channelId, content: text } }), 201).message;
  const [m1, m2, m3] = [await say('one'), await say('two'), await say('three')];

  // A second device of the same user listens for sync events.
  const device = connect(`http://127.0.0.1:${port}`, { auth: { token: alice.token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const events = []; device.on('saved:changed', () => events.push(Date.now()));
  await new Promise((resolve) => device.once('connect', resolve)); await sleep(250);

  // Saved on "web" (/saved) is visible on "mobile" (/starred) and vice versa.
  ok(await call('/saved', { method: 'POST', token: alice.token, body: { workspaceId: W._id, messageId: m1._id } }), 201);
  ok(await call('/starred', { method: 'POST', token: alice.token, body: { workspaceId: W._id, messageId: m2._id } }), 201);
  const viaStarred = ok(await call(`/starred?workspaceId=${W._id}`, { token: alice.token })).starred.map((s) => s.message._id).sort();
  const viaSaved = ok(await call(`/saved?workspaceId=${W._id}`, { token: alice.token })).saved.map((s) => s.message._id).sort();
  assert.deepEqual(viaStarred, [m1._id, m2._id].sort()); assert.deepEqual(viaSaved, viaStarred, 'both views read the same data');
  assert.equal(ok(await call(`/starred?workspaceId=${W._id}`, { token: alice.token })).starred[0].channel.name, 'general', 'legacy response shape preserved');
  assert.equal(await SavedMessage.countDocuments({ user: alice.id }), 2); assert.equal(await StarredMessage.countDocuments({ user: alice.id }), 0, 'no new rows in the legacy collection');
  await sleep(300); assert.equal(events.length, 2, 'the other device is told about each change');
  console.log('ok - saved and starred are one list, synchronized across devices');

  // Duplicates are prevented from either entry point, including concurrently.
  assert.equal((await call('/starred', { method: 'POST', token: alice.token, body: { workspaceId: W._id, messageId: m1._id } })).status, 409);
  assert.equal((await call('/saved', { method: 'POST', token: alice.token, body: { workspaceId: W._id, messageId: m2._id } })).status, 409);
  const racing = await Promise.all(Array.from({ length: 6 }, (_, i) => call(i % 2 ? '/saved' : '/starred', { method: 'POST', token: alice.token, body: { workspaceId: W._id, messageId: m3._id } })));
  assert.equal(racing.filter((r) => r.status === 201).length, 1); assert.equal(await SavedMessage.countDocuments({ user: alice.id, message: m3._id }), 1);
  console.log('ok - duplicate saves rejected, race creates exactly one');

  // Unsave on either side removes it everywhere; unsaving something not saved is harmless.
  ok(await call(`/starred/${m1._id}`, { method: 'DELETE', token: alice.token }));
  ok(await call(`/saved/${m2._id}`, { method: 'DELETE', token: alice.token }));
  ok(await call(`/saved/${m2._id}`, { method: 'DELETE', token: alice.token }));
  assert.deepEqual(ok(await call(`/saved?workspaceId=${W._id}`, { token: alice.token })).saved.map((s) => s.message._id), [m3._id]);
  console.log('ok - unsave synchronized from either entry point');

  // Authorization: can't save what you can't read; saved items vanish when access is lost.
  const secret = ok(await call('/channels', { method: 'POST', token: alice.token, body: { workspaceId: W._id, name: 'secret', type: 'private', memberIds: [bob.id] } }), 201).channel;
  const secretMsg = await say('classified', secret._id);
  ok(await call('/saved', { method: 'POST', token: bob.token, body: { workspaceId: W._id, messageId: secretMsg._id } }), 201);
  ok(await call(`/channels/${secret._id}/members/${bob.id}`, { method: 'DELETE', token: alice.token }));
  assert.equal(ok(await call(`/saved?workspaceId=${W._id}`, { token: bob.token })).saved.length, 0, 'saved item hidden after losing channel access');
  assert.equal(ok(await call(`/starred?workspaceId=${W._id}`, { token: bob.token })).starred.length, 0);
  assert.equal((await call('/saved', { method: 'POST', token: bob.token, body: { workspaceId: W._id, messageId: secretMsg._id } })).status, 403);
  assert.equal((await call('/starred', { method: 'POST', token: bob.token, body: { workspaceId: W._id, messageId: secretMsg._id } })).status, 403);
  console.log('ok - saved respects current access');

  // Legacy data migration is correct and idempotent.
  const legacyMsg = await say('legacy star');
  await StarredMessage.create({ user: bob.id, message: legacyMsg._id, workspace: W._id, channel: general._id });
  assert.equal(await migrateStarredToSaved(), 1); assert.equal(await migrateStarredToSaved(), 0, 'second run adds nothing');
  assert.equal(await SavedMessage.countDocuments({ user: bob.id, message: legacyMsg._id }), 1);
  assert.ok(ok(await call(`/saved?workspaceId=${W._id}`, { token: bob.token })).saved.some((s) => s.message._id === legacyMsg._id), 'migrated item shows up in saved');
  device.disconnect();
  console.log('ok - legacy starred rows migrate once');
});
