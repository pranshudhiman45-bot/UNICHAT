// Read-only hostile probe: logs in as many different attackers against a throwaway instance and tries to reach
// data/actions they must not. It reports; it does not assert. Run:  node scripts/security-probe.js
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { boot } = require('./lib/harness');
const t = boot({ ADMIN_EMAIL: 'root@probe.example', ADMIN_PASSWORD_HASH: bcrypt.hashSync(crypto.randomBytes(12).toString('hex'), 12), WEB_PUSH_PUBLIC_KEY: 'BPublicKeyPlaceholderForProbe', WEB_PUSH_PRIVATE_KEY: 'privateplaceholder', WEB_PUSH_SUBJECT: 'mailto:probe@example.com' });
const { io: connect } = require(path.resolve(__dirname, '../../web/node_modules/socket.io-client'));
const captured = [];
for (const stream of [process.stdout, process.stderr]) { const write = stream.write.bind(stream); stream.write = (chunk, ...rest) => { captured.push(String(chunk)); return write(chunk, ...rest); }; }
const findings = []; let passes = 0;
const finding = (severity, text) => { findings.push({ severity, text }); console.log(`FINDING ${severity.padEnd(8)} ${text}`); };
const pass = () => { passes++; };

t.main(async ({ call, ok, register, sleep, port }) => {
  const Workspace = require('../src/models/Workspace');
  const User = require('../src/models/User');
  const WebPushSubscription = require('../src/models/WebPushSubscription');
  const names = ['alice', 'bob', 'carol', 'dave', 'eve', 'removed', 'pending', 'frank'];
  const u = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await register(n)])));
  const as = (n) => u[n].token;
  const admit = async (n, code, W, admin = 'alice') => { const r = ok(await call(`/workspaces/join/${code}`, { method: 'POST', token: as(n) }), 202).request; ok(await call(`/workspaces/${W}/join-requests/${r._id}/approve`, { method: 'POST', token: as(admin) })); };

  // ---- world ------------------------------------------------------------------------------------------------------
  const W1 = ok(await call('/workspaces', { method: 'POST', token: as('alice'), body: { name: 'Probe One' } }), 201).workspace._id;
  const code = ok(await call(`/workspaces/${W1}`, { token: as('alice') })).workspace.inviteCode;
  for (const n of ['bob', 'carol', 'removed', 'frank']) await admit(n, code, W1);
  ok(await call(`/workspaces/${W1}/members/${u.removed.id}`, { method: 'DELETE', token: as('alice') }));
  ok(await call(`/workspaces/join/${code}`, { method: 'POST', token: as('pending') }), 202);
  const W2 = ok(await call('/workspaces', { method: 'POST', token: as('dave'), body: { name: 'Probe Two' } }), 201).workspace._id;
  const general = ok(await call(`/channels/workspace/${W1}`, { token: as('alice') })).channels.find((c) => c.name === 'general')._id;
  const P1 = ok(await call('/channels', { method: 'POST', token: as('alice'), body: { workspaceId: W1, name: 'secret-room', type: 'private', memberIds: [u.bob.id] } }), 201).channel._id;
  const send = async (who, body) => ok(await call('/messages', { method: 'POST', token: as(who), body: { workspaceId: W1, ...body } }), 201).message;
  const m1 = await send('alice', { channelId: P1, content: 'p1-secret' });
  const reply = await send('bob', { channelId: P1, content: 'p1-secret-reply', parentMessageId: m1._id });
  const dm = ok(await call('/dms', { method: 'POST', token: as('alice'), body: { workspaceId: W1, participantIds: [u.bob.id] } }), 201).dm._id;
  const dmMsg = await send('alice', { dmId: dm, content: 'dm-secret' });
  const group = ok(await call('/dms', { method: 'POST', token: as('alice'), body: { workspaceId: W1, participantIds: [u.bob.id, u.frank.id], isGroup: true, groupName: 'trio' } }), 201).dm._id;
  const gMsg = await send('alice', { dmId: group, content: 'group-secret' });
  const gen = await send('alice', { channelId: general, content: 'general-chat' });
  const w2Chan = ok(await call(`/channels/workspace/${W2}`, { token: as('dave') })).channels[0]._id;
  const w2Msg = ok(await call('/messages', { method: 'POST', token: as('dave'), body: { workspaceId: W2, channelId: w2Chan, content: 'w2-secret' } }), 201).message;
  const deleted = await send('alice', { channelId: general, content: 'deleted-secret' });
  ok(await call(`/messages/${deleted._id}`, { method: 'DELETE', token: as('alice') }));
  // attachment inside the private channel
  const form = new FormData(); form.append('workspaceId', W1); form.append('channelId', P1);
  form.append('files', new Blob([Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(32)])], { type: 'application/pdf' }), 'p1.pdf');
  const up = await (await fetch(`http://127.0.0.1:${port}/api/files/upload`, { method: 'POST', headers: { authorization: `Bearer ${as('alice')}`, 'x-forwarded-for': '198.51.100.250' }, body: form })).json();
  const att = up.attachments[0].uploadId;
  const attMsg = await send('alice', { channelId: P1, content: 'p1-secret-file', attachmentIds: [att] });
  const markers = ['p1-secret', 'dm-secret', 'group-secret', 'w2-secret', 'deleted-secret'];
  const run = async (who, method, route, body) => call(route, { method, token: as(who), body });
  const scan = (res) => markers.find((m) => JSON.stringify(res.body).includes(m));

  // ---- 1. IDOR matrix: every attacker x every resource route ------------------------------------------------------
  const resourceRoutes = (attacker) => [
    ['GET', `/channels/${P1}`], ['GET', `/channels/${P1}/pins`], ['POST', `/channels/${P1}/join`], ['POST', `/channels/${P1}/leave`], ['PUT', `/channels/${P1}/mark-read`],
    ['POST', `/channels/${P1}/invite`, { userIds: [u[attacker].id] }], ['PATCH', `/channels/${P1}`, { name: 'owned' }], ['PUT', `/channels/${P1}`, { name: 'owned' }], ['DELETE', `/channels/${P1}`],
    ['DELETE', `/channels/${P1}/members/${u.bob.id}`], ['PUT', `/channels/${P1}/members/${u[attacker].id}/role`, { role: 'admin' }],
    ['GET', `/messages/channel/${P1}`], ['GET', `/messages/channel/${P1}?limit=100&before=2099-01-01`], ['GET', `/messages/channel/${P1}/sync?since=2020-01-01`],
    ['POST', '/messages', { workspaceId: W1, channelId: P1, content: 'injected' }], ['POST', '/messages', { workspaceId: W1, channelId: P1, content: 'injected', parentMessageId: m1._id }],
    ...[m1._id, reply._id, attMsg._id].flatMap((id) => [['GET', `/messages/${id}/thread`], ['GET', `/messages/thread/${id}`], ['PUT', `/messages/${id}`, { content: 'tampered' }], ['DELETE', `/messages/${id}`], ['POST', `/messages/${id}/react`, { emoji: '👍' }], ['DELETE', `/messages/${id}/react`, { emoji: '👍' }], ['POST', `/messages/${id}/pin`], ['DELETE', `/messages/${id}/pin`], ['POST', `/messages/${id}/forward`, { channelId: general }], ['POST', '/saved', { workspaceId: W1, messageId: id }], ['POST', '/starred', { workspaceId: W1, messageId: id }]]),
    ['GET', `/dms/${dm}/messages`], ['GET', `/dms/${dm}/sync?since=2020-01-01`], ['PUT', `/dms/${dm}/mark-read`], ['PATCH', `/dms/${dm}/me`, { isMuted: true }],
    ['GET', `/dms/${group}/messages`], ['PATCH', `/dms/${group}`, { groupName: 'owned' }], ['POST', `/dms/${group}/participants`, { userIds: [u[attacker].id] }], ['DELETE', `/dms/${group}/participants/${u.bob.id}`],
    ['POST', '/messages', { workspaceId: W1, dmId: dm, content: 'injected' }], ['POST', '/messages', { workspaceId: W1, dmId: group, content: 'injected' }],
    ['POST', `/messages/${dmMsg._id}/react`, { emoji: '👍' }], ['GET', `/messages/${dmMsg._id}/thread`], ['PUT', `/messages/${gMsg._id}`, { content: 'tampered' }], ['DELETE', `/messages/${gMsg._id}`],
    ['POST', '/files/urls', { uploadIds: [att] }], ['GET', `/search?workspaceId=${W1}&q=secret`], ['GET', `/search?workspaceId=${W1}&q=secret&channelId=${P1}`], ['GET', `/saved?workspaceId=${W1}`], ['GET', `/starred?workspaceId=${W1}`],
    ['GET', `/users/profile/${u.alice.id}`], ['GET', `/users/search?q=a&workspaceId=${W1}`], ['GET', `/notifications?workspaceId=${W1}`], ['GET', `/notifications/unread-count?workspaceId=${W1}`], ['GET', `/notifications/preferences?workspaceId=${W1}`], ['PATCH', '/notifications/preferences', { workspaceId: W1, level: 'all' }],
    ['GET', `/workspaces/${W1}`], ['GET', `/workspaces/${W1}/members`], ['GET', `/channels/workspace/${W1}`], ['GET', `/dms?workspaceId=${W1}`], ...(attacker === 'carol' ? [] : [['POST', `/workspaces/${W1}/leave`]]),
    ['GET', `/workspaces/${W1}/join-requests`], ['POST', `/workspaces/${W1}/regenerate-invite`], ['PUT', `/workspaces/${W1}`, { name: 'owned' }], ['PATCH', `/workspaces/${W1}`, { name: 'owned' }], ['DELETE', `/workspaces/${W1}`, { confirmName: 'Probe One' }],
    ['PUT', `/workspaces/${W1}/members/${u.bob.id}/role`, { role: 'admin' }], ['DELETE', `/workspaces/${W1}/members/${u.bob.id}`], ['POST', `/workspaces/${W1}/transfer-ownership`, { userId: u[attacker].id, confirmName: 'Probe One' }],
  ];
  const insiderOk = new Set(['carol']); // carol IS a workspace member: general workspace reads are legitimate for her
  for (const attacker of ['carol', 'dave', 'eve', 'removed', 'pending']) {
    for (const [method, route, body] of resourceRoutes(attacker)) {
      const res = await run(attacker, method, route, body);
      const label = `${attacker}: ${method} ${route.replace(/[a-f0-9]{24}/g, (id) => ({ [W1]: 'W1', [W2]: 'W2', [P1]: 'P1', [dm]: 'DM', [group]: 'GROUP', [m1._id]: 'm1', [reply._id]: 'reply', [attMsg._id]: 'attMsg', [dmMsg._id]: 'dmMsg', [gMsg._id]: 'gMsg', [general]: 'general', [att]: 'att' }[id] || id.slice(0, 6)))}`;
      if (res.status >= 500) { finding('MEDIUM', `${label} -> ${res.status} (server error on hostile input)`); continue; }
      if (res.status >= 200 && res.status < 300) {
        const leaked = scan(res);
        if (leaked) { finding('CRITICAL', `${label} -> ${res.status} LEAKED "${leaked}"`); continue; }
        const legitimateForCarol = attacker === 'carol' && (/^(GET) \/(workspaces\/[^/]+(\/members)?|channels\/workspace\/|dms\?|saved|starred|notifications|users\/)/.test(`${method} ${route.replace(W1, '')}`) || route.includes(`/workspaces/${W1}`) && method === 'GET' && !route.includes('join-requests') || route.startsWith('/channels/workspace/') || route.startsWith('/dms?') || route.startsWith('/search') || route.startsWith('/users/') || route.startsWith('/notifications') || route.startsWith('/saved') || route.startsWith('/starred') || route === '/files/urls' || route.startsWith('/workspaces/') && route.endsWith('/leave'));
        const emptyUrls = route === '/files/urls' && Object.keys(res.body.urls || {}).length === 0;
        if (emptyUrls || legitimateForCarol && !insiderMutation(method, route)) { pass(); continue; }
        finding(attacker === 'carol' ? 'HIGH' : 'CRITICAL', `${label} -> ${res.status} (state-changing or privileged request SUCCEEDED for a non-entitled user)`);
      } else pass();
    }
  }
  function insiderMutation(method, route) { return method !== 'GET' && !route.endsWith('/leave') && !route.includes('mark-read') && !route.includes('/notifications/preferences'); }
  const intact = await Workspace.findById(W1);
  if (String(intact.owner) !== u.alice.id || intact.name !== 'Probe One' || intact.deletedAt) finding('CRITICAL', 'workspace owner/name/deletion state changed during the IDOR matrix');
  else pass();
  console.log(`  IDOR matrix done: ${passes} denied-or-empty responses`);

  // ---- 2. deleted data stays unreachable -------------------------------------------------------------------------------
  for (const [who, route] of [['alice', `/messages/${deleted._id}/thread`], ['alice', `/messages/channel/${general}`], ['alice', `/search?workspaceId=${W1}&q=deleted-secret`], ['bob', `/saved?workspaceId=${W1}`]]) {
    const r = await run(who, 'GET', route); if (scan(r) === 'deleted-secret') finding('HIGH', `deleted message content reachable via GET ${route.replace(/[a-f0-9]{24}/g, 'ID')}`); else pass();
  }
  const edit = await run('alice', 'PUT', `/messages/${deleted._id}`, { content: 'resurrect' }); if (edit.status < 400) finding('HIGH', 'a deleted message can be edited back to life'); else pass();

  // ---- 3. invite code exposure -----------------------------------------------------------------------------------------
  for (const who of ['bob', 'carol', 'removed', 'pending', 'dave']) for (const route of ['/workspaces', `/workspaces/${W1}`, `/workspaces/${W1}/members`, '/workspaces/join-requests', `/channels/workspace/${W1}`, `/notifications?workspaceId=${W1}`]) {
    const r = await run(who, 'GET', route); if (JSON.stringify(r.body).includes(code)) finding('HIGH', `${who}: GET ${route.replace(W1, 'W1')} exposes the workspace invite code`); else pass();
  }
  const memberSock = connect(`http://127.0.0.1:${port}`, { auth: { token: as('bob') }, transports: ['websocket'], reconnection: false, forceNew: true });
  const bobSeen = []; memberSock.onAny((e, p) => bobSeen.push({ e, p })); await new Promise((r) => memberSock.once('connect', r)); await sleep(300);
  ok(await call(`/workspaces/${W1}`, { method: 'PUT', token: as('alice'), body: { description: 'trigger workspace:updated' } })); await run('alice', 'POST', `/workspaces/${W1}/regenerate-invite`); await sleep(400);
  if (JSON.stringify(bobSeen).match(/[A-F0-9]{16}/) && JSON.stringify(bobSeen).includes('inviteCode')) finding('HIGH', 'a socket event carries the invite code to an ordinary member'); else pass();
  memberSock.disconnect();

  // ---- 4. admin-only surface for non-admins ---------------------------------------------------------------------------
  for (const [method, route, body] of [['GET', '/admin/dashboard'], ['GET', '/admin/workspaces'], ['GET', '/admin/users'], ['GET', '/admin/password-resets'], ['GET', '/admin/recovery-settings'], ['GET', '/admin/audit-logs'], ['GET', '/admin/security'], ['DELETE', `/admin/workspaces/${W1}`], ['POST', `/admin/workspaces/${W1}/restore`], ['PATCH', `/admin/users/${u.bob.id}`, { accountStatus: 'disabled' }], ['PATCH', '/admin/recovery-settings', {}], ['POST', `/admin/password-resets/${W1}/approve`]])
    for (const who of ['alice', 'bob', 'eve']) { const r = await run(who, method, route, body); if (r.status < 400) finding('CRITICAL', `${who} reached admin endpoint ${method} ${route}`); else pass(); }
  const noToken = await fetch(`http://127.0.0.1:${port}/api/admin/dashboard`, { headers: { 'x-forwarded-for': '198.51.100.201' } }); if (noToken.status < 400) finding('CRITICAL', 'unauthenticated access to /admin'); else pass();
  // a user promoted to SUPER_ADMIN in the database who is not the configured admin cannot use the role
  await User.updateOne({ _id: u.eve.id }, { role: 'SUPER_ADMIN' }); const sneaky = await run('eve', 'GET', '/admin/dashboard'); if (sneaky.status < 400) finding('HIGH', 'role flag alone grants admin access'); else pass(); await User.updateOne({ _id: u.eve.id }, { role: 'USER' });

  // ---- 5. NoSQL operator injection through query strings and bodies ---------------------------------------------------
  const injections = [`workspaceId[$ne]=x`, `workspaceId[$gt]=`, `channelId[$ne]=x`, `q[$ne]=x`, `before[$gt]=`, `limit[$gt]=1`, `filter[$ne]=x`, `cursor[$ne]=x`, `since[$ne]=x`, `senderId[$ne]=x`, `hasAttachments[$ne]=x`, `skip[$ne]=1`, `page[$ne]=1`];
  for (const qs of injections) for (const base of ['/messages/channel/' + general, '/channels/workspace/' + W1, '/dms', '/search', '/saved', '/starred', '/notifications', '/notifications/unread-count', '/users/search', `/workspaces/${W1}/members`, `/dms/${dm}/messages`]) {
    for (const who of ['dave', 'carol']) {
      const r = await run(who, 'GET', `${base}${base.includes('?') ? '&' : '?'}${qs}&workspaceId=${W1}`.replace(`workspaceId=${W1}&workspaceId=${W1}`, `workspaceId=${W1}`));
      if (r.status >= 500) finding('MEDIUM', `${who}: GET ${base.replace(/[a-f0-9]{24}/g, 'ID')}?${qs} -> ${r.status}`); else if (r.status < 300 && scan(r)) finding('CRITICAL', `${who}: injection ${qs} leaked ${scan(r)}`); else pass();
    }
  }
  for (const body of [{ email: { $ne: null }, password: { $ne: null } }, { email: 'alice@example.test', password: { $ne: '' } }, { email: { $gt: '' }, password: 'x' }]) { const r = await call('/auth/login', { method: 'POST', body }); if (r.status === 200) finding('CRITICAL', `login accepted NoSQL operators ${JSON.stringify(body)}`); else if (r.status >= 500) finding('MEDIUM', `login operator body -> ${r.status}`); else pass(); }
  const joinInj = await call('/workspaces/join/%7B%22%24ne%22%3Anull%7D', { method: 'POST', token: as('eve') }); if (joinInj.status < 400) finding('HIGH', 'join with injected code succeeded'); else pass();

  // ---- 6. sockets: strangers and removed members ------------------------------------------------------------------------
  const sockets = {};
  for (const who of ['dave', 'removed', 'pending', 'eve', 'carol']) { const s = connect(`http://127.0.0.1:${port}`, { auth: { token: as(who) }, transports: ['websocket'], reconnection: false, forceNew: true }); const seen = []; s.onAny((e, p) => seen.push({ e, p })); await new Promise((r) => s.once('connect', r)); sockets[who] = { s, seen }; }
  await sleep(500);
  const ack = (s, ev, id) => new Promise((resolve) => s.emit(ev, id, resolve));
  for (const who of ['dave', 'removed', 'pending', 'eve', 'carol']) {
    const targets = [['channel:join', P1], ['dm:join', dm], ['dm:join', group], ['thread:join', m1._id]];
    if (who !== 'carol') targets.push(['workspace:join', W1], ['channel:join', general]);
    for (const [ev, id] of targets) { const r = await ack(sockets[who].s, ev, id); if (r && r.ok) finding('CRITICAL', `socket ${who}: ${ev} ${id.slice(0, 6)} was ALLOWED`); else pass(); }
  }
  const frankSock = connect(`http://127.0.0.1:${port}`, { auth: { token: as('frank') }, transports: ['websocket'], reconnection: false, forceNew: true }); const frankSeen = []; frankSock.onAny((e, p) => frankSeen.push({ e, p })); await new Promise((r) => frankSock.once('connect', r)); await sleep(300);
  sockets.carol.s.emit('typing:start', { roomType: 'channel', roomId: P1 }); sockets.carol.s.emit('message:read', { channelId: P1, messageId: m1._id });
  await send('alice', { channelId: P1, content: 'p1-secret-live' }); await send('alice', { dmId: dm, content: 'dm-secret-live' }); await send('alice', { dmId: group, content: 'group-secret-live-for-frank' });
  await sleep(600);
  for (const who of ['dave', 'removed', 'pending', 'eve']) { const text = JSON.stringify(sockets[who].seen); const hit = markers.find((m) => text.includes(m)) || (text.includes('general-chat') ? 'general-chat' : null); if (hit) finding('CRITICAL', `socket ${who} RECEIVED "${hit}"`); else pass(); }
  const carolText = JSON.stringify(sockets.carol.seen);
  if (carolText.includes('p1-secret') || carolText.includes('dm-secret-live')) finding('CRITICAL', 'carol (workspace member, not in the private channel/DM) received private content live'); else pass();
  if (carolText.includes('group-secret-live')) finding('CRITICAL', 'carol received a group DM she is not part of'); else pass();
  if (!JSON.stringify(frankSeen).includes('group-secret-live-for-frank')) finding('MEDIUM', 'a legitimate group member did not receive a live group message (functional check)'); else pass();
  frankSock.disconnect();
  Object.values(sockets).forEach(({ s }) => s.disconnect());

  // ---- 7. replay / token handling ------------------------------------------------------------------------------------
  const sess = ok(await call('/auth/login', { method: 'POST', body: { email: 'bob@example.test', password: 'A memorable test passphrase 42!' } }));
  ok(await call('/auth/logout', { method: 'POST', token: sess.accessToken }));
  if ((await call('/auth/me', { token: sess.accessToken })).status < 400) finding('HIGH', 'access token still valid after logout'); else pass();
  if ((await call('/auth/refresh', { method: 'POST', body: { refreshToken: sess.refreshToken } })).status < 400) finding('HIGH', 'refresh token still valid after logout'); else pass();
  const forged = `${as('bob').split('.')[0]}.${Buffer.from(JSON.stringify({ userId: u.alice.id, ver: 0 })).toString('base64url')}.${as('bob').split('.')[2]}`;
  if ((await call('/auth/me', { token: forged })).status < 400) finding('CRITICAL', 'a token with a tampered payload was accepted'); else pass();
  const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId: u.alice.id })).toString('base64url')}.`;
  if ((await call('/auth/me', { token: noneAlg })).status < 400) finding('CRITICAL', 'alg=none token accepted'); else pass();
  const link = ok(await call('/files/urls', { method: 'POST', token: as('alice'), body: { uploadIds: [att] } })).urls[att].url;
  const asBob = await fetch(link.replace(/user=[a-f0-9]{24}/, `user=${u.bob.id}`), { redirect: 'manual' }); if (asBob.status === 200) finding('HIGH', "another user's signature was accepted for an attachment link"); else pass();
  const bobPw = await call('/users/password', { method: 'PUT', token: as('carol'), body: { currentPassword: 'wrong wrong wrong wrong', newPassword: 'Another memorable passphrase 77!' } }); if (bobPw.status < 400) finding('CRITICAL', 'password changed with a wrong current password'); else pass();

  // ---- 8. brute force and enumeration ---------------------------------------------------------------------------------
  const statuses = []; for (let i = 0; i < 40; i++) statuses.push((await call('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': `203.0.113.${100 + i}` }, body: { email: 'alice@example.test', password: `wrong guess number ${i}` } })).status);
  const correct = await call('/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.250' }, body: { email: 'alice@example.test', password: 'A memorable test passphrase 42!' } });
  if (!statuses.includes(429) && correct.status === 200) finding('MEDIUM', `no per-ACCOUNT lockout/throttle: 40 wrong passwords against one account from 40 IPs all got ${[...new Set(statuses)]} and the next correct login still succeeded. Only per-IP limits exist.`); else pass();
  const regKnown = await call('/auth/register', { method: 'POST', body: { email: 'alice@example.test', username: 'someoneelse', displayName: 'x', password: 'A memorable test passphrase 42!' } });
  const regFresh = await call('/auth/register', { method: 'POST', body: { email: 'nobody@example.test', username: 'someoneelse', displayName: 'x', password: 'A memorable test passphrase 42!' } });
  console.log(`  register (verification off in this harness): known email ${regKnown.status}, new email ${regFresh.status}`);

  // ---- 9. push-token ownership ----------------------------------------------------------------------------------------
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/probe-endpoint-1', keys: { p256dh: 'BProbeKey'.repeat(8), auth: 'probeauth12345678' } };
  const reg1 = await call('/users/web-push/subscriptions', { method: 'POST', token: as('carol'), body: sub });
  const steal = await call('/users/web-push/subscriptions', { method: 'POST', token: as('dave'), body: sub });
  if (steal.status < 400) finding('HIGH', "a web-push subscription already owned by another user could be re-registered by a different account"); else pass();
  const loginCarol = ok(await call('/auth/login', { method: 'POST', body: { email: 'carol@example.test', password: 'A memorable test passphrase 42!' } }));
  await call('/users/web-push/subscriptions', { method: 'POST', token: loginCarol.accessToken, body: { ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/probe-endpoint-2' } });
  ok(await call('/auth/logout', { method: 'POST', token: loginCarol.accessToken }));
  const remaining = await WebPushSubscription.countDocuments({ user: u.carol.id, endpoint: /probe-endpoint-2/ });
  if (reg1.status < 400 && remaining > 0) finding('MEDIUM', 'web-push subscriptions are NOT revoked server-side on logout: if the browser fails to unsubscribe itself (offline, closed tab), later notifications for that user still reach that browser (shared-device privacy leak). Same on password change/reset/disable.'); else pass();
  await call('/users/password', { method: 'PUT', token: as('carol'), body: { currentPassword: 'A memorable test passphrase 42!', newPassword: 'Another memorable passphrase 77!' } });
  if ((await WebPushSubscription.countDocuments({ user: u.carol.id })) > 0) finding('MEDIUM', 'web-push subscriptions survive a password change');

  // ---- 10. disclosure ---------------------------------------------------------------------------------------------------
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const exposed = Object.keys(health.redis || {}).concat(Object.keys(health.cleanup || {}));
  if (exposed.length) finding('LOW', `unauthenticated GET /health exposes internal state (${exposed.join(', ')}); restrict it to the load balancer/private network`);
  const headers = (await fetch(`http://127.0.0.1:${port}/api/auth/config`)).headers;
  for (const h of ['x-powered-by']) if (headers.get(h)) finding('LOW', `response header ${h} present`);
  for (const h of ['x-content-type-options', 'strict-transport-security', 'x-frame-options']) if (!headers.get(h)) finding('LOW', `missing security header ${h}`); else pass();
  const notFound = await fetch(`http://127.0.0.1:${port}/api/nope`); const text = await notFound.text(); if (/at .*\.js:\d+|node_modules/.test(text)) finding('MEDIUM', 'stack trace leaked in a 404 response'); else pass();
  const bad = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.55' }, body: '{"email":' }); const badText = await bad.text(); if (/at .*\.js:\d+|node_modules|SyntaxError/.test(badText)) finding('LOW', 'parser details leaked in a malformed-JSON response'); else pass();

  // ---- 11. what the server logged during all of the above -----------------------------------------------------------
  const leakProbe = 'LeakProbePassword-9X7!';
  await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77' }, body: `{"email":"victim@example.com","password":"${leakProbe}" garbage}` });
  await sleep(300);
  const log = captured.join('');
  const sensitive = [['password', 'A memorable test passphrase 42!'], ['password', leakProbe], ['access token', as('alice')], ['access token', as('bob')], ['refresh token', sess.refreshToken], ['message text', 'p1-secret'], ['message text', 'dm-secret'], ['message text', 'group-secret'], ['signed attachment URL', 'signature='], ['attachment URL', '/files/access/']];
  for (const [kind, needle] of sensitive) { if (log.includes(needle)) finding(needle === leakProbe ? 'MEDIUM' : 'HIGH', `server log contains a ${kind}${needle === leakProbe ? ' (a malformed-JSON request body fragment is written to the error log by the global handler)' : ''}`); else pass(); }
  const accessLog = log.split('\n').filter((l) => /^(GET|POST|PUT|PATCH|DELETE) /.test(l));
  const ambiguous = accessLog.filter((l) => /^(GET|POST) \/ /.test(l)).length;
  if (ambiguous > 5) finding('LOW', `access log prints router-relative paths (e.g. "POST / 201"): ${ambiguous} lines are ambiguous, and client IP/user are not logged, so failed logins and 403s cannot be attributed`);
  const bySeverity = findings.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a; }, {});
  console.log(`\nPROBE SUMMARY: ${passes} checks passed; findings: ${JSON.stringify(bySeverity)}`);
});
