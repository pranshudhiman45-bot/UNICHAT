const { boot, assert } = require('./lib/harness');
const t = boot();
t.main(async ({ call, ok, register }) => {
  const Workspace = require('../src/models/Workspace');
  const Channel = require('../src/models/Channel');
  const Message = require('../src/models/Message');
  const [owner, member] = [await register('owner'), await register('member')];
  const workspace = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Integrity' } }), 201).workspace;
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: { user: member.id, role: 'member' } } });
  const channels = ok(await call(`/channels/workspace/${workspace._id}`, { token: owner.token })).channels;
  const general = channels.find((c) => c.name === 'general');
  await Channel.updateOne({ _id: general._id }, { $push: { members: { user: member.id, role: 'member' } } });
  const send = (token, text, extra = {}) => call('/messages', { method: 'POST', token, body: { workspaceId: workspace._id, channelId: general._id, content: text, ...extra } });

  // Deleted messages cannot be edited back to life.
  const m = ok(await send(owner.token, 'hello'), 201).message;
  ok(await call(`/messages/${m._id}`, { method: 'DELETE', token: owner.token }));
  assert.equal((await call(`/messages/${m._id}`, { method: 'PUT', token: owner.token, body: { content: 'resurrected' } })).status, 404);
  const stored = await Message.findById(m._id);
  assert.equal(stored.isDeleted, true); assert.equal(stored.content, '');
  console.log('ok - deleted message cannot be edited');

  // Thread reply count is idempotent under repeated and concurrent deletes.
  const parent = ok(await send(owner.token, 'parent'), 201).message;
  const replies = [];
  for (const text of ['r1', 'r2', 'r3']) replies.push(ok(await send(member.token, text, { parentMessageId: parent._id }), 201).message);
  assert.equal((await Message.findById(parent._id)).thread.replyCount, 3);
  await Promise.all([1, 2, 3, 4].map(() => call(`/messages/${replies[0]._id}`, { method: 'DELETE', token: member.token })));
  ok(await call(`/messages/${replies[0]._id}`, { method: 'DELETE', token: member.token }));
  assert.equal((await Message.findById(parent._id)).thread.replyCount, 2, 'five deletes of one reply decrement once');
  console.log('ok - delete is idempotent; reply count correct');

  // Concurrent reactions never lose updates; duplicates and removals are idempotent.
  const users = await Promise.all(Array.from({ length: 12 }, (_, i) => register(`racer${i}`)));
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: users.map((u) => ({ user: u.id, role: 'member' })) } });
  await Channel.updateOne({ _id: general._id }, { $push: { members: users.map((u) => ({ user: u.id, role: 'member' })) } });
  const target = ok(await send(owner.token, 'react to me'), 201).message;
  const react = (u, emoji) => call(`/messages/${target._id}/react`, { method: 'POST', token: u.token, body: { emoji } });
  const results = await Promise.all([...users.map((u) => react(u, '👍')), ...users.map((u) => react(u, '👍')), ...users.slice(0, 5).map((u) => react(u, '🎉'))]);
  results.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.body)));
  let reactions = (await Message.findById(target._id)).reactions;
  assert.equal(reactions.length, 2, 'one entry per emoji even under races');
  const thumbs = reactions.find((r) => r.emoji === '👍');
  assert.equal(thumbs.users.length, 12); assert.equal(new Set(thumbs.users.map(String)).size, 12); assert.equal(thumbs.count, 12);
  assert.equal(reactions.find((r) => r.emoji === '🎉').users.length, 5);
  const removal = () => call(`/messages/${target._id}/react`, { method: 'DELETE', token: users[0].token, body: { emoji: '👍' } });
  const removed = await Promise.all([removal(), removal(), removal()]);
  removed.forEach((r) => assert.equal(r.status, 200));
  reactions = (await Message.findById(target._id)).reactions;
  assert.equal(reactions.find((r) => r.emoji === '👍').users.length, 11); assert.equal(reactions.find((r) => r.emoji === '👍').count, 11);
  await Promise.all(users.slice(0, 5).map((u) => call(`/messages/${target._id}/react`, { method: 'DELETE', token: u.token, body: { emoji: '🎉' } })));
  assert.equal((await Message.findById(target._id)).reactions.some((r) => r.emoji === '🎉'), false, 'empty reactions are removed');
  for (const bad of ['', 'abc', '<script>', 'x'.repeat(40), ' ', 5]) assert.equal((await react(owner, bad)).status, 400, `rejects ${JSON.stringify(bad)}`);
  for (const good of ['❤️', '👍🏽', '🇮🇳', '👨‍👩‍👧', '1️⃣']) assert.equal((await react(owner, good)).status, 200, `accepts ${good}`);
  console.log('ok - reactions atomic, idempotent, validated');

  // Reaction type cap.
  const capped = ok(await send(owner.token, 'cap'), 201).message;
  const many = ['😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋'];
  const outcomes = [];
  for (const e of many) outcomes.push((await call(`/messages/${capped._id}/react`, { method: 'POST', token: owner.token, body: { emoji: e } })).status);
  assert.equal(outcomes.filter((s) => s === 200).length, 20); assert.equal(outcomes[20], 409);
  console.log('ok - reaction types capped');

  // Archived channels are readable but not writable; default channel cannot be archived.
  assert.equal((await call(`/channels/${general._id}`, { method: 'PATCH', token: owner.token, body: { isArchived: true } })).status, 400);
  assert.equal((await call(`/channels/${general._id}`, { method: 'DELETE', token: owner.token })).status, 400);
  assert.equal((await call(`/channels/${general._id}`, { method: 'PATCH', token: owner.token, body: { name: 'renamed' } })).status, 400);
  const side = ok(await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, name: 'Side Project' } }), 201).channel;
  assert.equal(side.name, 'side-project');
  for (const bad of ['bad/name', '<b>', '###', '??']) assert.equal((await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, name: bad } })).status, 400, bad);
  const sideMsg = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: side._id, content: 'before archive' } }), 201).message;
  ok(await call(`/channels/${side._id}`, { method: 'DELETE', token: owner.token }));
  assert.equal((await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: side._id, content: 'nope' } })).status, 403);
  assert.equal((await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: side._id, content: 'nope', parentMessageId: sideMsg._id } })).status, 403);
  assert.equal((await call(`/messages/${sideMsg._id}`, { method: 'PUT', token: owner.token, body: { content: 'edit' } })).status, 403);
  assert.equal((await call(`/messages/${sideMsg._id}/react`, { method: 'POST', token: owner.token, body: { emoji: '👍' } })).status, 403);
  assert.equal((await call(`/messages/${sideMsg._id}/pin`, { method: 'POST', token: owner.token })).status, 403);
  assert.equal((await call(`/messages/channel/${side._id}`, { token: owner.token })).status, 200, 'archived channel history stays readable');
  console.log('ok - archived and default channel rules');

  // Malformed IDs are 404s, not 500s; invites dedupe.
  for (const route of ['/channels/not-an-id', '/messages/xyz/thread', '/dms/nope/messages', '/workspaces/zzz']) assert.equal((await call(route, { token: owner.token })).status, 404, route);
  assert.equal((await call('/messages/bad/react', { method: 'POST', token: owner.token, body: { emoji: '👍' } })).status, 404);
  const inv = ok(await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, name: 'invites', type: 'private' } }), 201).channel;
  ok(await call(`/channels/${inv._id}/invite`, { method: 'POST', token: owner.token, body: { userIds: [member.id, member.id, member.id] } }));
  assert.equal((await Channel.findById(inv._id)).members.filter((x) => String(x.user) === member.id).length, 1);
  assert.equal((await call(`/channels/${inv._id}/invite`, { method: 'POST', token: owner.token, body: { userIds: ['bogus'] } })).status, 400);
  console.log('ok - id validation and invite dedupe');
});
