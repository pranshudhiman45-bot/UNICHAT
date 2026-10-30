const express = require('express');
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const RecoverySettings = require('../models/RecoverySettings');
const AuditLog = require('../models/AuditLog');
const { authenticate } = require('../middleware/auth');
const { requireSuperAdmin, audit, isSuperAdmin } = require('../services/adminSecurity');
const { newCode } = require('../services/passwordRecovery');
const { getRecoverySettings } = require('../services/recoveryConfiguration');
const { notifyRecoveryApprovers } = require('../services/recoveryNotifications');
const { softDeleteWorkspace } = require('../services/workspaceAdministration');
const { sendEmail } = require('../services/emailService');

const router = express.Router();
router.use(authenticate, requireSuperAdmin);
function validId(value) { return mongoose.isValidObjectId(value); }
function publicReset(reset) {
  const { _id, user, status, attempts, requestedAt, approvedAt, approvedBy, expiresAt, requestIp, userAgent, usedAt, approvalMethod, emailNotificationStatus, emailNotificationAttempts, emailLastAttemptAt, emailSentAt, emailLastError } = reset;
  return { _id, user, status, attempts, requestedAt, approvedAt, approvedBy, expiresAt, requestIp, userAgent, usedAt, approvalMethod, emailNotificationStatus, emailNotificationAttempts, emailLastAttemptAt, emailSentAt, emailLastError };
}
function pageOptions(req) { return { skip: Math.min(Math.max(Number(req.query.page) || 0, 0), 1000) * 50, limit: 50 }; }
async function expireCodes() {
  await PasswordResetRequest.updateMany({ status: { $in: ['approved', 'verified'] }, expiresAt: { $lte: new Date() } }, { $set: { status: 'expired', codeHash: null, resetTokenHash: null, statusTokenHash: null, approvalTokens: [] } });
}

