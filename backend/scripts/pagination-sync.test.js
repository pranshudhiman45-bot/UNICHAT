const path = require('node:path');
const { boot, assert } = require('./lib/harness');
const t = boot({ PRESENCE_GRACE_MS: '1500' });
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

t.main(async ({ call, ok, register, sleep, port }) => {
  const mongoose = require('mongoose');
  const Workspace = require('../src/models/Workspace');
  const Channel = require('../src/models/Channel');
  const Message = require('../src/models/Message');
  const User = require('../src/models/User');
  const [owner, reader, outsider] = [await register('owner'), await register('reader'), await register('outsider')];
  const workspace = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Paging' } }), 201).workspace;
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: [{ user: reader.id, role: 'member' }, { user: outsider.id, role: 'member' }] } });
  const channel = ok(await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, name: 'busy', type: 'private', memberIds: [reader.id] } }), 201).channel;

  // 5,200 messages; every third pair shares a timestamp to exercise the (createdAt,_id) cursor.
  await Message.deleteMany({ channel: channel._id });
  const TOTAL = 5200; const start = Date.now() - TOTAL * 1000;
  const docs = Array.from({ length: TOTAL }, (_, i) => ({ workspace: workspace._id, channel: channel._id, sender: owner.id, content: `m${i}`, createdAt: new Date(start + Math.floor(i / 3) * 1000), updatedAt: new Date(start + Math.floor(i / 3) * 1000) }));
  await Message.collection.insertMany(docs.map((d) => ({ ...d, workspace: new mongoose.Types.ObjectId(d.workspace), channel: new mongoose.Types.ObjectId(d.channel), sender: new mongoose.Types.ObjectId(d.sender), attachments: [], reactions: [], mentions: [], isDeleted: false, thread: { parentMessage: null, replyCount: 0, participants: [] } })));
  await Channel.updateOne({ _id: channel._id, 'members.user': reader.id }, { $set: { 'members.$.lastRead': new Date(start - 1000) } });
  const lastReadBefore = (await Channel.findById(channel._id)).members.find((m) => String(m.user) === reader.id).lastRead.getTime();

  const first = ok(await call(`/messages/channel/${channel._id}?limit=100`, { token: reader.token }));
  assert.equal(first.messages.length, 100); assert.equal(first.hasMore, true); assert.ok(first.nextCursor);
  assert.equal(first.messages.at(-1).content, `m${TOTAL - 1}`, 'initial load is the latest messages');
  // A message arrives while the user is scrolling back through history.
  ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: channel._id, content: 'arrived-mid-scroll' } }), 201);
  const seen = new Set(first.messages.map((m) => m._id)); let pages = 1; let cursor = first.nextCursor; let all = [...first.messages];
  while (cursor) {
    const page = ok(await call(`/messages/channel/${channel._id}?limit=100&before=${encodeURIComponent(cursor.before)}&beforeId=${cursor.beforeId}`, { token: reader.token }));
    for (const m of page.messages) { assert.ok(!seen.has(m._id), `duplicate ${m.content}`); seen.add(m._id); }
    all = [...page.messages, ...all]; cursor = page.nextCursor; pages++;
    if (page.hasMore) assert.ok(cursor); else assert.equal(cursor, null);
  }
  assert.equal(all.length, TOTAL, 'every message exactly once across pages'); assert.equal(pages, 52);
  assert.ok(all.every((m, i) => i === 0 || new Date(m.createdAt) >= new Date(all[i - 1].createdAt)), 'ascending order');
  assert.deepEqual(all.slice(0, 3).map((m) => m.content).sort(), ['m0', 'm1', 'm2']);
  assert.equal((await Message.countDocuments({ channel: channel._id })), TOTAL + 1, 'only the one late arrival was added');
  console.log('ok - 5,200 messages paged without duplicates or gaps (incl. shared timestamps, message arriving mid-scroll)');

  // Concurrent / rapid page requests give identical results.
  const burst = await Promise.all(Array.from({ length: 15 }, () => call(`/messages/channel/${channel._id}?limit=100&before=${encodeURIComponent(first.nextCursor.before)}&beforeId=${first.nextCursor.beforeId}`, { token: reader.token })));
  assert.equal(new Set(burst.map((r) => r.body.messages.map((m) => m._id).join())).size, 1);
  console.log('ok - rapid concurrent paging is consistent');

  // Reading history must not mark the channel read; only the explicit call does.
  const lastReadAfter = (await Channel.findById(channel._id)).members.find((m) => String(m.user) === reader.id).lastRead.getTime();
  assert.equal(lastReadAfter, lastReadBefore, 'fetching history left lastRead untouched');
  assert.equal(first.unreadCount, TOTAL, 'unread = messages the reader has not read (before the late arrival)');
  ok(await call(`/channels/${channel._id}/mark-read`, { method: 'PUT', token: reader.token }));
  assert.equal(ok(await call(`/messages/channel/${channel._id}?limit=1`, { token: reader.token })).unreadCount, 0);
  console.log('ok - history fetch does not mark read; explicit mark-read does');

  // Thread replies do not inflate channel unread counts.
  const root = (await Message.findOne({ channel: channel._id, content: 'arrived-mid-scroll' }));
  ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: channel._id, content: 'reply', parentMessageId: root._id } }), 201);
  assert.equal(ok(await call(`/messages/channel/${channel._id}?limit=1`, { token: reader.token })).unreadCount, 0);
  const listing = ok(await call(`/channels/workspace/${workspace._id}`, { token: reader.token })).channels.find((c) => c._id === channel._id);
  assert.equal(listing.unreadCount, 0);
  ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: channel._id, content: 'real unread' } }), 201);
  assert.equal(ok(await call(`/channels/workspace/${workspace._id}`, { token: reader.token })).channels.find((c) => c._id === channel._id).unreadCount, 1);
  console.log('ok - unread counts ignore thread replies');

  // Reconnect catch-up: new, edited, reacted and deleted messages since a checkpoint; authorization enforced.
  const checkpoint = new Date().toISOString(); await sleep(50);
  const created = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: channel._id, content: 'missed-new' } }), 201).message;
  const edited = (await Message.findOne({ channel: channel._id, content: 'real unread' }));
  ok(await call(`/messages/${edited._id}`, { method: 'PUT', token: owner.token, body: { content: 'missed-edit' } }));
  const doomed = ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: channel._id, content: 'will-delete' } }), 201).message;
  ok(await call(`/messages/${doomed._id}`, { method: 'DELETE', token: owner.token }));
  ok(await call(`/messages/${created._id}/react`, { method: 'POST', token: owner.token, body: { emoji: '👍' } }));
  const sync = ok(await call(`/messages/channel/${channel._id}/sync?since=${encodeURIComponent(checkpoint)}`, { token: reader.token }));
  const byId = new Map(sync.messages.map((m) => [m._id, m]));
  assert.equal(byId.get(created._id).reactions[0].users.length, 1); assert.equal(byId.get(created._id).content, 'missed-new');
  assert.equal(byId.get(String(edited._id)).content, 'missed-edit');
  assert.deepEqual(byId.get(doomed._id), { _id: doomed._id, isDeleted: true, channel: channel._id }, 'deleted messages sync as content-free tombstones');
  assert.equal(sync.truncated, false); assert.ok(sync.serverTime);
  assert.equal((await call(`/messages/channel/${channel._id}/sync?since=${checkpoint}`, { token: outsider.token })).status, 403);
  assert.equal((await call(`/messages/channel/${channel._id}/sync?since=garbage`, { token: reader.token })).status, 400);
  console.log('ok - sync returns missed new/edited/reacted/deleted; unauthorized denied');

  // Sockets: token refreshed in place (no disconnect), presence stable, chosen status preserved.
  process.env.JWT_EXPIRES_IN = '3s';
  const shortLived = ok(await call('/auth/refresh', { method: 'POST', body: { refreshToken: reader.refreshToken } }));
  process.env.JWT_EXPIRES_IN = '15m';
  const watcher = connect(`http://127.0.0.1:${port}`, { auth: { token: owner.token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const presence = []; watcher.on('user:presence_update', (p) => presence.push(p));
  await new Promise((resolve) => watcher.once('connect', resolve));
  await User.updateOne({ _id: reader.id }, { status: 'busy' });
  const sock = connect(`http://127.0.0.1:${port}`, { auth: { token: shortLived.accessToken }, transports: ['websocket'], reconnection: false, forceNew: true });
  const expiring = new Promise((resolve) => sock.once('auth:expiring', resolve));
  const events = []; let disconnected = false; sock.onAny((e, p) => events.push({ e, p })); sock.on('disconnect', () => { disconnected = true; });
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('connect_error', reject); });
  await sleep(300);
  assert.equal((await User.findById(reader.id)).status, 'busy', 'connecting must not overwrite a chosen status');
  await expiring;
  const renewed = ok(await call('/auth/refresh', { method: 'POST', body: { refreshToken: shortLived.refreshToken } }));
  const bad = await new Promise((resolve) => sock.emit('auth:refresh', { token: owner.token }, resolve));
  assert.equal(bad.ok, false, 'a token for a different user/session is rejected');
  const good = await new Promise((resolve) => sock.emit('auth:refresh', { token: renewed.accessToken }, resolve));
  assert.equal(good.ok, true);
  await sleep(3500);
  assert.equal(disconnected, false, 'socket survives past the original token expiry after in-place refresh');
  ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: workspace._id, channelId: channel._id, content: 'after-refresh' } }), 201);
  await sleep(300);
  assert.ok(events.some((x) => x.e === 'message:new' && x.p.content === 'after-refresh'), 'still receives messages after token refresh');
  console.log('ok - socket token refreshed in place; no reconnect, no lost messages');

  // Without a refresh the server closes the connection at expiry.
  process.env.JWT_EXPIRES_IN = '2s';
  const doomedToken = ok(await call('/auth/refresh', { method: 'POST', body: { refreshToken: renewed.refreshToken } }));
  process.env.JWT_EXPIRES_IN = '15m';
  const lapsing = connect(`http://127.0.0.1:${port}`, { auth: { token: doomedToken.accessToken }, transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((resolve) => lapsing.once('connect', resolve));
  await new Promise((resolve) => lapsing.once('disconnect', resolve));
  console.log('ok - un-refreshed socket is closed at expiry');

  // A quick reconnect inside the grace window never shows the user as offline to teammates.
  presence.length = 0;
  sock.disconnect();
  const again = connect(`http://127.0.0.1:${port}`, { auth: { token: renewed.accessToken }, transports: ['websocket'], reconnection: false, forceNew: true });
  await new Promise((resolve) => again.once('connect', resolve));
  await sleep(2500);
  assert.equal(presence.filter((p) => p.userId === reader.id && p.status === 'offline').length, 0, 'no offline flicker on quick reconnect');
  again.disconnect(); lapsing.disconnect();
  await sleep(2500);
  assert.ok(presence.some((p) => p.userId === reader.id && p.status === 'offline'), 'genuinely leaving does go offline');
  watcher.disconnect();
  console.log('ok - presence stable across reconnects');
});
