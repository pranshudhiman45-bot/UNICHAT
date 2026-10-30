// Counts database operations needed to send one message to a large channel, and checks behaviour is unchanged.
const { boot, assert } = require('./lib/harness');
const t = boot();
const MEMBERS = Number(process.env.PERF_MEMBERS || 200);

t.main(async ({ call, ok, register }) => {
  const mongoose = require('mongoose');
  const Workspace = require('../src/models/Workspace');
  const Channel = require('../src/models/Channel');
  const User = require('../src/models/User');
  const Notification = require('../src/models/Notification');
  const bcrypt = require('bcryptjs');

  const owner = await register('sender');
  const W = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Big Co' } }), 201).workspace;
  // Create many members directly (registration is rate limited and slow by design).
  const hash = bcrypt.hashSync('A memorable test passphrase 42!', 4);
  const users = await User.insertMany(Array.from({ length: MEMBERS }, (_, i) => ({ username: `member${i}`, email: `member${i}@example.test`, password: hash, displayName: `Member ${i}`,
    notificationSettings: { channelMessages: i % 2 === 0, mentions: true, directMessages: true, threadReplies: true, reactions: true } })));
  await Workspace.updateOne({ _id: W._id }, { $push: { members: users.map((u) => ({ user: u._id, role: 'member' })) } });
  const channel = ok(await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: W._id, name: 'everyone', memberIds: users.map((u) => String(u._id)) } }), 201).channel;

  let operations = 0;
  mongoose.set('debug', () => { operations++; });
  const started = Date.now();
  const sent = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: W._id, channelId: channel._id, content: `hello everyone <@${users[0]._id}> <@${users[1]._id}>` } }), 201).message;
  const elapsed = Date.now() - started;
  mongoose.set('debug', false);
  console.log(`send to ${MEMBERS}-member channel: ${operations} database operations, ${elapsed} ms`);

  // Behaviour: mentioned users get mention items; opted-in members get channel_message items; others get nothing.
  const rows = await Notification.find({ message: sent._id }).lean();
  const byType = rows.reduce((acc, row) => { acc[row.type] = (acc[row.type] || 0) + 1; return acc; }, {});
  assert.equal(byType.mention, 2, 'both mentioned members notified once');
  const optedIn = users.filter((u, i) => i % 2 === 0 && i > 1).length; // even indexes, excluding the two mentioned (they only get the mention)
  assert.equal(byType.channel_message, Math.ceil(MEMBERS / 2) - 1, 'exactly the opted-in, non-mentioned members get channel_message'); // even-indexed members minus member0 (mentioned)
  void optedIn;
  assert.ok(rows.every((row) => String(row.recipient) !== owner.id), 'sender never notified');
  assert.equal(new Set(rows.map((row) => `${row.recipient}:${row.type}`)).size, rows.length, 'no duplicates');
  assert.ok(rows.every((row) => row.dedupeKey), 'every row has a dedupe key');
  if (process.env.PERF_BUDGET) assert.ok(operations <= Number(process.env.PERF_BUDGET), `operations ${operations} exceeds budget ${process.env.PERF_BUDGET}`);
  global.__perf = { operations, elapsed };
});
