const { boot, assert } = require('./lib/harness');
const t = boot({ MAX_THREAD_REPLIES_PER_RESPONSE: '5' });
t.main(async ({ call, ok, register }) => {
  const mongoose = require('mongoose');
  const Message = require('../src/models/Message'); const Workspace = require('../src/models/Workspace'); const Notification = require('../src/models/Notification'); const StoredAttachment = require('../src/models/StoredAttachment');
  const { getWorkspaceContext, getChannelContext } = require('../src/middleware/authorization');
  const Channel = require('../src/models/Channel');
  await Promise.all([Message.init(), Notification.init(), StoredAttachment.init()]);
  const [owner, member] = [await register('owner'), await register('member')];
  const W = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Big' } }), 201).workspace;
  const oid = () => new mongoose.Types.ObjectId();
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: owner.token })).channels.find((c) => c.name === 'general');

  // 1. History paging reads only the page it returns, even when most messages in the channel are thread replies.
  const base = Date.now() - 100000 * 1000; const docs = [];
  const roots = []; for (let i = 0; i < 3000; i++) { const _id = oid(); roots.push(_id); docs.push({ _id, workspace: new mongoose.Types.ObjectId(W._id), channel: new mongoose.Types.ObjectId(general._id), sender: oid(), content: `r${i}`, isDeleted: false, createdAt: new Date(base + i * 1000), updatedAt: new Date(base + i * 1000), thread: { parentMessage: null, replyCount: 0, participants: [] }, attachments: [], reactions: [], mentions: [] }); }
  for (let i = 0; i < 12000; i++) docs.push({ workspace: new mongoose.Types.ObjectId(W._id), channel: new mongoose.Types.ObjectId(general._id), sender: oid(), content: `reply${i}`, isDeleted: false, createdAt: new Date(base + 1500 + i * 250), updatedAt: new Date(), thread: { parentMessage: roots[i % 50], replyCount: 0, participants: [] }, attachments: [], reactions: [], mentions: [] });
  await Message.collection.insertMany(docs);
  const plan = await Message.find({ channel: general._id, 'thread.parentMessage': null, isDeleted: false }).sort({ createdAt: -1, _id: -1 }).limit(51).explain('executionStats');
  const stats = plan.executionStats; const text = JSON.stringify(plan.queryPlanner.winningPlan);
  console.log(`  history page: examined ${stats.totalDocsExamined} docs / ${stats.totalKeysExamined} keys to return ${stats.nReturned} (channel has ${docs.length} messages)`);
  assert.ok(/IXSCAN/.test(text) && !/COLLSCAN/.test(text), 'uses an index'); assert.ok(!/"stage":"SORT"/.test(text), 'index provides the order (no in-memory sort)');
  assert.ok(stats.totalDocsExamined <= 60, `examined ${stats.totalDocsExamined} documents for a 51-row page`);
  const page = await call(`/messages/channel/${general._id}?limit=50`, { token: owner.token }); assert.equal(page.body.messages.length, 50);
  console.log('ok - history query is index-ordered and reads only what it returns');

  // 2. Hot-path membership checks load only the caller's own entry, not the whole member array.
  const filler = Array.from({ length: 3000 }, () => ({ user: oid(), role: 'member', joinedAt: new Date() }));
  await Workspace.updateOne({ _id: W._id }, { $push: { members: { $each: [...filler, { user: member.id, role: 'member' }] } } });
  const light = await getWorkspaceContext(W._id, member.id, { light: true }); const full = await getWorkspaceContext(W._id, member.id);
  assert.equal(light.workspace.members.length, 1); assert.equal(full.workspace.members.length, 3002);
  assert.equal(light.workspace.isMember(member.id), true); assert.equal(light.workspace.isAdmin(member.id), false);
  assert.equal((await getWorkspaceContext(W._id, oid().toString(), { light: true })).status, 403, 'non-members are still refused with the light lookup');
  const ownerLight = await getWorkspaceContext(W._id, owner.id, { light: true }); assert.equal(ownerLight.workspace.isAdmin(owner.id), true, 'role checks work on the slice');
  await Channel.updateOne({ _id: general._id }, { $push: { members: { $each: filler.slice(0, 2000).concat([{ user: member.id, role: 'member' }]) } } });
  const channelLight = await getChannelContext(general._id, member.id, { light: true }); const channelFull = await getChannelContext(general._id, member.id);
  assert.equal(channelLight.channel.members.length, 1); assert.ok(channelFull.channel.members.length > 2000); assert.equal(channelLight.isChannelMember, true); assert.equal(channelLight.channel.name, 'general');
  assert.equal((await getChannelContext(general._id, oid().toString(), { light: true })).status, 403);
  console.log('ok - light membership lookups return one entry (3,001 → 1) with identical authorization results');

  // 3. Real routes still behave on the big workspace (history, send, react, mark-read).
  const m = ok(await call('/messages', { method: 'POST', token: member.token, body: { workspaceId: W._id, channelId: general._id, content: 'hello big workspace' } }), 201).message;
  ok(await call(`/messages/${m._id}/react`, { method: 'POST', token: member.token, body: { emoji: '👍' } })); ok(await call(`/channels/${general._id}/mark-read`, { method: 'PUT', token: member.token }));
  assert.equal((await call(`/messages/channel/${general._id}?limit=5`, { token: member.token })).status, 200);
  console.log('ok - routes work against 3,000-member workspace and 2,000-member channel');

  // 4. Thread participants are capped; replies keep counting.
  const full200 = Array.from({ length: 200 }, () => oid());
  await Message.updateOne({ _id: roots[0] }, { $set: { 'thread.participants': full200 } });
  const reply = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: W._id, channelId: general._id, content: 'one more', parentMessageId: roots[0].toString() } }), 201);
  const after = await Message.findById(roots[0]).lean();
  assert.equal(after.thread.participants.length, 200, 'participant list stays capped'); assert.equal(after.thread.replyCount, 1);
  assert.ok(reply.message._id);
  console.log('ok - thread participants capped at 200');

  // 4b. A thread response is bounded and says when it was cut.
  const parentForReplies = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: W._id, channelId: general._id, content: 'long thread' } }), 201).message;
  for (let i = 0; i < 8; i++) ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: W._id, channelId: general._id, content: `reply ${i}`, parentMessageId: parentForReplies._id } }), 201);
  const threadBody = ok(await call(`/messages/${parentForReplies._id}/thread`, { token: owner.token }));
  assert.equal(threadBody.replies.length, 5); assert.equal(threadBody.truncated, true); assert.equal(threadBody.replyCount, 8); assert.equal(threadBody.replies[0].content, 'reply 0', 'oldest replies first');
  console.log('ok - thread responses are bounded and flag truncation');

  // 5. Dead unbounded fields are gone; retention indexes exist.
  assert.equal('readBy' in Message.schema.paths, false);
  const indexes = async (model) => (await model.collection.indexes()).map((i) => i.name);
  assert.ok((await indexes(Notification)).includes('notification_retention')); assert.ok((await indexes(StoredAttachment)).includes('deleted_attachment_retention'));
  assert.ok((await indexes(Message)).some((n) => n.startsWith('channel_1_thread.parentMessage_1_createdAt_-1')));
  console.log('ok - retention TTL indexes and paging index present; readBy removed');
});
