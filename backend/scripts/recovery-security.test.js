const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');
const mailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unichat-rec-'));
const ADMIN_PASSWORD = 'Admin passphrase for tests 99!';
const { boot, assert } = require('./lib/harness');
const t = boot({ PASSWORD_RECOVERY_MODE: 'admin', ADMIN_EMAIL: 'boss@example.test', ADMIN_PASSWORD_HASH: bcrypt.hashSync(ADMIN_PASSWORD, 12), DEV_EMAIL_DIR: mailDir });

const mails = (to) => fs.readdirSync(mailDir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(mailDir, f), 'utf8'))).filter((m) => m.to === to);
const codeFrom = (mail) => mail.text.match(/\b(\d{6})\b/)[1];

t.main(async ({ call, ok, register, sleep }) => {
  const User = require('../src/models/User');
  const PasswordResetRequest = require('../src/models/PasswordResetRequest');
  const victim = await register('victim');
  const adminSession = ok(await call('/auth/login', { method: 'POST', body: { email: 'boss@example.test', password: ADMIN_PASSWORD } }));
  const admin = adminSession.accessToken;

  async function fileRequest(email) {
    const response = await call('/auth/password-resets/request', { method: 'POST', body: { email } });
    assert.equal(response.status, 200);
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0];
    return { cookie, body: response.body };
  }
  const status = (cookie) => call('/auth/password-resets/status', { headers: { cookie } });

  // ---- The attack: a stranger files a request for the victim, an admin approves it in good faith. ----
  const attack = await fileRequest('victim@example.test');
  assert.ok(attack.cookie.startsWith('unichat_recovery_status='), 'requester receives only a status cookie');
  const pending = (await PasswordResetRequest.findOne({ user: victim.id }))._id.toString();
  const approved = ok(await call(`/admin/password-resets/${pending}/approve`, { method: 'POST', token: admin, body: { method: 'email' } }));
  assert.equal(approved.code, undefined, 'code is not returned to the admin or requester when emailed');
  assert.equal(approved.delivery, 'SENT');
  const attackerView = ok(await status(attack.cookie));
  assert.equal(attackerView.status, 'approved');
  assert.equal(attackerView.resetToken, undefined, 'status never exposes a reset token');
  assert.equal(JSON.stringify(attackerView).includes(attack.cookie.split('=')[1]), false);
  const statusToken = attack.cookie.split('=')[1];
  for (const resetToken of [statusToken, 'a'.repeat(64)]) {
    const attempt = await call('/auth/password-resets/complete', { method: 'POST', body: { email: 'victim@example.test', resetToken, password: 'Attacker chosen passphrase 1!', confirmPassword: 'Attacker chosen passphrase 1!' } });
    assert.equal(attempt.status, 400, 'the status token cannot be used to reset the password');
  }
  assert.equal((await call('/auth/password-resets/verify', { method: 'POST', body: { email: 'victim@example.test', code: '000000' } })).status, 400);
  assert.equal((await call('/auth/login', { method: 'POST', body: { email: 'victim@example.test', password: 'Attacker chosen passphrase 1!' } })).status, 401, 'account was not taken over');
  console.log('ok - approval does not give the requester a reset credential');

  // ---- The legitimate owner receives the code in their own mailbox and completes the reset. ----
  const delivered = mails('victim@example.test').filter((m) => /one-time code/.test(m.text));
  assert.equal(delivered.length, 1);
  const verified = ok(await call('/auth/password-resets/verify', { method: 'POST', body: { email: 'victim@example.test', code: codeFrom(delivered[0]) } }));
  const NEW = 'Owner chosen passphrase 77!';
  ok(await call('/auth/password-resets/complete', { method: 'POST', body: { email: 'victim@example.test', resetToken: verified.resetToken, password: NEW, confirmPassword: NEW } }));
  ok(await call('/auth/login', { method: 'POST', body: { email: 'victim@example.test', password: NEW } }));
  assert.equal((await call('/auth/me', { token: victim.token })).status, 401, 'old sessions revoked after reset');
  assert.equal((await call('/auth/password-resets/complete', { method: 'POST', body: { email: 'victim@example.test', resetToken: verified.resetToken, password: NEW, confirmPassword: NEW } })).status, 400, 'reset token is single use');
  console.log('ok - owner completes recovery with the emailed code; sessions revoked; token single-use');

  // ---- Admin-delivered code: shown to the admin only, still needs email + code from the requester. ----
  await fileRequest('victim@example.test');
  const second = (await PasswordResetRequest.findOne({ user: victim.id, status: 'pending' }))._id.toString();
  const manual = ok(await call(`/admin/password-resets/${second}/approve`, { method: 'POST', token: admin, body: { method: 'otp' } }));
  assert.match(manual.code, /^\d{6}$/); assert.equal(manual.delivery, 'ADMIN');
  assert.equal(mails('victim@example.test').filter((m) => /one-time code/.test(m.text)).length, 1, 'no extra email when admin delivers the code');
  assert.equal((await call(`/admin/password-resets/${second}/approve`, { method: 'POST', token: admin, body: {} })).status, 409, 'cannot approve twice');
  ok(await call('/auth/password-resets/verify', { method: 'POST', body: { email: 'victim@example.test', code: manual.code } }));
  console.log('ok - admin-delivered code path works and is single-approval');

  // ---- Brute force: five wrong codes lock the request. ----
  await PasswordResetRequest.updateMany({ user: victim.id }, { requestedAt: new Date(Date.now() - 3600000) }); // clear the 15-minute request cooldown
  await fileRequest('victim@example.test');
  const third = (await PasswordResetRequest.findOne({ user: victim.id, status: 'pending' }))._id.toString();
  const real = ok(await call(`/admin/password-resets/${third}/approve`, { method: 'POST', token: admin, body: { method: 'otp' } })).code;
  for (let i = 0; i < 5; i++) await call('/auth/password-resets/verify', { method: 'POST', body: { email: 'victim@example.test', code: real === '123456' ? '654321' : '123456' } });
  assert.equal((await call('/auth/password-resets/verify', { method: 'POST', body: { email: 'victim@example.test', code: real } })).status, 400, 'locked after repeated failures even with the right code');
  console.log('ok - OTP brute force locks the request');

  // ---- Settings cannot re-enable direct approval or name approvers who cannot sign in. ----
  const adminUser = await User.findOne({ email: 'boss@example.test' });
  const settings = (patch) => call('/admin/recovery-settings', { method: 'PATCH', token: admin, body: { directApprovalEnabled: true, otpEnabled: true, otpExpirationMinutes: 10, maxOtpAttempts: 5, approvalLinkExpirationMinutes: 15, approvers: [{ userId: adminUser._id.toString(), notificationEmail: 'boss@example.test' }], ...patch } });
  assert.equal(ok(await settings({})).directApprovalEnabled, false, 'direct approval cannot be switched on');
  await User.updateOne({ _id: victim.id }, { role: 'SUPER_ADMIN' });
  assert.equal((await settings({ approvers: [{ userId: victim.id, notificationEmail: 'victim@example.test' }] })).status, 400, 'a SUPER_ADMIN row that cannot authenticate is not a valid approver');
  const promoted = await call('/auth/login', { method: 'POST', body: { email: 'victim@example.test', password: NEW } });
  assert.ok([401, 403].includes((await call('/admin/password-resets', { token: promoted.body.accessToken })).status), 'a role flipped in the database does not grant admin access');
  console.log('ok - settings enforce a consistent approver definition');
});
