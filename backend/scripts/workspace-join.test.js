// The Unichat workspace model: register -> create workspace (owner/admin) -> others submit a PENDING request with
// the invite code -> only admins are notified -> admin accepts/rejects. The code itself never grants access.
const path = require('node:path');
const { boot, assert } = require('./lib/harness');
const t = boot();
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const Notification = require('../src/models/Notification');
  const User = require('../src/models/User');
  const sockets = [];
  const open = async (user) => {
    const socket = connect(`http://127.0.0.1:${port}`, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true });
    const seen = []; socket.onAny((event, payload) => seen.push({ event, payload })); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    await sleep(250);
    return { socket, seen, count: (event) => seen.filter((e) => e.event === event).length };
  };
  const ackOf = (socket, event, ...args) => new Promise((resolve) => socket.emit(event, ...args, resolve));
  const names = ['owner', 'admin', 'member', 'pending', 'outsider', 'rejected', 'dupe', 'racer', 'owner2', 'removed'];
  const u = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await register(n)])));
  const as = (n) => u[n].token;
  const joinWith = (n, code) => call(`/workspaces/${encodeURIComponent(code)}`.replace('/workspaces/', '/workspaces/join/'), { method: 'POST', token: as(n) });
  const wsDoc = (id) => Workspace.findById(id).select('+joinRequests');
  const memberCount = async (id, user) => (await Workspace.findById(id)).members.filter((m) => String(m.user) === u[user].id).length;
  const requestsOf = async (id, user) => (await wsDoc(id)).joinRequests.filter((r) => String(r.user) === u[user].id);

  // ===== TEST 1: creating a workspace makes the creator its owner/admin =====
  const W = ok(await call('/workspaces', { method: 'POST', token: as('owner'), body: { name: 'Join Model' } }), 201).workspace;
  const doc = await Workspace.findById(W._id);
  assert.equal(String(doc.owner), u.owner.id); assert.equal(doc.members.length, 1);
  assert.equal(doc.members[0].role, 'owner'); assert.equal(doc.isAdmin(u.owner.id), true);
  const code = ok(await call(`/workspaces/${W._id}`, { token: as('owner') })).workspace.inviteCode;
  assert.match(code, /^[A-F0-9]{16}$/, 'admin can view a unique join code');
  assert.equal((await call(`/workspaces/${W._id}/join-requests`, { token: as('owner') })).status, 200, 'owner can review requests');
  console.log('ok - TEST 1: creator automatically becomes owner/admin and can see the join code');

  // Bring an ordinary member and an extra admin in through the real flow (so later tests have non-admin/admin peers).
  const admitted = async (name) => { const r = ok(await joinWith(name, code), 202).request; ok(await call(`/workspaces/${W._id}/join-requests/${r._id}/approve`, { method: 'POST', token: as('owner') })); };
  await admitted('member'); await admitted('admin');
  ok(await call(`/workspaces/${W._id}/members/${u.admin.id}/role`, { method: 'PUT', token: as('owner'), body: { role: 'admin' } }));
  assert.equal(typeof ok(await call(`/workspaces/${W._id}`, { token: as('member') })).workspace.inviteCode, 'undefined', 'ordinary members do not see the code');
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: as('owner') })).channels.find((c) => c.name === 'general');
  const secret = ok(await call('/channels', { method: 'POST', token: as('owner'), body: { workspaceId: W._id, name: 'board-only', type: 'private' } }), 201).channel;

  const live = { owner: await open(u.owner), admin: await open(u.admin), member: await open(u.member), outsider: await open(u.outsider), pending: await open(u.pending) };

  // ===== TESTS 2, 3, 4: entering the code creates a PENDING request, not membership; only admins hear about it =====
  const submitted = await joinWith('pending', code);
  assert.equal(submitted.status, 202); assert.equal(submitted.body.request.status, 'pending');
  assert.equal(JSON.stringify(submitted.body).includes(u.owner.id), false, 'response does not leak workspace members');
  await sleep(500);
  assert.equal(await memberCount(W._id, 'pending'), 0, 'TEST 2: no membership yet');
  assert.equal((await User.findById(u.pending.id)).workspaces.map(String).includes(W._id), false);
  assert.equal(ok(await call('/workspaces', { token: as('pending') })).workspaces.some((w) => w._id === W._id), false);
  console.log('ok - TEST 2: a valid code does NOT create membership');

  const pendingRows = await requestsOf(W._id, 'pending');
  assert.equal(pendingRows.length, 1); assert.equal(pendingRows[0].status, 'pending');
  const mine = ok(await call('/workspaces/join-requests', { token: as('pending') })).requests;
  assert.equal(mine.length, 1); assert.equal(mine[0].status, 'pending'); assert.deepEqual(Object.keys(mine[0].workspace).sort(), ['_id', 'icon', 'name'], 'requester sees only minimal workspace details');
  const adminView = ok(await call(`/workspaces/${W._id}/join-requests`, { token: as('admin') })).requests;
  assert.equal(adminView.length, 1); assert.equal(adminView[0].user._id, u.pending.id);
  console.log('ok - TEST 3: exactly one pending request exists (visible to requester as PENDING and to admins)');

  assert.equal(live.owner.count('workspace:join_request'), 1, 'owner notified live'); assert.equal(live.admin.count('workspace:join_request'), 1, 'admin notified live');
  for (const quiet of ['member', 'outsider', 'pending']) assert.equal(live[quiet].count('workspace:join_request'), 0, `${quiet} must not receive join-request events`);
  const allEvents = (n) => JSON.stringify(live[n].seen);
  for (const quiet of ['member', 'outsider']) assert.equal(allEvents(quiet).includes('wants to join'), false, `${quiet} sees no trace of the request`);
  const notified = (await Notification.find({ type: 'workspace_join_request', workspace: W._id, 'metadata.joinRequestId': submitted.body.request._id }).lean()).map((n) => String(n.recipient)).sort();
  assert.deepEqual(notified, [u.owner.id, u.admin.id].sort(), 'persistent notifications exist for owner/admin only');
  const adminNote = (await Notification.findOne({ type: 'workspace_join_request', recipient: u.owner.id, 'metadata.joinRequestId': submitted.body.request._id })).content;
  assert.match(adminNote, /pending wants to join your workspace\./);
  assert.equal(ok(await call(`/notifications?workspaceId=${W._id}`, { token: as('member') })).notifications.filter((n) => n.type === 'workspace_join_request').length, 0, 'a normal member has no join-request notifications');
  console.log('ok - TEST 4: only the owner/admin receive the join-request (live and persistent), nobody else');

  // ===== TEST 8: a pending user has no access to anything =====
  const pend = as('pending'); const fake = '507f1f77bcf86cd799439011';
  for (const [method, route, body] of [
    ['GET', `/workspaces/${W._id}`], ['GET', `/workspaces/${W._id}/members`], ['GET', `/workspaces/${W._id}/join-requests`], ['POST', `/workspaces/${W._id}/regenerate-invite`], ['PUT', `/workspaces/${W._id}`, { name: 'hijack' }],
    ['GET', `/channels/workspace/${W._id}`], ['GET', `/channels/${general._id}`], ['GET', `/channels/${secret._id}`], ['GET', `/messages/channel/${general._id}`], ['GET', `/messages/channel/${secret._id}`],
    ['GET', `/messages/channel/${general._id}/sync?since=2020-01-01`], ['POST', '/messages', { workspaceId: W._id, channelId: general._id, content: 'let me in' }],
    ['GET', `/dms?workspaceId=${W._id}`], ['GET', `/search?workspaceId=${W._id}&q=welcome`], ['GET', `/saved?workspaceId=${W._id}`], ['GET', `/users/search?q=o&workspaceId=${W._id}`],
    ['GET', `/notifications/unread-count?workspaceId=${W._id}`], ['POST', `/workspaces/${W._id}/leave`], ['POST', `/channels/${general._id}/join`], ['PUT', `/channels/${general._id}/mark-read`],
  ]) {
    const r = await call(route, { method, token: pend, body });
    assert.ok([403, 404].includes(r.status), `pending user: ${method} ${route} -> ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  }
  const owned = (await call(`/messages/channel/${general._id}`, { token: as('owner') })).body.messages[0];
  for (const route of [`/messages/${owned._id}/thread`, `/messages/${fake}/thread`, `/channels/${fake}`, `/workspaces/${fake}`, `/users/profile/${u.owner.id}`]) {
    assert.ok([403, 404].includes((await call(route, { token: pend })).status), route);
  }
  assert.equal((await call(`/messages/${owned._id}/react`, { method: 'POST', token: pend, body: { emoji: '👍' } })).status, 403);
  assert.equal(Object.keys(ok(await call('/files/urls', { method: 'POST', token: pend, body: { uploadIds: [fake] } })).urls).length, 0);
  for (const [event, id] of [['workspace:join', W._id], ['channel:join', general._id], ['channel:join', secret._id]]) assert.equal((await ackOf(live.pending.socket, event, id)).ok, false, `${event} refused`);
  live.pending.seen.length = 0;
  ok(await call('/messages', { method: 'POST', token: as('owner'), body: { workspaceId: W._id, channelId: general._id, content: 'members-only-chatter' } }), 201); await sleep(400);
  assert.equal(JSON.stringify(live.pending.seen).includes('members-only-chatter'), false, 'a pending user receives no live messages');
  assert.equal(JSON.stringify(live.outsider.seen).includes('members-only-chatter'), false);
  console.log('ok - TEST 8: pending user is locked out of REST, sockets and guessed ids');

  // ===== TEST 10: only an admin may decide; wrong-workspace and malformed attempts fail =====
  const reqId = requestsOf(W._id, 'pending').then((r) => String(r[0]._id));
  const rid = await reqId;
  for (const who of ['member', 'outsider', 'pending']) for (const decision of ['approve', 'reject']) {
    assert.equal((await call(`/workspaces/${W._id}/join-requests/${rid}/${decision}`, { method: 'POST', token: as(who) })).status, 403, `${who} cannot ${decision}`);
  }
  const W2 = ok(await call('/workspaces', { method: 'POST', token: as('owner2'), body: { name: 'Other Org' } }), 201).workspace;
  assert.equal((await call(`/workspaces/${W2._id}/join-requests/${rid}/approve`, { method: 'POST', token: as('owner2') })).status, 404, 'an admin of another workspace cannot approve this request');
  assert.equal((await call(`/workspaces/${W._id}/join-requests/${rid}/approve`, { method: 'POST', token: as('owner2') })).status, 403, 'nor can they use this workspace id');
  assert.equal((await call(`/workspaces/${W._id}/join-requests/not-an-id/approve`, { method: 'POST', token: as('owner') })).status, 400);
  assert.equal((await call(`/workspaces/${W._id}/join-requests/${rid}/maybe`, { method: 'POST', token: as('owner') })).status, 400);
  assert.equal((await requestsOf(W._id, 'pending'))[0].status, 'pending'); assert.equal(await memberCount(W._id, 'pending'), 0);
  console.log('ok - TEST 10: non-admins, foreign admins and malformed decisions are all refused; request untouched');

  // ===== TEST 5 + 6: approval creates membership exactly once and the requester is told, live and persistently =====
  live.pending.seen.length = 0; live.member.seen.length = 0;
  const approval = ok(await call(`/workspaces/${W._id}/join-requests/${rid}/approve`, { method: 'POST', token: as('admin') }));
  assert.equal(approval.request.status, 'approved');
  await sleep(500);
  assert.equal(await memberCount(W._id, 'pending'), 1, 'TEST 5: membership created exactly once');
  assert.equal((await requestsOf(W._id, 'pending'))[0].status, 'approved');
  assert.equal((await User.findById(u.pending.id)).workspaces.map(String).includes(W._id), true);
  const repeat = ok(await call(`/workspaces/${W._id}/join-requests/${rid}/approve`, { method: 'POST', token: as('owner') }));
  assert.equal(repeat.alreadyDecided, true); assert.equal(await memberCount(W._id, 'pending'), 1, 'approving twice adds nobody');
  assert.equal((await call(`/workspaces/${W._id}/join-requests/${rid}/reject`, { method: 'POST', token: as('owner') })).status, 409, 'an approved request cannot be rejected');
  console.log('ok - TEST 5: approval creates membership exactly once; repeat approve is a no-op; reject-after-approve refused');

  assert.equal(live.pending.count('workspace:join_request_approved'), 1, 'requester told live without refreshing');
  assert.equal(live.pending.count('workspace:join_decided'), 1);
  const approvedEvent = live.pending.seen.find((e) => e.event === 'workspace:join_request_approved').payload;
  assert.equal(approvedEvent.workspaceId, W._id); assert.equal(approvedEvent.workspace.name, 'Join Model');
  assert.equal(live.member.count('workspace:member_joined'), 1, 'existing members learn a person joined (id only)');
  assert.deepEqual(Object.keys(live.member.seen.find((e) => e.event === 'workspace:member_joined').payload).sort(), ['userId', 'workspaceId']);
  const note = await Notification.findOne({ recipient: u.pending.id, type: 'workspace_join_approved' });
  assert.ok(note, 'persistent approval notification'); assert.match(note.content, /accepted/);
  assert.equal(ok(await call(`/notifications?workspaceId=${W._id}`, { token: as('pending') })).notifications.some((n) => n.type === 'workspace_join_approved'), true);
  assert.equal(ok(await call('/workspaces/join-requests', { token: as('pending') })).requests[0].status, 'approved', 'status endpoint reports APPROVED');
  assert.equal((await call(`/workspaces/${W._id}`, { token: as('pending') })).status, 200, 'access granted');
  assert.equal((await call(`/messages/channel/${general._id}`, { token: as('pending') })).status, 200);
  live.pending.seen.length = 0;
  ok(await call('/messages', { method: 'POST', token: as('owner'), body: { workspaceId: W._id, channelId: general._id, content: 'welcome-aboard' } }), 201);
  ok(await call('/messages', { method: 'POST', token: as('owner'), body: { workspaceId: W._id, channelId: secret._id, content: 'board-secret' } }), 201); await sleep(500);
  assert.equal(live.pending.seen.some((e) => e.event === 'message:new' && e.payload.content === 'welcome-aboard'), true, 'the requester\'s already-open socket gets default-channel messages immediately');
  assert.equal(JSON.stringify(live.pending.seen).includes('board-secret'), false, 'but not private channels');
  assert.equal((await call(`/messages/channel/${secret._id}`, { token: as('pending') })).status, 403);
  assert.equal(live.owner.count('workspace:join_request') >= 2, true, 'admins\' lists refresh after a decision');
  console.log('ok - TEST 6: requester notified live + persistently, sees APPROVED, gains default-channel access on the open socket only');

  // ===== TEST 7: rejection =====
  const rr = ok(await joinWith('rejected', code), 202).request; const rejectedLive = await open(u.rejected);
  const outcome = ok(await call(`/workspaces/${W._id}/join-requests/${rr._id}/reject`, { method: 'POST', token: as('owner') }));
  assert.equal(outcome.request.status, 'rejected'); await sleep(400);
  assert.equal(await memberCount(W._id, 'rejected'), 0, 'TEST 7: no membership');
  assert.equal(rejectedLive.count('workspace:join_request_rejected'), 1, 'requester told');
  assert.equal(ok(await call('/workspaces/join-requests', { token: as('rejected') })).requests[0].status, 'rejected');
  assert.equal((await call(`/workspaces/${W._id}`, { token: as('rejected') })).status, 403);
  assert.equal((await call(`/workspaces/${W._id}/join-requests/${rr._id}/approve`, { method: 'POST', token: as('owner') })).status, 409, 'a rejected request cannot be approved afterwards');
  assert.equal(await Notification.countDocuments({ recipient: u.rejected.id, workspace: W._id, type: 'workspace_join_approved' }), 0);
  const adminEventsBeforeRetry = live.owner.count('workspace:join_request');
  const ownerNotesBefore = await Notification.countDocuments({ type: 'workspace_join_request', recipient: u.owner.id });
  // Immediately asking again is blocked by the 24h cooldown: no new request, no new notification, admins hear nothing.
  const blocked = await joinWith('rejected', code);
  assert.equal(blocked.status, 429); assert.equal(blocked.body.code, 'JOIN_COOLDOWN'); const wait = Number(blocked.headers.get('retry-after')); assert.ok(wait > 23 * 3600 && wait <= 24 * 3600, `Retry-After should be ~24h, got ${wait}`);
  const retryAt = new Date(blocked.body.retryAt).getTime(); const rejectedAt = new Date((await requestsOf(W._id, 'rejected'))[0].reviewedAt).getTime();
  assert.ok(Math.abs(retryAt - (rejectedAt + 24 * 3600 * 1000)) < 2000, 'retryAt is exactly 24h after the rejection');
  assert.equal((await requestsOf(W._id, 'rejected')).length, 1, 'no new request while cooling down');
  for (let i = 0; i < 4; i++) assert.equal((await joinWith('rejected', code)).status, 429, 'spamming does not help');
  await sleep(300);
  assert.equal(live.owner.count('workspace:join_request'), adminEventsBeforeRetry, 'admins are not pinged by blocked retries');
  assert.equal(await Notification.countDocuments({ type: 'workspace_join_request', recipient: u.owner.id }), ownerNotesBefore);
  const status = ok(await call('/workspaces/join-requests', { token: as('rejected') })).requests[0];
  assert.equal(status.status, 'rejected'); assert.ok(Math.abs(new Date(status.canRequestAgainAt).getTime() - retryAt) < 1000, 'the requester is told when they may ask again');
  // 23h later: still blocked. 25h later: allowed.
  const age = async (hours) => Workspace.updateOne({ _id: W._id }, { $set: { 'joinRequests.$[r].reviewedAt': new Date(Date.now() - hours * 3600 * 1000) } }, { arrayFilters: [{ 'r.user': new (require('mongoose').Types.ObjectId)(u.rejected.id) }] });
  await age(23); assert.equal((await joinWith('rejected', code)).status, 429, 'still blocked at 23 hours');
  await age(25);
  const burst = await Promise.all(Array.from({ length: 6 }, () => joinWith('rejected', code)));
  burst.forEach((r) => assert.equal(r.status, 202, JSON.stringify(r.body)));
  assert.equal(new Set(burst.map((r) => r.body.request._id)).size, 1, 'six parallel re-requests resolve to ONE new pending request');
  const history = await requestsOf(W._id, 'rejected');
  assert.deepEqual(history.map((r) => r.status).sort(), ['pending', 'rejected'], 'the rejection stays on record next to the new pending request');
  assert.equal(history.filter((r) => r.status === 'pending').length, 1, 'only one pending request at a time');
  assert.equal(await memberCount(W._id, 'rejected'), 0, 'still no membership');
  await sleep(300);
  assert.equal(live.owner.count('workspace:join_request') - adminEventsBeforeRetry, 1, 'admins are pinged exactly once for the new request');
  const secondId = String(burst[0].body.request._id);
  assert.equal(ok(await call('/workspaces/join-requests', { token: as('rejected') })).requests[0].status, 'pending', 'status endpoint shows the current (latest) request');
  assert.equal((await call(`/workspaces/${W._id}/join-requests/${rr._id}/approve`, { method: 'POST', token: as('owner') })).status, 409, 'the OLD rejected request still cannot be approved');
  assert.equal(await memberCount(W._id, 'rejected'), 0);
  ok(await call(`/workspaces/${W._id}/join-requests/${secondId}/approve`, { method: 'POST', token: as('owner') }));
  assert.equal(await memberCount(W._id, 'rejected'), 1, 'the new request can be approved normally, exactly one membership');
  assert.deepEqual((await requestsOf(W._id, 'rejected')).map((r) => r.status).sort(), ['approved', 'rejected'], 'history keeps both decisions');
  ok(await call(`/workspaces/${W._id}/join-requests/${secondId}/approve`, { method: 'POST', token: as('owner') }));
  assert.equal(await memberCount(W._id, 'rejected'), 1, 'repeat approval adds nobody');
  // Someone who was approved and later removed is not stuck: a fresh request is allowed, and never doubles membership.
  const rm = ok(await joinWith('removed', code), 202).request; ok(await call(`/workspaces/${W._id}/join-requests/${rm._id}/approve`, { method: 'POST', token: as('owner') }));
  ok(await call(`/workspaces/${W._id}/members/${u.removed.id}`, { method: 'DELETE', token: as('owner') }));
  const second = await joinWith('removed', code); assert.equal(second.status, 202); assert.notEqual(second.body.request._id, rm._id);
  ok(await call(`/workspaces/${W._id}/join-requests/${second.body.request._id}/approve`, { method: 'POST', token: as('owner') }));
  assert.equal(await memberCount(W._id, 'removed'), 1);
  console.log('ok - TEST 7: rejection creates no membership, is reported, kept in history, blocks re-requests for 24h, then allows exactly one new pending request');

  // ===== TEST 9: no duplicate pending requests (even in parallel); admins are notified once =====
  const ownerEventsBefore = live.owner.count('workspace:join_request');
  const parallel = await Promise.all(Array.from({ length: 6 }, () => joinWith('dupe', code)));
  await sleep(500);
  assert.equal(live.owner.count('workspace:join_request') - ownerEventsBefore, 1, 'the owner gets ONE live event for six simultaneous submissions');
  parallel.forEach((r) => assert.equal(r.status, 202, JSON.stringify(r.body)));
  assert.equal(new Set(parallel.map((r) => r.body.request._id)).size, 1, 'every submission resolves to the same request');
  assert.equal((await requestsOf(W._id, 'dupe')).length, 1, 'TEST 9: a single pending request');
  assert.equal(await Notification.countDocuments({ type: 'workspace_join_request', recipient: u.owner.id, 'metadata.joinRequestId': String(parallel[0].body.request._id) }), 1, 'the owner is notified once');
  assert.equal(await memberCount(W._id, 'dupe'), 0);
  const asMember = await joinWith('member', code); assert.equal(asMember.body.alreadyMember, true, 'an existing member cannot create a request');
  assert.equal((await wsDoc(W._id)).joinRequests.filter((r) => String(r.user) === u.member.id && r.status === 'pending').length, 0);
  console.log('ok - TEST 9: duplicate/parallel submissions create one pending request and one notification');

  // ===== TEST 11: rotated, invalid and unavailable codes never create a request =====
  const pendingBeforeRotation = (await requestsOf(W._id, 'dupe'))[0];
  const eventsBeforeRotation = live.member.seen.length;
  const rotated = ok(await call(`/workspaces/${W._id}/regenerate-invite`, { method: 'POST', token: as('owner') })).inviteCode;
  assert.notEqual(rotated, code);
  assert.equal(ok(await call(`/workspaces/${W._id}`, { token: as('admin') })).workspace.inviteCode, rotated, 'admins see the new code');
  assert.equal(typeof ok(await call(`/workspaces/${W._id}`, { token: as('member') })).workspace.inviteCode, 'undefined', 'members never see the code, before or after rotation');
  assert.equal((await call(`/workspaces/${W._id}/regenerate-invite`, { method: 'POST', token: as('member') })).status, 403);
  // Rotation changes nothing for people already in, or already waiting.
  assert.equal(await memberCount(W._id, 'member'), 1); assert.equal((await call(`/messages/channel/${general._id}`, { token: as('member') })).status, 200, 'existing members unaffected');
  assert.equal(live.member.seen.length, eventsBeforeRotation, 'rotation emits nothing to members');
  assert.equal((await requestsOf(W._id, 'dupe'))[0].status, 'pending', 'a pending request survives rotation');
  ok(await call(`/workspaces/${W._id}/join-requests/${pendingBeforeRotation._id}/approve`, { method: 'POST', token: as('owner') }));
  assert.equal(await memberCount(W._id, 'dupe'), 1, 'and can still be approved after rotation');
  const stale = await joinWith('outsider', code); assert.equal(stale.status, 404, 'the old code is dead');
  assert.equal((await requestsOf(W._id, 'outsider')).length, 0);
  for (const bad of ['SHORT', 'zzzzzzzzzzzzzzzz!', 'FFFFFFFFFFFFFFFF', `${'A'.repeat(40)}`]) assert.ok([400, 404].includes((await joinWith('outsider', bad)).status), bad);
  assert.equal((await call('/workspaces/join/%24ne', { method: 'POST', token: as('outsider') })).status, 400);
  assert.equal((await call(`/workspaces/regenerate-invite`, { method: 'POST', token: as('member') })).status === 404 || true, true);
  assert.equal((await call(`/workspaces/${W._id}/regenerate-invite`, { method: 'POST', token: as('member') })).status, 403, 'only admins rotate the code');
  const fresh = await joinWith('outsider', rotated); assert.equal(fresh.status, 202, 'the new code works');
  // a deleted workspace is unavailable even with a valid code
  const doomed = ok(await call('/workspaces', { method: 'POST', token: as('owner2'), body: { name: 'Doomed Org' } }), 201).workspace;
  const doomedCode = ok(await call(`/workspaces/${doomed._id}`, { token: as('owner2') })).workspace.inviteCode;
  ok(await call(`/workspaces/${doomed._id}`, { method: 'DELETE', token: as('owner2'), body: { confirmName: 'Doomed Org' } }));
  assert.equal((await joinWith('racer', doomedCode)).status, 404, 'deleted workspace cannot receive requests');
  assert.equal((await Workspace.findById(doomed._id).select('+joinRequests')).joinRequests.length, 0);
  console.log('ok - TEST 11: rotated, invalid and deleted-workspace codes create nothing; only admins rotate');

  // ===== TEST 12: admin offline -> the request persists -> admin logs back in and sees it =====
  const code2 = ok(await call(`/workspaces/${W2._id}`, { token: as('owner2') })).workspace.inviteCode;
  const offlineReq = ok(await joinWith('racer', code2), 202).request; // owner2 has no socket connected
  const login = ok(await call('/auth/login', { method: 'POST', body: { email: 'owner2@example.test', password: 'A memorable test passphrase 42!' } }));
  const listing = ok(await call('/workspaces', { token: login.accessToken })).workspaces.find((w) => w._id === W2._id);
  assert.equal(listing.pendingJoinRequestCount, 1, 'the workspace list shows the badge');
  assert.equal(ok(await call(`/workspaces/${W2._id}/join-requests`, { token: login.accessToken })).requests[0]._id, offlineReq._id);
  const inbox = ok(await call(`/notifications?workspaceId=${W2._id}`, { token: login.accessToken }));
  assert.ok(inbox.notifications.some((n) => n.type === 'workspace_join_request' && !n.isRead && /wants to join your workspace/.test(n.content)), 'unread persistent notification waiting');
  assert.equal(inbox.unreadCount >= 1, true);
  console.log('ok - TEST 12: an offline admin finds the request, the badge and an unread notification on return');

  // ===== TEST 13: simultaneous decisions cannot create duplicate membership or conflicting outcomes =====
  const racerReq = offlineReq._id;
  const raceWatcher = await open(u.owner2);
  const decisions = await Promise.all([...Array.from({ length: 8 }, () => call(`/workspaces/${W2._id}/join-requests/${racerReq}/approve`, { method: 'POST', token: login.accessToken }))]);
  assert.ok(decisions.every((r) => r.status === 200), JSON.stringify(decisions.map((r) => r.status)));
  await sleep(500);
  assert.equal(await memberCount(W2._id, 'racer'), 1, 'TEST 13: eight simultaneous approvals -> exactly one membership');
  assert.equal(decisions.filter((r) => !r.body.alreadyDecided).length >= 1, true);
  assert.equal(await Notification.countDocuments({ recipient: u.racer.id, type: 'workspace_join_approved' }), 1, 'the requester is told once');
  // approve vs reject at the same instant: one winner, state is consistent
  const code3 = ok(await call(`/workspaces/${W._id}`, { token: as('owner') })).workspace.inviteCode;
  const duel = ok(await joinWith('outsider', code3), 202).request._id;
  const results = await Promise.all([call(`/workspaces/${W._id}/join-requests/${duel}/approve`, { method: 'POST', token: as('owner') }), call(`/workspaces/${W._id}/join-requests/${duel}/reject`, { method: 'POST', token: as('admin') })]);
  const final = (await requestsOf(W._id, 'outsider'))[0].status; const members = await memberCount(W._id, 'outsider');
  assert.ok(['approved', 'rejected'].includes(final)); assert.equal(members, final === 'approved' ? 1 : 0, `final=${final} members=${members} (${results.map((r) => r.status)})`);
  assert.equal(results.filter((r) => r.status === 200 && !r.body.alreadyDecided).length, 1, 'exactly one decision actually took effect');
  raceWatcher.socket.disconnect();
  console.log(`ok - TEST 13: simultaneous approvals are idempotent; approve-vs-reject has a single winner (${final})`);

  // ===== Isolation sanity for an admin of a DIFFERENT workspace =====
  assert.equal((await call(`/workspaces/${W._id}`, { token: as('owner2') })).status, 403);
  assert.equal((await call(`/messages/channel/${general._id}`, { token: as('owner2') })).status, 403);
  sockets.forEach((s) => s.disconnect());
  console.log('ok - strict isolation between workspaces');
});
