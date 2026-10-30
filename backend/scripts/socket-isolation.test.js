// Socket.IO isolation tests. Runs against a throwaway database on a local MongoDB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const mongoose = require('mongoose');
const dbName = `unichat_socket_test_${crypto.randomBytes(6).toString('hex')}`;
Object.assign(process.env, {
  NODE_ENV: 'test', PORT: '0', MONGODB_URI: `mongodb://127.0.0.1:27017/${dbName}`,
  JWT_SECRET: crypto.randomBytes(48).toString('hex'), JWT_REFRESH_SECRET: crypto.randomBytes(48).toString('hex'),
  AUTO_JOIN_DEFAULT_WORKSPACE: 'false', REQUIRE_EMAIL_VERIFICATION: 'false', EMAIL_TRANSPORT: 'file', FILE_STORAGE: 'local',
  ADMIN_EMAIL: '', ADMIN_PASSWORD_HASH: '', REDIS_URL: '', TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: 'http://localhost:5173',
});
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

let base, port, counter = 0;
const sockets = [];
async function call(route, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${++counter % 250 + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const ok = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function register(name) {
  const body = ok(await call('/auth/register', { method: 'POST', body: { email: `${name}@example.test`, username: name, displayName: name, password: 'A memorable test passphrase 42!' } }), 201);
  return { id: body.user._id, token: body.accessToken, name };
}

async function open(user) {
  const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const seen = [];
  socket.onAny((event, payload) => seen.push({ event, payload }));
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  await sleep(250); // server joins authorized rooms asynchronously after connect
  return { socket, seen };
}
const emitAck = (socket, event, ...args) => new Promise((resolve) => socket.emit(event, ...args, resolve));
const messageEvents = (client, text) => client.seen.filter((entry) => entry.event.startsWith('message:') && JSON.stringify(entry.payload).includes(text));

async function run() {
  const { io, startServer } = require('../src/index');
  const Workspace = require('../src/models/Workspace');
  await startServer();
  port = io.httpServer.address().port;
  base = `http://127.0.0.1:${port}/api`;

  const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map(register));
  // Workspace membership is set directly; join/approval flows are covered elsewhere.
  const workspace = ok(await call('/workspaces', { method: 'POST', token: bob.token, body: { name: 'Isolation Co' } }), 201).workspace;
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: [{ user: alice.id, role: 'member' }, { user: carol.id, role: 'member' }, { user: dave.id, role: 'member' }] } });

  const privateChannel = ok(await call('/channels', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, name: 'secret', type: 'private', memberIds: [carol.id] } }), 201).channel;
  const dm = ok(await call('/dms', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, participantIds: [carol.id] } }), 201).dm;
  const group = ok(await call('/dms', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, participantIds: [carol.id, dave.id], isGroup: true, groupName: 'trio' } }), 201).dm;

  const a = await open(alice);
  const b = await open(bob);
  const c = await open(carol);
  const send = (token, target, text, extra = {}) => call('/messages', { method: 'POST', token, body: { workspaceId: workspace._id, content: text, ...target, ...extra } });

  // 1. Private channel, DM and group DM content never reaches a non-participant.
  ok(await send(bob.token, { channelId: privateChannel._id }, 'private-channel-secret'), 201);
  ok(await send(bob.token, { dmId: dm._id }, 'dm-secret'), 201);
  ok(await send(bob.token, { dmId: group._id }, 'group-secret'), 201);
  await sleep(400);
  for (const text of ['private-channel-secret', 'dm-secret']) assert.ok(messageEvents(c, text).length >= 1, `positive control: carol receives ${text}`);
  assert.ok(messageEvents(c, 'group-secret').length >= 1, 'positive control: carol receives group message');
  for (const text of ['private-channel-secret', 'dm-secret', 'group-secret']) assert.equal(messageEvents(a, text).length, 0, `alice must not receive ${text}`);
  assert.equal(JSON.stringify(a.seen).includes('secret'), false, 'no event with secret content reached alice');
  console.log('ok - private channel / DM / group DM isolation');

  // 2. A malicious client cannot subscribe or spoof rooms.
  assert.equal((await emitAck(a.socket, 'channel:join', privateChannel._id)).ok, false);
  assert.equal((await emitAck(a.socket, 'dm:join', dm._id)).ok, false);
  assert.equal((await emitAck(a.socket, 'dm:join', group._id)).ok, false);
  assert.equal((await emitAck(a.socket, 'workspace:join', new mongoose.Types.ObjectId().toString())).ok, false);
  assert.equal((await emitAck(a.socket, 'user:join', bob.id)).ok, false);
  const rootMessage = (await call(`/messages/channel/${privateChannel._id}`, { token: bob.token })).body.messages[0];
  assert.equal((await emitAck(a.socket, 'thread:join', rootMessage._id)).ok, false);
  a.socket.emit('typing:start', { roomType: 'channel', roomId: privateChannel._id });
  a.socket.emit('message:read', { channelId: privateChannel._id, messageId: rootMessage._id });
  await sleep(300);
  assert.equal(c.seen.filter((entry) => entry.event === 'typing:update' || entry.event === 'message:read_receipt').length, 0, 'spoofed typing/read events are not relayed');
  console.log('ok - unauthorized joins and spoofed room events rejected');

  // 3. A public channel's messages reach only members unless a workspace member explicitly (and legitimately) joins.
  const publicChannel = ok(await call('/channels', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, name: 'town-square' } }), 201).channel;
  ok(await send(bob.token, { channelId: publicChannel._id }, 'public-before-join'), 201);
  await sleep(300);
  assert.equal(messageEvents(a, 'public-before-join').length, 0, 'non-member does not receive unsolicited public channel messages');
  assert.equal(messageEvents(c, 'public-before-join').length, 0);
  console.log('ok - public channel delivery limited to joined sockets');

  // 4. Removal takes effect immediately on the live socket, and survives reconnecting.
  ok(await call(`/channels/${privateChannel._id}/invite`, { method: 'POST', token: bob.token, body: { userIds: [alice.id] } }));
  await sleep(300);
  ok(await send(bob.token, { channelId: privateChannel._id }, 'while-member'), 201);
  await sleep(300);
  assert.ok(messageEvents(a, 'while-member').length >= 1, 'alice receives messages while a member (no reconnect needed)');
  const thread = ok(await send(bob.token, { channelId: privateChannel._id }, 'thread-root'), 201).message;
  assert.equal((await emitAck(a.socket, 'thread:join', thread._id)).ok, true);
  ok(await send(bob.token, { channelId: privateChannel._id }, 'thread-while-member', { parentMessageId: thread._id }), 201);
  await sleep(300);
  assert.ok(messageEvents(a, 'thread-while-member').length >= 1);

  ok(await call(`/channels/${privateChannel._id}/members/${alice.id}`, { method: 'DELETE', token: bob.token }));
  await sleep(300);
  const before = a.seen.length;
  ok(await send(bob.token, { channelId: privateChannel._id }, 'after-removal'), 201);
  ok(await send(bob.token, { channelId: privateChannel._id }, 'thread-after-removal', { parentMessageId: thread._id }), 201);
  await sleep(400);
  assert.equal(JSON.stringify(a.seen.slice(before)).includes('after-removal'), false, 'removed user receives nothing further on the same socket');
  assert.equal(JSON.stringify(a.seen.slice(before)).includes('thread-after-removal'), false, 'removed user receives no thread replies');
  assert.equal((await send(alice.token, { channelId: privateChannel._id }, 'forbidden-write')).status, 403, 'removed user cannot send');
  assert.equal((await call(`/messages/channel/${privateChannel._id}`, { token: alice.token })).status, 403, 'removed user cannot read history');
  assert.equal((await emitAck(a.socket, 'channel:join', privateChannel._id)).ok, false);
  const a2 = await open(alice);
  ok(await send(bob.token, { channelId: privateChannel._id }, 'after-reconnect'), 201);
  await sleep(400);
  assert.equal(JSON.stringify(a2.seen).includes('after-reconnect'), false, 'reconnected removed user receives nothing');
  console.log('ok - removed member loses live access, cannot write, reconnect still denied');

  // 5. Multiple devices: leaving revokes every socket belonging to the user.
  ok(await call(`/channels/${privateChannel._id}/invite`, { method: 'POST', token: bob.token, body: { userIds: [carol.id] } }).catch(() => ({ status: 200, body: {} })));
  const c2 = await open(carol);
  ok(await call(`/channels/${privateChannel._id}/leave`, { method: 'POST', token: carol.token }));
  await sleep(300);
  ok(await send(bob.token, { channelId: privateChannel._id }, 'after-leave'), 201);
  await sleep(400);
  for (const device of [c, c2]) assert.equal(JSON.stringify(device.seen).includes('after-leave'), false, 'every device of a user who left is revoked');
  console.log('ok - leaving revokes all of a user\'s sockets');
}

run().then(() => { console.log('socket isolation tests passed'); return cleanup(0); }).catch((error) => { console.error(error); return cleanup(1); });
async function cleanup(code) {
  sockets.forEach((socket) => socket.disconnect());
  try { await mongoose.connection.dropDatabase(); } catch { /* database may not exist */ }
  process.exit(code);
}