router.get('/dashboard', async (req, res, next) => {
  try {
    await expireCodes();
    const [totalWorkspaces, totalUsers, activeUsers, pendingPasswordResets, recentActivity] = await Promise.all([
      Workspace.countDocuments({ deletedAt: null }), User.countDocuments(),
      User.countDocuments({ status: 'online', accountStatus: { $ne: 'disabled' } }),
      PasswordResetRequest.countDocuments({ status: 'pending' }),
      AuditLog.find().sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    res.json({ totalWorkspaces, totalUsers, activeUsers, pendingPasswordResets, recentActivity });
  } catch (error) { next(error); }
});
router.get('/workspaces', async (req, res, next) => {
  try { res.json({ workspaces: await Workspace.find().sort({ createdAt: -1 }).skip(pageOptions(req).skip).limit(50).populate('owner', 'displayName email').lean() }); }
  catch (error) { next(error); }
});
router.delete('/workspaces/:id', softDeleteWorkspace);
router.post('/workspaces/:id/restore', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Workspace not found' });
    const workspace = await Workspace.findOne({ _id: req.params.id, deletedAt: { $ne: null } });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    workspace.deletedAt = null;
    workspace.isArchived = false;
    await workspace.save();
    await audit(req, 'WORKSPACE_RESTORED', { workspaceId: workspace._id });
    return res.json({ workspace });
  } catch (error) { next(error); }
});
router.get('/users', async (req, res, next) => {
  try {
    const users = await User.find().select('_id email username displayName role accountStatus status lastSeen createdAt').sort({ createdAt: -1 }).skip(pageOptions(req).skip).limit(50).lean();
    res.json({ users: users.map((user) => ({ ...user, role: user.role || 'USER', accountStatus: user.accountStatus || 'active' })) });
  }
  catch (error) { next(error); }
});
router.patch('/users/:id', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'User not found' });
    if (!['active', 'disabled'].includes(req.body.accountStatus)) return res.status(400).json({ error: 'Invalid account status' });
    const user = await User.findById(req.params.id).select('+refreshToken +refreshSessions');
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (String(user._id) === req.userId || user.role === 'SUPER_ADMIN') return res.status(403).json({ error: 'Cannot change a super admin account' });
    if (user.accountStatus === req.body.accountStatus) return res.json({ user: user.toPublicJSON() });
    user.accountStatus = req.body.accountStatus;
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    user.refreshToken = null;
    user.refreshSessions = [];
    await user.save();
    await require('../services/pushNotifications').revokePushDevices(user._id);
    const io = req.app.get('io');
    if (io) (await io.in(`user:${user._id}`).fetchSockets()).forEach((socket) => socket.disconnect(true));
    await audit(req, user.accountStatus === 'disabled' ? 'USER_DISABLED' : 'USER_ENABLED', { userId: user._id });
    return res.json({ user: user.toPublicJSON() });
  } catch (error) { next(error); }
});
router.get('/password-resets', async (req, res, next) => {
  try {
    await expireCodes();
    const requests = await PasswordResetRequest.find().sort({ requestedAt: -1 }).skip(pageOptions(req).skip).limit(50).populate('user', 'displayName email').populate('approvedBy', 'displayName').lean();
    res.json({ requests });
  } catch (error) { next(error); }
});
// method 'otp'   : the code is shown to this admin only, for delivery after verifying identity out of band.
// anything else  : the code is emailed to the address registered on the account (default; also the old 'direct').
// Neither path ever gives the requester a credential. The requester always needs the code to finish.
router.post('/password-resets/:id/approve', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Request not found' });
    const settings = await getRecoverySettings();
    if (!settings.otpEnabled) return res.status(409).json({ error: 'One-time-code recovery is disabled in Recovery settings' });
    const showToAdmin = req.body?.method === 'otp';
    const existing = await PasswordResetRequest.findById(req.params.id);
    if (!existing || existing.status !== 'pending') return res.status(409).json({ error: 'Request is no longer pending' });
    const code = newCode(req.params.id, settings.otpExpirationMinutes * 60 * 1000);
    const update = { status: 'approved', approvedAt: new Date(), approvedBy: req.userId, expiresAt: code.expiresAt, codeHash: code.hash, attempts: 0, verifiedAt: null, resetTokenHash: null, approvalMethod: 'otp' };
    const handled = await PasswordResetRequest.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: update }, { new: true }).populate('user', 'displayName email');
    if (!handled) return res.status(409).json({ error: 'Request is no longer pending' });
    await PasswordResetRequest.updateMany({ user: handled.user._id, _id: { $ne: handled._id }, status: { $in: ['pending', 'approved', 'verified'] } }, { $set: { status: 'rejected', codeHash: null, resetTokenHash: null, statusTokenHash: null, approvalTokens: [] } });
    res.set('Cache-Control', 'no-store');
    let delivery = 'ADMIN';
    if (!showToAdmin) {
      try {
        await sendEmail({ to: handled.user.email, subject: 'Reset your Unichat password', text: `An administrator approved your password recovery request.\n\nYour one-time code is ${code.code}. It expires in ${settings.otpExpirationMinutes} minutes and can be used once. Never share it. If you did not request this, ignore this email and tell your administrator.` });
        delivery = 'SENT';
      } catch { delivery = 'FAILED'; console.error('Recovery code email could not be delivered'); }
      await PasswordResetRequest.updateOne({ _id: handled._id }, { $set: { emailNotificationStatus: delivery } });
    }
    await audit(req, 'PASSWORD_RECOVERY_APPROVED', { userId: handled.user._id, requestId: handled._id, metadata: { approvalMethod: showToAdmin ? 'otp_admin_delivered' : 'otp_emailed_to_account', delivery } });
    await audit(req, 'RECOVERY_OTP_GENERATED', { userId: handled.user._id, requestId: handled._id });
    // The code is returned only when the admin chose to deliver it themselves (or if the email failed, so recovery is not stuck).
    const reveal = showToAdmin || delivery === 'FAILED';
    return res.json({ request: publicReset(handled), delivery, ...(reveal ? { code: code.code } : {}), expiresAt: code.expiresAt });
  } catch (error) { next(error); }
});
router.post('/password-resets/:id/reject', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Request not found' });
    const reset = await PasswordResetRequest.findOneAndUpdate({ _id: req.params.id, status: { $in: ['pending', 'approved', 'verified'] } }, { $set: { status: 'rejected', codeHash: null, resetTokenHash: null, statusTokenHash: null, approvalTokens: [] } }, { new: true });
    if (!reset) return res.status(409).json({ error: 'Request cannot be rejected' });
    await audit(req, 'PASSWORD_RESET_REJECTED', { userId: reset.user, requestId: reset._id });
    return res.json({ request: publicReset(reset) });
  } catch (error) { next(error); }
});
router.post('/password-resets/:id/regenerate', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Request not found' });
    const settings = await getRecoverySettings();
    if (!settings.otpEnabled) return res.status(409).json({ error: 'OTP fallback is disabled in Recovery settings' });
    const code = newCode(req.params.id, settings.otpExpirationMinutes * 60 * 1000);
    const reset = await PasswordResetRequest.findOneAndUpdate({ _id: req.params.id, status: { $in: ['approved', 'expired', 'locked'] }, verifiedAt: null }, { $set: { status: 'approved', approvalMethod: 'otp', codeHash: code.hash, resetTokenHash: null, expiresAt: code.expiresAt, attempts: 0, approvedAt: new Date() } }, { new: true });
    if (!reset) return res.status(409).json({ error: 'Request cannot be regenerated' });
    res.set('Cache-Control', 'no-store');
    await audit(req, 'PASSWORD_RESET_REGENERATED', { userId: reset.user, requestId: reset._id });
    await audit(req, 'RECOVERY_OTP_GENERATED', { userId: reset.user, requestId: reset._id });
    return res.json({ request: publicReset(reset), code: code.code, expiresAt: code.expiresAt });
  } catch (error) { next(error); }
});
router.post('/password-resets/:id/resend', async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Request not found' });
    const reset = await PasswordResetRequest.findById(req.params.id).populate('user', 'displayName username email');
    if (!reset) return res.status(404).json({ error: 'Request not found' });
    if (!['pending', 'approved'].includes(reset.status)) return res.status(409).json({ error: 'Only active requests can be notified' });
    await notifyRecoveryApprovers({ req, request: reset, user: reset.user });
    return res.json({ request: publicReset(reset) });
  } catch (error) { next(error); }
});

