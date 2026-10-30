const path = require('node:path');
const { boot, assert } = require('./lib/harness');
const t = boot();
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const Channel = require('../src/models/Channel');
  const DirectMessage = require('../src/models/DirectMessage');
  const sockets = [];
  const open = async (user) => {
    const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true });
    const seen = []; socket.onAny((event, payload) => seen.push({ event, payload })); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    await sleep(250);
    return { socket, seen };
  };
  const names = ['owner', 'admin', 'm1', 'm2', 'm3', 'stranger'];
  const u = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await register(n)])));
  const W = ok(await call('/workspaces', { method: 'POST', token: u.owner.token, body: { name: 'Org Chart' } }), 201).workspace;
  const strangerWs = ok(await call('/workspaces', { method: 'POST', token: u.stranger.token, body: { name: 'Elsewhere' } }), 201).workspace;
  await Workspace.updateOne({ _id: W._id }, { $push: { members: ['admin', 'm1', 'm2', 'm3'].map((n) => ({ user: u[n].id, role: 'member' })) } });
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: u.owner.token })).channels.find((c) => c.name === 'general');
  await Channel.updateOne({ _id: general._id }, { $push: { members: ['admin', 'm1', 'm2', 'm3'].map((n) => ({ user: u[n].id, role: 'member' })) } });
  const roleOf = async (n) => (await Workspace.findById(W._id)).getMember(u[n].id)?.role;
  const as = (n) => u[n].token;

  // ---- Roles: only the owner changes them; no escalation paths. ----
  ok(await call(`/workspaces/${W._id}/members/${u.admin.id}/role`, { method: 'PUT', token: as('owner'), body: { role: 'admin' } }));
  assert.equal(await roleOf('admin'), 'admin');
  for (const [who, target, role] of [['admin', 'm1', 'admin'], ['m1', 'm1', 'admin'], ['admin', 'admin', 'member'], ['admin', 'owner', 'member']]) {
    assert.equal((await call(`/workspaces/${W._id}/members/${u[target].id}/role`, { method: 'PUT', token: as(who), body: { role } })).status, 403, `${who} cannot set ${target} -> ${role}`);
  }
  assert.equal((await call(`/workspaces/${W._id}/members/${u.owner.id}/role`, { method: 'PUT', token: as('owner'), body: { role: 'member' } })).status, 400, 'owner role cannot be reassigned directly');
  assert.equal((await call(`/workspaces/${W._id}/members/${u.m1.id}/role`, { method: 'PUT', token: as('owner'), body: { role: 'owner' } })).status, 400, 'cannot mint a second owner via role');
  assert.equal((await call(`/workspaces/${W._id}/members/${u.stranger.id}/role`, { method: 'PUT', token: as('owner'), body: { role: 'admin' } })).status, 404, 'non-members cannot be promoted');
  console.log('ok - role changes restricted to the owner; no escalation');

  // ---- Invite code visible only to admins. ----
  assert.equal(typeof ok(await call(`/workspaces/${W._id}`, { token: as('admin') })).workspace.inviteCode, 'string');
  assert.equal(ok(await call(`/workspaces/${W._id}`, { token: as('m1') })).workspace.inviteCode, undefined);
  assert.equal(ok(await call('/workspaces', { token: as('m1') })).workspaces.find((w) => w._id === W._id).inviteCode, undefined);
  console.log('ok - invite code hidden from ordinary members');

  // ---- Profile visibility follows shared workspaces. ----
  assert.equal((await call(`/users/profile/${u.owner.id}`, { token: as('m2') })).status, 200);
  assert.equal((await call(`/users/profile/${u.m2.id}`, { token: as('stranger') })).status, 404, 'no shared workspace -> not found');
  assert.equal((await call(`/users/profile/${u.stranger.id}`, { token: as('m2') })).status, 404);
  assert.equal((await call(`/users/profile/${u.stranger.id}`, { token: as('stranger') })).status, 200, 'own profile');
  assert.equal((await call('/users/profile/not-an-id', { token: as('m2') })).status, 404);
  assert.equal(JSON.stringify(ok(await call(`/users/profile/${u.owner.id}`, { token: as('m2') }))).includes('@example.test'), false, 'email is not exposed');
  console.log('ok - profile visibility');

  // ---- Group DM management. ----
  const group = ok(await call('/dms', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, participantIds: [u.m2.id, u.m3.id], isGroup: true, groupName: 'trio' } }), 201).dm;
  const m2s = await open(u.m2); const m3s = await open(u.m3); const adminS = await open(u.admin);
  ok(await call('/messages', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, dmId: group._id, content: 'history-before-join' } }), 201);
  assert.equal((await call(`/dms/${group._id}`, { method: 'PATCH', token: as('admin'), body: { groupName: 'hijack' } })).status, 403, 'non-participant cannot rename');
  assert.equal(ok(await call(`/dms/${group._id}`, { method: 'PATCH', token: as('m2'), body: { groupName: 'Project X' } })).dm.groupName, 'Project X');
  assert.equal((await call(`/dms/${group._id}/participants`, { method: 'POST', token: as('m1'), body: { userIds: [u.stranger.id] } })).status, 403, 'cannot add people from outside the workspace');
  ok(await call(`/dms/${group._id}/participants`, { method: 'POST', token: as('m2'), body: { userIds: [u.admin.id] } }));
  await sleep(300);
  assert.ok(adminS.seen.some((e) => e.event === 'dm:created'), 'added person is told about the group');
  assert.ok(ok(await call(`/dms/${group._id}/messages`, { token: as('admin') })).messages.some((m) => m.content === 'history-before-join'));
  ok(await call('/messages', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, dmId: group._id, content: 'live-to-new-member' } }), 201);
  await sleep(300);
  assert.ok(adminS.seen.some((e) => e.event === 'message:new' && e.payload.content === 'live-to-new-member'), 'added person receives live messages immediately');
  assert.equal((await call(`/dms/${group._id}/participants/${u.m3.id}`, { method: 'DELETE', token: as('m2') })).status, 403, 'only the creator removes others');
  ok(await call(`/dms/${group._id}/participants/${u.m3.id}`, { method: 'DELETE', token: as('m3') })); // m3 leaves
  await sleep(300);
  const before = m3s.seen.length;
  ok(await call('/messages', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, dmId: group._id, content: 'after-m3-left' } }), 201);
  await sleep(300);
  assert.equal(JSON.stringify(m3s.seen.slice(before)).includes('after-m3-left'), false, 'leaver\'s live socket loses the group');
  assert.equal((await call(`/dms/${group._id}/messages`, { token: as('m3') })).status, 403);
  assert.ok(m3s.seen.some((e) => e.event === 'dm:removed'));
  assert.equal((await call('/messages', { method: 'POST', token: as('m3'), body: { workspaceId: W._id, dmId: group._id, content: 'x' } })).status, 403);
  ok(await call(`/dms/${group._id}/participants/${u.admin.id}`, { method: 'DELETE', token: as('m1') })); // creator removes admin
  ok(await call(`/dms/${group._id}/me`, { method: 'PATCH', token: as('m2'), body: { isMuted: true, isArchived: true } }));
  const listed = ok(await call(`/dms?workspaceId=${W._id}`, { token: as('m2') })).dms.find((d) => d._id === group._id);
  assert.equal(listed.isMuted, true); assert.equal(listed.isArchived, true);
  console.log('ok - group DM rename/add/leave/remove/mute with live room membership');

  // ---- Channel admin safety. ----
  const priv = ok(await call('/channels', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, name: 'council', type: 'private', memberIds: [u.m2.id, u.m3.id] } }), 201).channel;
  const reload = async () => Channel.findById(priv._id);
  assert.equal((await call(`/channels/${priv._id}/leave`, { method: 'POST', token: as('m1') })).status, 409, 'sole admin cannot leave while others remain');
  assert.equal((await call(`/channels/${priv._id}/members/${u.m1.id}/role`, { method: 'PUT', token: as('m1'), body: { role: 'member' } })).status, 409, 'cannot demote the last admin');
  assert.equal((await call(`/channels/${priv._id}/members/${u.m2.id}/role`, { method: 'PUT', token: as('m3'), body: { role: 'admin' } })).status, 403, 'ordinary member cannot promote');
  assert.equal((await call(`/channels/${priv._id}`, { token: as('admin') })).status, 403, 'workspace admin is not automatically a member of a private channel');
  assert.equal((await call(`/channels/${priv._id}/invite`, { method: 'POST', token: as('admin'), body: { userIds: [u.admin.id] } })).status, 403, '...and cannot add themselves to it');
  assert.equal((await call(`/channels/${priv._id}`, { method: 'PATCH', token: as('owner'), body: { name: 'taken-over' } })).status, 403, '...even the workspace owner');
  ok(await call(`/channels/${priv._id}/members/${u.m2.id}/role`, { method: 'PUT', token: as('m1'), body: { role: 'admin' } }));
  // Both admins leave at the same moment: exactly one may succeed.
  const both = await Promise.all([call(`/channels/${priv._id}/leave`, { method: 'POST', token: as('m1') }), call(`/channels/${priv._id}/leave`, { method: 'POST', token: as('m2') })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], JSON.stringify(both.map((r) => r.body)));
  assert.ok((await reload()).members.some((m) => m.role === 'admin'), 'a private channel is never left without an admin');
  assert.equal((await call(`/channels/${priv._id}/members/${(await reload()).members.find((m) => m.role === 'admin').user}`, { method: 'DELETE', token: as('m3') })).status, 403);
  console.log('ok - channel admin invariants hold, including under a concurrent leave');

  // ---- Workspace-admin rights on public channels, join/leave, archive/restore, live events. ----
  const pub = ok(await call('/channels', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, name: 'water-cooler' } }), 201).channel;
  assert.equal(ok(await call(`/channels/${pub._id}`, { method: 'PATCH', token: as('admin'), body: { topic: 'set by workspace admin' } })).channel.topic, 'set by workspace admin', 'workspace admin manages public channels without joining');
  assert.equal((await call(`/channels/${pub._id}`, { method: 'PATCH', token: as('m3'), body: { topic: 'nope' } })).status, 403);
  assert.equal((await call(`/channels/${pub._id}/join`, { method: 'POST', token: as('stranger') })).status, 404, 'cannot join channels of another workspace');
  const m3Chan = await open(u.m3);
  ok(await call(`/channels/${pub._id}/join`, { method: 'POST', token: as('m3') }));
  assert.equal((await call(`/channels/${pub._id}/join`, { method: 'POST', token: as('m3') })).status, 409);
  ok(await call('/messages', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, channelId: pub._id, content: 'joined-live' } }), 201);
  await sleep(300);
  assert.ok(m3Chan.seen.some((e) => e.event === 'message:new' && e.payload.content === 'joined-live'), 'joining takes effect on the live socket without reconnect');
  const inviteeS = await open(u.m2);
  ok(await call(`/channels/${pub._id}/invite`, { method: 'POST', token: as('m1'), body: { userIds: [u.m2.id, u.m2.id] } }));
  await sleep(300);
  assert.ok(inviteeS.seen.some((e) => e.event === 'channel:invited'));
  ok(await call(`/channels/${pub._id}/members/${u.m3.id}`, { method: 'DELETE', token: as('m1') }));
  await sleep(300);
  assert.ok(m3Chan.seen.some((e) => e.event === 'channel:removed'), 'removed user is notified');
  ok(await call(`/channels/${pub._id}`, { method: 'DELETE', token: as('m1') }));
  assert.equal((await call(`/channels/${pub._id}/join`, { method: 'POST', token: as('m3') })).status, 403, 'cannot join an archived channel');
  assert.equal(ok(await call(`/channels/${pub._id}`, { method: 'PATCH', token: as('m1'), body: { isArchived: false } })).channel.isArchived, false, 'archived channel can be restored');
  assert.equal((await call(`/channels/${general._id}/leave`, { method: 'POST', token: as('m2') })).status, 400);
  assert.equal((await call(`/channels/${general._id}/members/${u.m2.id}`, { method: 'DELETE', token: as('owner') })).status, 400, 'default channel membership is not removable');
  console.log('ok - public channel management, live join/invite/remove events, archive and restore');

  // ---- Workspace member removal cleans up everything and revokes live access. ----
  const m1Live = await open(u.m1);
  ok(await call('/channels', { method: 'POST', token: as('m1'), body: { workspaceId: W._id, name: 'only-m1-admin', type: 'private', memberIds: [u.m3.id] } }), 201);
  const onlyM1 = await Channel.findOne({ workspace: W._id, name: 'only-m1-admin' });
  assert.equal((await call(`/workspaces/${W._id}/members/${u.m1.id}`, { method: 'DELETE', token: as('m2') })).status, 403, 'members cannot remove members');
  assert.equal((await call(`/workspaces/${W._id}/members/${u.admin.id}`, { method: 'DELETE', token: as('admin') })).status, 400, 'use leave instead');
  assert.equal((await call(`/workspaces/${W._id}/members/${u.owner.id}`, { method: 'DELETE', token: as('admin') })).status, 403, 'nobody removes the owner');
  assert.equal((await call(`/workspaces/${W._id}/members/${u.owner.id}`, { method: 'DELETE', token: as('owner') })).status, 400);
  const adminTriesAdmin = await call(`/workspaces/${W._id}/members/${u.owner.id}/role`, { method: 'PUT', token: as('admin'), body: { role: 'member' } });
  assert.equal(adminTriesAdmin.status, 403);
  ok(await call(`/workspaces/${W._id}/members/${u.m1.id}`, { method: 'DELETE', token: as('admin') }));
  await sleep(400);
  assert.ok(m1Live.seen.some((e) => e.event === 'workspace:removed'));
  const mark = m1Live.seen.length;
  ok(await call('/messages', { method: 'POST', token: as('owner'), body: { workspaceId: W._id, channelId: general._id, content: 'after-m1-removed' } }), 201);
  await sleep(300);
  assert.equal(JSON.stringify(m1Live.seen.slice(mark)).includes('after-m1-removed'), false, 'removed member\'s live socket gets nothing');
  assert.equal((await call(`/workspaces/${W._id}`, { token: as('m1') })).status, 403);
  assert.equal((await call(`/channels/workspace/${W._id}`, { token: as('m1') })).status, 403);
  assert.equal((await call(`/users/profile/${u.owner.id}`, { token: as('m1') })).status, 404, 'removed member loses profile visibility too');
  const repaired = await Channel.findById(onlyM1._id);
  assert.equal(repaired.members.some((m) => String(m.user) === u.m1.id), false);
  assert.ok(repaired.members.some((m) => m.role === 'admin'), 'channel the removed member administered still has an admin');
  assert.equal((await DirectMessage.findById(group._id)).participants.some((p) => String(p) === u.m1.id), false, 'removed from group DMs');
  console.log('ok - member removal revokes access everywhere and repairs channel admins');

  // ---- Leaving and ownership transfer. ----
  assert.equal((await call(`/workspaces/${W._id}/leave`, { method: 'POST', token: as('owner') })).status, 409, 'the last owner cannot leave');
  assert.equal((await call(`/workspaces/${W._id}/transfer-ownership`, { method: 'POST', token: as('admin'), body: { userId: u.admin.id, confirmName: 'Org Chart' } })).status, 400, 'admins cannot take ownership');
  assert.equal((await call(`/workspaces/${W._id}/transfer-ownership`, { method: 'POST', token: as('owner'), body: { userId: u.stranger.id, confirmName: 'Org Chart' } })).status, 400, 'target must be a member');
  assert.equal((await call(`/workspaces/${W._id}/transfer-ownership`, { method: 'POST', token: as('owner'), body: { userId: u.admin.id, confirmName: 'wrong' } })).status, 400, 'requires typing the workspace name');
  ok(await call(`/workspaces/${W._id}/transfer-ownership`, { method: 'POST', token: as('owner'), body: { userId: u.admin.id, confirmName: 'Org Chart' } }));
  const after = await Workspace.findById(W._id);
  assert.equal(String(after.owner), u.admin.id); assert.equal(await roleOf('admin'), 'owner'); assert.equal(await roleOf('owner'), 'admin');
  assert.equal(after.members.filter((m) => m.role === 'owner').length, 1, 'exactly one owner');
  assert.equal((await call(`/workspaces/${W._id}/members/${u.m2.id}/role`, { method: 'PUT', token: as('owner'), body: { role: 'admin' } })).status, 403, 'former owner lost owner powers');
  ok(await call(`/workspaces/${W._id}/leave`, { method: 'POST', token: as('owner') }));
  assert.equal(await roleOf('owner'), undefined);
  assert.equal((await call(`/channels/workspace/${W._id}`, { token: as('owner') })).status, 403);
  void strangerWs; sockets.forEach((s) => s.disconnect());
  console.log('ok - ownership transfer is atomic; leaving works; last owner protected');
});
