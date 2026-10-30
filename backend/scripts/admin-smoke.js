process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
process.env.PASSWORD_RECOVERY_MODE = 'admin';
process.env.AUTO_JOIN_DEFAULT_WORKSPACE = 'true';
process.env.WORKSPACE_CREATION = 'admin';
process.env.TRUST_PROXY_HOPS = '1';
// Isolated integration smoke test. Uses ONLY a freshly generated local MongoDB database.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const dbName = `unichat_admin_smoke_${crypto.randomBytes(6).toString('hex')}`;
const mongoUri = `mongodb://127.0.0.1:27017/${dbName}`;
const adminPassword = crypto.randomBytes(20).toString('hex');
const userPassword = 'initialPassword123';
const newPassword = 'replacementPassword456';
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = mongoUri;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = crypto.randomBytes(48).toString('hex');
process.env.ADMIN_EMAIL = 'dev.univisionz@gmail.com';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(adminPassword, 12);
process.env.ALLOWED_REGISTRATION_DOMAIN = 'univisionz.com';

const { app, io } = require('../src/index');
const User = require('../src/models/User');
const PasswordResetRequest = require('../src/models/PasswordResetRequest');
const Notification = require('../src/models/Notification');
const AuditLog = require('../src/models/AuditLog');
const { tokenHash, newToken } = require('../src/services/passwordRecovery');
let server;
let base;
let requestNumber = 0;
async function call(path, { method = 'GET', token, body, ip, headers = {} } = {}) {
  requestNumber += 1;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip || `198.51.100.${(requestNumber % 200) + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}
function status(result, expected, label) { assert.equal(result.status, expected, `${label}: ${result.status} ${JSON.stringify(result.data)}`); }
async function newRequest(email, adminToken) {
  status(await call('/api/auth/password-resets/request', { method: 'POST', body: { email } }), 200, 'submit reset request');
  const list = await call('/api/admin/password-resets', { token: adminToken });
  status(list, 200, 'list reset requests');
  const pending = list.data.requests.find((entry) => entry.user?.email === email && entry.status === 'pending');
  assert.ok(pending, 'pending reset request present');
  return pending;
}

async function run() {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const email = 'admin-smoke-user@univisionz.com';

  const registration = await call('/api/auth/register', { method: 'POST', body: { email, username: 'adminsmoketest', displayName: 'Smoke User', password: userPassword, role: 'SUPER_ADMIN' } });
  status(registration, 201, 'normal registration');
  assert.equal(registration.data.user.role, 'USER', 'client role cannot elevate');
  const userToken = registration.data.accessToken;
  const oldRefresh = registration.data.refreshToken;
  const initialWorkspaces = await call('/api/workspaces', { token: userToken });
  status(initialWorkspaces, 200, 'normal workspace list');
  assert.equal(initialWorkspaces.data.workspaces.length, 0, 'normal user cannot bootstrap the default workspace');
  status(await call('/api/admin/dashboard'), 401, 'unauthenticated admin denied');
  status(await call('/api/admin/dashboard', { token: userToken }), 403, 'normal user denied admin');
  status(await call('/api/workspaces', { method: 'POST', token: userToken, body: { name: 'Denied' } }), 403, 'normal user denied workspace creation');
  status(await call('/api/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: 'wrong' } }), 401, 'admin wrong password');
  const adminLogin = await call('/api/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: adminPassword } });
  status(adminLogin, 200, 'admin login');
  assert.equal(adminLogin.data.user.role, 'SUPER_ADMIN');
  const adminToken = adminLogin.data.accessToken;
  status(await call('/api/auth/login', { method: 'POST', body: { email: process.env.ADMIN_EMAIL, password: adminPassword } }), 200, 'admin login remains valid after account bootstrap');

  assert.equal((await call('/api/workspaces', { token: userToken })).data.workspaces.length, 0, 'Matching email domains never bypass workspace approval');
  const created = await call('/api/workspaces', { method: 'POST', token: adminToken, body: { name: 'Smoke Team' } });
  status(created, 201, 'admin workspace creation');
  const ws = created.data.workspace;
  status(await call(`/api/workspaces/${ws._id}`, { method: 'DELETE', body: { confirmName: ws.name } }), 401, 'unauthenticated workspace delete denied');
  status(await call(`/api/workspaces/${ws._id}`, { method: 'DELETE', token: userToken, body: { confirmName: ws.name } }), 403, 'normal user workspace delete denied');
  const joinRequest = await call(`/api/workspaces/join/${ws.inviteCode}`, { method: 'POST', token: userToken });
  status(joinRequest, 202, 'user requests membership');
  status(await call(`/api/workspaces/${ws._id}/join-requests/${joinRequest.data.request._id}/approve`, { method: 'POST', token: adminToken }), 200, 'owner approves membership');
  status(await call(`/api/workspaces/${ws._id}`, { token: userToken }), 200, 'joined workspace readable');
  status(await call(`/api/admin/workspaces/${ws._id}`, { method: 'DELETE', token: adminToken, body: { confirmName: 'Wrong' } }), 400, 'delete requires exact name');
  status(await call(`/api/admin/workspaces/${ws._id}`, { method: 'DELETE', token: adminToken, body: { confirmName: ws.name } }), 200, 'admin soft deletion');
  status(await call(`/api/workspaces/${ws._id}`, { token: userToken }), 404, 'deleted workspace inaccessible');
  status(await call(`/api/admin/workspaces/${ws._id}/restore`, { method: 'POST', token: adminToken }), 200, 'workspace restoration');
  status(await call(`/api/workspaces/${ws._id}`, { token: userToken }), 200, 'restored workspace accessible');

  const known = await call('/api/auth/password-resets/request', { method: 'POST', body: { email } });
  const unknown = await call('/api/auth/password-resets/request', { method: 'POST', body: { email: 'does-not-exist@univisionz.com' } });
  status(known, 200, 'known email generic response');
  status(unknown, 200, 'unknown email generic response');
  assert.deepEqual(known.data, unknown.data, 'no email enumeration in response');
  const list = await call('/api/admin/password-resets', { token: adminToken });
  const reset = list.data.requests.find((entry) => entry.user?.email === email && entry.status === 'pending');
  assert.ok(reset);
  assert.equal(reset.emailNotificationStatus, 'FAILED', 'SMTP failure is tracked without removing the request');
  const securitySettings = await call('/api/admin/recovery-settings', { token: adminToken });
  status(securitySettings, 200, 'recovery settings access');
  assert.ok(securitySettings.data.approvers.some((entry) => (entry.user?._id || entry.user) === adminLogin.data.user._id), 'admin is a recovery approver');
  const activity = await call(`/api/notifications?workspaceId=${ws._id}&filter=security`, { token: adminToken });
  status(activity, 200, 'admin in-app recovery notification');
  const storedSecurityNotification = await Notification.findOne({ type: 'password_recovery' }).lean();
  assert.ok(activity.data.notifications.some((entry) => entry.type === 'password_recovery'), `recovery notification is private and visible to admin (stored=${JSON.stringify(storedSecurityNotification)})`);
  const notificationAuditActions = new Set((await AuditLog.find({ targetRequestId: reset._id }).lean()).map((entry) => entry.action));
  assert.ok(notificationAuditActions.has('RECOVERY_IN_APP_NOTIFICATION_SENT'), 'in-app recovery notification should be audited');
  assert.ok(notificationAuditActions.has('RECOVERY_NOTIFICATION_FAILED'), 'failed email notification should be audited');
  assert.equal([...notificationAuditActions].some((action) => /OTP|CODE/i.test(action)), false, 'notification audit should not expose OTP actions');
  const approval = await call(`/api/admin/password-resets/${reset._id}/approve`, { method: 'POST', token: adminToken });
  status(approval, 200, 'admin reset approval');
  assert.match(approval.data.code, /^\d{6}$/);
  assert.equal(JSON.stringify(approval.data).includes('codeHash'), false, 'code hash not returned');
  const stored = await PasswordResetRequest.findById(reset._id).select('+codeHash');
  assert.notEqual(stored.codeHash, approval.data.code, 'plaintext code is not stored');
  status(await call('/api/auth/password-resets/verify', { method: 'POST', body: { email, code: '000000' } }), 400, 'wrong code');
  const verified = await call('/api/auth/password-resets/verify', { method: 'POST', body: { email, code: approval.data.code } });
  status(verified, 200, 'correct code');
  status(await call('/api/auth/password-resets/complete', { method: 'POST', body: { email, resetToken: verified.data.resetToken, password: newPassword, confirmPassword: newPassword } }), 200, 'successful password reset');
  status(await call('/api/auth/me', { token: userToken }), 401, 'old access token revoked');
  status(await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: oldRefresh } }), 401, 'old refresh token revoked');
  status(await call('/api/auth/login', { method: 'POST', body: { email, password: userPassword } }), 401, 'old password rejected');
  const newLogin = await call('/api/auth/login', { method: 'POST', body: { email, password: newPassword } });
  status(newLogin, 200, 'new password accepted');
  status(await call('/api/auth/password-resets/verify', { method: 'POST', body: { email, code: approval.data.code } }), 400, 'code reuse rejected');
  status(await call('/api/auth/password-resets/complete', { method: 'POST', body: { email, resetToken: verified.data.resetToken, password: newPassword, confirmPassword: newPassword } }), 400, 'reset token reuse rejected');

  const directStatusToken = newToken();
  const directApprovalToken = newToken();
  const directRequest = await PasswordResetRequest.create({ user: registration.data.user._id, statusTokenHash: tokenHash(directStatusToken), approvalTokens: [{ approver: adminLogin.data.user._id, hash: tokenHash(directApprovalToken), expiresAt: new Date(Date.now() + 15 * 60 * 1000) }], requestIp: '198.51.100.10', userAgent: 'Smoke browser' });
  const approvalPage = await call(`/api/auth/password-resets/approval?token=${directApprovalToken}`);
  status(approvalPage, 200, 'email approval confirmation page');
  assert.equal(approvalPage.data.request.email, email);
  status(await call('/api/auth/password-resets/approval/approve', { method: 'POST', body: { token: directApprovalToken } }), 401, 'unauthenticated approval denied');
  status(await call('/api/auth/password-resets/approval/approve', { method: 'POST', token: adminToken, body: { token: directApprovalToken } }), 200, 'authenticated link approval');
  status(await call('/api/auth/password-resets/approval/approve', { method: 'POST', token: adminToken, body: { token: directApprovalToken } }), 409, 'approval link cannot be reused');
  const directStatus = await call('/api/auth/password-resets/status', { headers: { cookie: `unichat_recovery_status=${directStatusToken}` } });
  status(directStatus, 200, 'approved recovery status');
  assert.equal(directStatus.data.resetToken, undefined, 'approval must never release a reset credential to the requester');
  assert.equal(directStatus.data.status, 'approved');
  const approvedRecord = await PasswordResetRequest.findById(directRequest._id).select('+resetTokenHash +codeHash');
  assert.equal(approvedRecord.approvalMethod, 'otp', 'approval issues a one-time code (emailed to the account holder) instead');
  assert.ok(approvedRecord.codeHash); assert.equal(approvedRecord.resetTokenHash, null);
  await PasswordResetRequest.updateOne({ _id: directRequest._id }, { $set: { status: 'completed' } });

  const attemptRequest = await newRequest(email, adminToken);
  const attemptApproval = await call(`/api/admin/password-resets/${attemptRequest._id}/approve`, { method: 'POST', token: adminToken });
  status(attemptApproval, 200, 'approve attempt-limit request');
  for (let index = 0; index < 5; index++) status(await call('/api/auth/password-resets/verify', { method: 'POST', body: { email, code: '000000' } }), 400, `wrong code ${index + 1}`);
  assert.equal((await PasswordResetRequest.findById(attemptRequest._id)).status, 'locked', 'five wrong attempts lock request');
  status(await call('/api/auth/password-resets/verify', { method: 'POST', body: { email, code: attemptApproval.data.code } }), 400, 'correct code rejected after attempt limit');

  const expiredRequest = await newRequest(email, adminToken);
  const expiredApproval = await call(`/api/admin/password-resets/${expiredRequest._id}/approve`, { method: 'POST', token: adminToken });
  status(expiredApproval, 200, 'approve expiration request');
  await PasswordResetRequest.updateOne({ _id: expiredRequest._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  status(await call('/api/auth/password-resets/verify', { method: 'POST', body: { email, code: expiredApproval.data.code } }), 400, 'expired code rejected');
  status(await call(`/api/admin/password-resets/${expiredRequest._id}/regenerate`, { method: 'POST', token: adminToken }), 200, 'admin regenerates expired code');
  status(await call(`/api/admin/users/${registration.data.user._id}`, { method: 'PATCH', token: adminToken, body: { accountStatus: 'disabled' } }), 200, 'admin disables user');
  status(await call('/api/auth/me', { token: newLogin.data.accessToken }), 401, 'disabled user token revoked');
  status(await call('/api/auth/login', { method: 'POST', body: { email, password: newPassword } }), 403, 'disabled user login denied');
  status(await call(`/api/admin/users/${registration.data.user._id}`, { method: 'PATCH', token: adminToken, body: { accountStatus: 'active' } }), 200, 'admin enables user');
  status(await call(`/api/admin/users/${adminLogin.data.user._id}`, { method: 'PATCH', token: adminToken, body: { accountStatus: 'disabled' } }), 403, 'admin cannot disable self');
  status(await call('/api/auth/login', { method: 'POST', body: { email, password: newPassword } }), 200, 'enabled user login accepted');
  const auditLogs = await call('/api/admin/audit-logs', { token: adminToken });
  status(auditLogs, 200, 'admin audit access');
  assert.ok(auditLogs.data.logs.some((entry) => entry.action === 'PASSWORD_RESET_SUCCESS'));
  assert.equal(JSON.stringify(auditLogs.data).includes(approval.data.code), false, 'plaintext code absent from audit logs');
  for (let index = 0; index < 10; index++) status(await call('/api/auth/login', { method: 'POST', ip: '198.51.100.251', body: { email, password: 'wrong-password' } }), 401, 'invalid login under limit');
  status(await call('/api/auth/login', { method: 'POST', ip: '198.51.100.251', body: { email, password: 'wrong-password' } }), 429, 'login rate limit');
  for (let index = 0; index < 5; index++) status(await call('/api/auth/password-resets/request', { method: 'POST', ip: '198.51.100.252', body: { email: 'unknown@univisionz.com' } }), 200, 'reset request under limit');
  status(await call('/api/auth/password-resets/request', { method: 'POST', ip: '198.51.100.252', body: { email: 'unknown@univisionz.com' } }), 429, 'reset request rate limit');
  console.log('Admin security and password recovery smoke: PASS');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  if (mongoose.connection.readyState === 1) {
    if (mongoose.connection.name !== dbName || !/^unichat_admin_smoke_[a-f0-9]{12}$/.test(dbName)) throw new Error('Refusing to clean up a non-test database');
    await mongoose.connection.dropDatabase();
  }
  await mongoose.disconnect();
  io.close();
});
