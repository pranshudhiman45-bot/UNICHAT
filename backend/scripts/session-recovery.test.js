const { boot, assert } = require('./lib/harness');
const t = boot();
t.main(async ({ call, ok, register, sleep }) => {
  const User = require('../src/models/User');
  const user = await register('sessiony');
  // Normal rotation.
  const second = ok(await call('/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } }));
  assert.ok(second.refreshToken && second.refreshToken !== user.refreshToken);
  // Lost response: the client retries with the token it still holds (within the window) and recovers.
  const recovered = ok(await call('/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } }));
  assert.ok(recovered.accessToken);
  assert.equal(ok(await call('/auth/me', { token: recovered.accessToken })).user.username, 'sessiony');
  console.log('ok - lost refresh response is recoverable inside the reuse window');
  // Outside the window the old token is dead.
  await User.updateOne({ _id: user.id }, { $set: { 'refreshSessions.0.rotatedAt': new Date(Date.now() - 120000) } });
  assert.equal((await call('/auth/refresh', { method: 'POST', body: { refreshToken: user.refreshToken } })).status, 401);
  // Garbage / missing tokens are 401s (the signal mobile treats as "really logged out").
  assert.equal((await call('/auth/refresh', { method: 'POST', body: { refreshToken: 'garbage' } })).status, 401);
  assert.equal((await call('/auth/refresh', { method: 'POST', body: {} })).status, 401);
  console.log('ok - stale / invalid refresh tokens return 401');
  // Logout revokes the session; password change revokes all.
  const fresh = ok(await call('/auth/refresh', { method: 'POST', body: { refreshToken: recovered.refreshToken } }));
  ok(await call('/auth/logout', { method: 'POST', token: fresh.accessToken }));
  assert.equal((await call('/auth/refresh', { method: 'POST', body: { refreshToken: fresh.refreshToken } })).status, 401);
  assert.equal((await call('/auth/me', { token: fresh.accessToken })).status, 401, 'access token of a revoked session stops working');
  console.log('ok - logout revokes refresh and access tokens');
});