router.get('/recovery-settings', async (req, res, next) => {
  try {
    const settings = await getRecoverySettings();
    return res.json({
      directApprovalEnabled: settings.directApprovalEnabled,
      otpEnabled: settings.otpEnabled,
      otpExpirationMinutes: settings.otpExpirationMinutes,
      maxOtpAttempts: settings.maxOtpAttempts,
      approvalLinkExpirationMinutes: settings.approvalLinkExpirationMinutes,
      approvers: settings.approvers.map((entry) => ({ user: entry.user, notificationEmail: entry.notificationEmail, emailNotifications: entry.emailNotifications, inAppNotifications: entry.inAppNotifications })),
    });
  } catch (error) { next(error); }
});

router.patch('/recovery-settings', async (req, res, next) => {
  try {
    const body = req.body || {};
    const values = {
      directApprovalEnabled: false, // removed: approval must never hand the requester a credential
      otpEnabled: Boolean(body.otpEnabled),
      otpExpirationMinutes: Number(body.otpExpirationMinutes),
      maxOtpAttempts: Number(body.maxOtpAttempts),
      approvalLinkExpirationMinutes: Number(body.approvalLinkExpirationMinutes),
    };
    if (![values.otpExpirationMinutes, values.maxOtpAttempts, values.approvalLinkExpirationMinutes].every(Number.isInteger) || values.otpExpirationMinutes < 1 || values.otpExpirationMinutes > 60 || values.maxOtpAttempts < 1 || values.maxOtpAttempts > 10 || values.approvalLinkExpirationMinutes < 5 || values.approvalLinkExpirationMinutes > 60) return res.status(400).json({ error: 'Recovery timing values are outside the allowed range' });
    if (!Array.isArray(body.approvers) || body.approvers.length < 1 || body.approvers.length > 10) return res.status(400).json({ error: 'At least one recovery approver is required' });
    const ids = body.approvers.map((entry) => entry?.userId).filter(validId);
    if (ids.length !== body.approvers.length || new Set(ids.map(String)).size !== ids.length) return res.status(400).json({ error: 'Each recovery approver must reference a unique user' });
    const users = (await User.find({ _id: { $in: ids }, role: 'SUPER_ADMIN', accountStatus: { $ne: 'disabled' } }).select('_id email role accountStatus')).filter((candidate) => isSuperAdmin(candidate));
    if (users.length !== ids.length) return res.status(400).json({ error: 'Recovery approvers must be active administrators who can sign in (currently only the account configured as ADMIN_EMAIL)' });
    const approvers = body.approvers.map((entry) => ({ user: entry.userId, notificationEmail: String(entry.notificationEmail || '').trim().toLowerCase(), emailNotifications: entry.emailNotifications !== false, inAppNotifications: entry.inAppNotifications !== false }));
    if (approvers.some((entry) => !/^\S+@\S+\.\S+$/.test(entry.notificationEmail))) return res.status(400).json({ error: 'Each approver needs a valid notification email' });
    const settings = await RecoverySettings.findOneAndUpdate({ key: 'default' }, { $set: { ...values, approvers, updatedBy: req.userId } }, { upsert: true, new: true, runValidators: true });
    await audit(req, 'RECOVERY_SETTINGS_UPDATED', { metadata: { approverCount: approvers.length } });
    return res.json({ directApprovalEnabled: settings.directApprovalEnabled, otpEnabled: settings.otpEnabled, otpExpirationMinutes: settings.otpExpirationMinutes, maxOtpAttempts: settings.maxOtpAttempts, approvalLinkExpirationMinutes: settings.approvalLinkExpirationMinutes, approvers: settings.approvers });
  } catch (error) { next(error); }
});
router.get('/audit-logs', async (req, res, next) => {
  try { res.json({ logs: await AuditLog.find().sort({ createdAt: -1 }).skip(pageOptions(req).skip).limit(50).populate('actorUserId', 'displayName email').lean() }); }
  catch (error) { next(error); }
});
router.get('/security', async (req, res, next) => {
  try {
    const settings = await getRecoverySettings();
    res.json({ passwordResetCodeLifetimeMinutes: settings.otpExpirationMinutes, maxVerificationAttempts: settings.maxOtpAttempts, approvalLinkExpirationMinutes: settings.approvalLinkExpirationMinutes, directApprovalEnabled: settings.directApprovalEnabled, otpEnabled: settings.otpEnabled, loginRateLimitPer15Minutes: 10, resetRequestRateLimitPer15Minutes: 5, sessionRevocation: true });
  } catch (error) { next(error); }
});

module.exports = router;
