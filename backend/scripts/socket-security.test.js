const path = require('node:path');
const { boot, assert } = require('./lib/harness');
const t = boot();
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));
// Any uncaught exception here would be a server crash (the server runs in this process).
let crashed = null; process.on('uncaughtException', (error) => { crashed = error; console.error('UNCAUGHT', error); }); process.on('unhandledRejection', (error) => { crashed = error; console.error('UNHANDLED', error); });

const EVENTS = ['user:join', 'workspace:join', 'workspace:leave', 'channel:join', 'channel:leave', 'dm:join', 'dm:leave', 'thread:join', 'thread:leave', 'typing:start', 'typing:stop', 'presence:update', 'message:read', 'auth:refresh', 'definitely:not-an-event'];
const BAD = [null, undefined, 0, 1, -1, NaN, true, false, '', 'x'.repeat(10000), [], [[[[]]]], {}, { $ne: null }, { $gt: '' }, { roomType: { $ne: null }, roomId: { $ne: null } }, { roomType: 'channel', roomId: { $ne: null } },
  { channelId: { $ne: null }, messageId: { $ne: null } }, { status: { $ne: 'x' } }, { token: { $ne: null } }, { __proto__: { polluted: true } }, JSON.parse('{"__proto__":{"polluted":true}}'), '507f1f77bcf86cd799439011', { a: 'b'.repeat(100000) }];

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const [owner, mallory] = [await register('owner'), await register('mallory')];
  const W = ok(await call('/workspaces', { method: 'POST', token: owner.token, body: { name: 'Sec' } }), 201).workspace;
  await Workspace.updateOne({ _id: W._id }, { $push: { members: { user: mallory.id, role: 'member' } } });
  const priv = ok(await call('/channels', { method: 'POST', token: owner.token, body: { workspaceId: W._id, name: 'private-one', type: 'private' } }), 201).channel;
  const open = async (user) => { const s = connect(`http://127.0.0.1:${port}`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true }); const seen = []; s.onAny((e, p) => seen.push({ e, p })); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); await sleep(250); return { s, seen }; };

  const attacker = await open(mallory); const victim = await open(owner);

  // 1. Malformed payloads for every event, with a function ack, with no ack, and with a bogus ack.
  let sent = 0;
  for (const event of EVENTS) for (const payload of BAD) {
    attacker.s.emit(event, payload); attacker.s.emit(event, payload, () => {}); attacker.s.emit(event, payload, 'not-a-function', 42);
    sent += 3;
    if (sent % 150 === 0) await sleep(1200); // stay under the flood limiter so we exercise the handlers themselves
  }
  await sleep(1500);
  assert.equal(crashed, null, 'no malformed event may raise an uncaught exception'); 
  assert.equal(({}).polluted, undefined, 'prototype pollution attempt had no effect');
  assert.equal((await call('/auth/me', { token: owner.token })).status, 200, 'server still serving');
  console.log(`ok - ${sent} malformed events across ${EVENTS.length} event names: server unaffected`);

  // 2. Operator-injection ids never widen a join.
  const ack = (s, event, ...args) => new Promise((resolve) => s.emit(event, ...args, resolve));
  const fresh = await open(mallory);
  for (const injected of [{ $ne: null }, { $gt: '' }, [priv._id], { $in: [priv._id] }, `${priv._id} `, priv._id.toUpperCase().slice(0, 23)]) {
    for (const event of ['channel:join', 'dm:join', 'thread:join', 'workspace:join']) { const reply = await ack(fresh.s, event, injected); assert.equal(reply?.ok, false, `${event} ${JSON.stringify(injected)}`); }
  }
  ok(await call('/messages', { method: 'POST', token: owner.token, body: { workspaceId: W._id, channelId: priv._id, content: 'top-secret' } }), 201); await sleep(400);
  assert.equal(JSON.stringify(fresh.seen).includes('top-secret'), false, 'injection did not grant access to a private channel');
  assert.equal((await ack(fresh.s, 'channel:join', priv._id)).ok, false, 'a legitimate-looking id is still refused to a non-member');
  console.log('ok - NoSQL-operator and malformed ids cannot be used to join rooms');

  // 3. Read receipts and typing cannot be forged into rooms the sender is not in, nor for foreign messages.
  const msg = (await call(`/messages/channel/${priv._id}`, { token: owner.token })).body.messages.at(-1);
  victim.seen.length = 0;
  attacker.s.emit('message:read', { channelId: priv._id, messageId: msg._id }); attacker.s.emit('typing:start', { roomType: 'channel', roomId: priv._id });
  await sleep(500);
  assert.equal(victim.seen.filter((x) => ['message:read_receipt', 'typing:update'].includes(x.e)).length, 0);
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: owner.token })).channels.find((c) => c.name === 'general');
  ok(await call(`/channels/${general._id}/invite`, { method: 'POST', token: owner.token, body: { userIds: [mallory.id] } }).catch(() => ({ status: 200, body: {} })));
  const memberOfGeneral = await open(mallory); const generalWatcher = await open(owner);
  generalWatcher.seen.length = 0;
  memberOfGeneral.s.emit('message:read', { channelId: general._id, messageId: msg._id }); // msg belongs to the private channel, not general
  await sleep(500);
  assert.equal(generalWatcher.seen.filter((x) => x.e === 'message:read_receipt').length, 0, 'a receipt for a message from another room is not relayed');
  console.log('ok - read receipts / typing cannot be spoofed across rooms');

  // 4. Flooding is throttled and persistent abuse disconnects the socket; legitimate pacing is untouched.
  const flooder = await open(mallory); let limited = 0; let disconnected = false; flooder.s.on('disconnect', () => { disconnected = true; });
  const replies = []; for (let i = 0; i < 700; i++) flooder.s.emit('channel:join', priv._id, (r) => replies.push(r));
  await sleep(1500);
  limited = replies.filter((r) => r?.error === 'Too many requests').length;
  assert.ok(limited >= 250, `flood should be mostly dropped (limited ${limited})`);
  assert.equal(disconnected, true, 'a socket that keeps flooding is disconnected');
  const calm = await open(mallory); for (let i = 0; i < 8; i++) { assert.ok((await ack(calm.s, 'channel:join', priv._id)).error !== 'Too many requests'); await sleep(120); }
  assert.equal(crashed, null);
  [attacker, victim, fresh, memberOfGeneral, generalWatcher, calm].forEach((c) => c.s.disconnect());
  console.log('ok - floods throttled, abusers disconnected, normal use unaffected');
});
