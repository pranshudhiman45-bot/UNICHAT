const { boot, assert } = require('./lib/harness');
const t = boot();
t.main(async ({ call, ok, register, sleep }) => {
  const Workspace = require('../src/models/Workspace');
  const User = require('../src/models/User');
  const PushDevice = require('../src/models/PushDevice');

  // Capture what would be sent to Expo; everything else passes through.
  const pushes = []; let expoReply = (messages) => ({ data: messages.map(() => ({ status: 'ok' })) });
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('exp.host')) { const messages = JSON.parse(init.body); pushes.push(...messages); return new Response(JSON.stringify(expoReply(messages)), { status: 200 }); }
    return realFetch(url, init);
  };

  const [alice, bob, carol] = [await register('alice'), await register('bob'), await register('carol')];
  const workspace = ok(await call('/workspaces', { method: 'POST', token: bob.token, body: { name: 'Push Co' } }), 201).workspace;
  await Workspace.updateOne({ _id: workspace._id }, { $push: { members: [{ user: alice.id, role: 'member' }, { user: carol.id, role: 'member' }] } });
  await User.updateMany({ _id: { $in: [alice.id, carol.id] } }, { 'notificationSettings.pushEnabled': true });
  const dmA = ok(await call('/dms', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, participantIds: [alice.id] } }), 201).dm;
  const dmC = ok(await call('/dms', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, participantIds: [carol.id] } }), 201).dm;
  const DEVICE = 'ExponentPushToken[shared-phone-1]';
  const say = async (dm, text) => { pushes.length = 0; ok(await call('/messages', { method: 'POST', token: bob.token, body: { workspaceId: workspace._id, dmId: dm._id, content: text } }), 201); await sleep(500); return [...pushes]; };

  // Registration validates tokens and binds to the user.
  assert.equal((await call('/users/push-token', { method: 'POST', token: alice.token, body: { token: 'not-a-token' } })).status, 400);
  ok(await call('/users/push-token', { method: 'POST', token: alice.token, body: { token: DEVICE, platform: 'ios' } }));
  assert.deepEqual((await say(dmA, 'hello alice')).map((p) => p.to), [DEVICE]);
  console.log('ok - token registered to alice receives her pushes');

  // Shared device: carol signs in on the same phone. Alice must stop receiving anything there.
  ok(await call('/users/push-token', { method: 'POST', token: carol.token, body: { token: DEVICE } }));
  assert.equal(await PushDevice.countDocuments({ token: DEVICE }), 1, 'one owner per token');
  assert.equal((await say(dmA, 'secret for alice')).length, 0, 'previous owner no longer reaches this device');
  assert.deepEqual((await say(dmC, 'hello carol')).map((p) => p.to), [DEVICE]);
  console.log('ok - token moves to the new account on a shared device');

  // Logout removes the device immediately (and only that session's devices).
  ok(await call('/users/push-token', { method: 'POST', token: alice.token, body: { token: 'ExponentPushToken[alice-own-phone]' } }));
  const aliceSecond = ok(await call('/auth/login', { method: 'POST', body: { email: 'alice@example.test', password: 'A memorable test passphrase 42!' } }));
  ok(await call('/users/push-token', { method: 'POST', token: aliceSecond.accessToken, body: { token: 'ExponentPushToken[alice-tablet]' } }));
  ok(await call('/auth/logout', { method: 'POST', token: aliceSecond.accessToken }));
  assert.deepEqual((await PushDevice.find({ user: alice.id }).lean()).map((d) => d.token), ['ExponentPushToken[alice-own-phone]'], 'only the logged-out session\'s device is removed');
  console.log('ok - logout unregisters that session\'s device');

  // Credential changes revoke every device.
  ok(await call('/users/password', { method: 'PUT', token: alice.token, body: { currentPassword: 'A memorable test passphrase 42!', newPassword: 'Another memorable passphrase 77!' } }));
  assert.equal(await PushDevice.countDocuments({ user: alice.id }), 0, 'password change revokes all push devices');
  console.log('ok - password change revokes all devices');

  // Expo says the token is dead -> it is removed.
  expoReply = (messages) => ({ data: messages.map(() => ({ status: 'error', details: { error: 'DeviceNotRegistered' } })) });
  await say(dmC, 'trigger cleanup');
  assert.equal(await PushDevice.countDocuments({ token: DEVICE }), 0, 'DeviceNotRegistered tokens are cleaned up');
  console.log('ok - invalid tokens cleaned up');
  global.fetch = realFetch;
});
