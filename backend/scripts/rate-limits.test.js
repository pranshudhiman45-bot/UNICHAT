const { boot, assert } = require('./lib/harness');
const t = boot({ MESSAGE_SEND_LIMIT_PER_MINUTE: '20', API_RATE_LIMIT_USER: '200', API_RATE_LIMIT_IP: '40' });
t.main(async ({ call, ok, register }) => {
  const Workspace = require('../src/models/Workspace'); const Channel = require('../src/models/Channel');
  const { ipKeyGenerator } = require('../src/middleware/rateKeys');
  const [alice, bob] = [await register('alice'), await register('bob')];
  const W = ok(await call('/workspaces', { method: 'POST', token: alice.token, body: { name: 'Limits' } }), 201).workspace;
  await Workspace.updateOne({ _id: W._id }, { $push: { members: { user: bob.id, role: 'member' } } });
  const general = ok(await call(`/channels/workspace/${W._id}`, { token: alice.token })).channels.find((c) => c.name === 'general');
  await Channel.updateOne({ _id: general._id }, { $push: { members: { user: bob.id, role: 'member' } } });
  const sameIp = { 'x-forwarded-for': '198.51.100.44' };
  const send = (u, i) => call('/messages', { method: 'POST', token: u.token, headers: sameIp, body: { workspaceId: W._id, channelId: general._id, content: `m${i}` } });

  // Two people behind the SAME IP: one flooding does not affect the other.
  const results = []; for (let i = 0; i < 25; i++) results.push((await send(alice, i)).status);
  assert.equal(results.filter((s) => s === 201).length, 20, JSON.stringify(results)); assert.ok(results.slice(20).every((s) => s === 429), 'sends beyond the per-minute budget get 429');
  assert.equal((await send(bob, 0)).status, 201, 'a different user on the same IP is unaffected');
  const limited = await send(alice, 99); assert.equal(limited.status, 429); assert.match(limited.body.error, /too quickly/);
  console.log('ok - per-user send limit; users sharing an IP do not share a budget');

  // Anonymous traffic is bucketed by IP and much tighter; signed-in users keep working while an IP is exhausted.
  const anon = []; for (let i = 0; i < 50; i++) anon.push((await call('/auth/config', { headers: { 'x-forwarded-for': '198.51.100.77' } })).status);
  assert.ok(anon.includes(429), 'anonymous flood from one IP is limited');
  assert.equal((await call('/auth/me', { token: alice.token, headers: { 'x-forwarded-for': '198.51.100.77' } })).status, 200, 'signed-in user behind that same IP still works');
  console.log('ok - anonymous traffic limited per IP, signed-in users budgeted separately');

  // A caller cannot burn another user's budget by presenting their user id; forged tokens fall back to the IP bucket.
  const forged = []; for (let i = 0; i < 50; i++) forged.push((await call('/auth/config', { headers: { 'x-forwarded-for': '198.51.100.88', authorization: `Bearer ${alice.token.slice(0, -3)}xyz` } })).status);
  assert.ok(forged.includes(429), 'invalid tokens do not unlock the larger user budget');
  assert.equal((await call('/auth/me', { token: alice.token })).status, 200, "alice's own budget was never touched");
  console.log('ok - budgets cannot be spent by or on behalf of others');

  // IPv6 clients are bucketed by /64 so rotating addresses inside a prefix buys nothing.
  assert.equal(ipKeyGenerator('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ipKeyGenerator('2001:db8:1:2:1::9'));
  assert.notEqual(ipKeyGenerator('2001:db8:1:3::1'), ipKeyGenerator('2001:db8:1:2::1'));
  assert.equal(ipKeyGenerator('::ffff:203.0.113.5'), '203.0.113.5');
  console.log('ok - IPv6 bucketing');
});
