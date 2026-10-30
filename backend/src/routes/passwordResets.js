const express = require('express');
const { limiter } = require('../services/redis');
const { sendEmail } = require('../services/emailService');
const { passwordValid } = require('../services/emailVerification');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const { adminEmail, audit } = require('../services/adminSecurity');
const { MAX_ATTEMPTS, codeHash, tokenHash, secureMatch, newToken, newCode } = require('../services/passwordRecovery');
const { getRecoverySettings } = require('../services/recoveryConfiguration');
const { notifyRecoveryApprovers } = require('../services/recoveryNotifications');
const { authenticate } = require('../middleware/auth');
const { requireSuperAdmin } = require('../services/adminSecurity');

const router = express.Router();
const requestLimit = limiter('recovery-request', { windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } });
const verifyLimit = limiter('recovery-verify', { windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const statusLimit = limiter('recovery-status', { windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many status checks. Try again later.' } });
const generic = { message: 'If an account exists for this email, a recovery request has been submitted.' };

function emailFrom(value) { return typeof value === 'string' && value.length <= 254 ? value.trim().toLowerCase() : ''; }
function validToken(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function cookieToken(req) { const match = String(req.get('cookie') || '').match(/(?:^|;\s*)unichat_recovery_status=([a-f0-9]{64})(?:;|$)/); return match?.[1] || ''; }
// The requester's status link proves only "I filed this request". It must never be convertible into a
// reset credential: a stranger can file a request for any email address.
function publicStatus(reset) {
  return { requestId: reset._id, status: reset.status, emailNotificationStatus: reset.emailNotificationStatus, expiresAt: reset.expiresAt || null };
}
function clearSecrets() { return { codeHash: null, resetTokenHash: null, statusTokenHash: null, approvalTokens: [] }; }

async function expireReset(reset) {
  if (reset && ['approved', 'verified'].includes(reset.status) && reset.expiresAt && reset.expiresAt <= new Date()) {
    await PasswordResetRequest.updateOne({ _id: reset._id, status: reset.status }, { $set: { status: 'expired', ...clearSecrets() } });
    reset.status = 'expired';
  }
  return reset;
}

router.post('/request', requestLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const email = emailFrom(req.body.email);
    if (!/^\S+@\S+\.\S+$/.test(email) || email === adminEmail()) return res.json(generic);
    const user = await User.findOne({ email, accountStatus: { $ne: 'disabled' } }).select('_id displayName username email');
    if (!user) return res.json(generic);
    if (process.env.PASSWORD_RECOVERY_MODE !== 'admin') {
      const now = new Date();
      const reserved = await User.findOneAndUpdate({ _id: user._id, $or: [{ resetEmailRequestedAt: null }, { resetEmailRequestedAt: { $lte: new Date(Date.now() - 60000) } }] }, { $set: { resetEmailRequestedAt: now } });
      if (!reserved) return res.json(generic);
      await PasswordResetRequest.updateMany({ user: user._id, status: { $in: ['pending', 'approved', 'verified'] } }, { $set: { status: 'rejected', ...clearSecrets() } });
      const reset = new PasswordResetRequest({ user: user._id, status: 'approved', approvalMethod: 'otp', approvedAt: now, requestIp: String(req.ip || '').slice(0, 80), userAgent: String(req.get('user-agent') || '').slice(0, 300) });
      const generated = newCode(reset._id);
      reset.codeHash = generated.hash;
      reset.expiresAt = generated.expiresAt;
      await reset.save();
      try {
        await sendEmail({ to: email, subject: 'Reset your Unichat password', text: `Your Unichat password reset code is ${generated.code}.\n\nIt expires in 10 minutes and can only be used once. Never share it. If you did not request a reset, ignore this email.` });
        await PasswordResetRequest.updateOne({ _id: reset._id }, { $set: { emailNotificationStatus: 'SENT', emailSentAt: new Date() }, $inc: { emailNotificationAttempts: 1 } });
      } catch {
        await PasswordResetRequest.updateOne({ _id: reset._id }, { $set: { status: 'rejected', emailNotificationStatus: 'FAILED', ...clearSecrets() } });
        await User.updateOne({ _id: user._id, resetEmailRequestedAt: now }, { $set: { resetEmailRequestedAt: null } });
        console.error('Password recovery email could not be delivered');
      }
      await audit(req, 'PASSWORD_RECOVERY_REQUESTED', { userId: user._id, requestId: reset._id });
      return res.json(generic);
    }
    const recent = await PasswordResetRequest.findOne({ user: user._id, status: { $in: ['pending', 'approved', 'verified'] }, requestedAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) } }).sort({ requestedAt: -1 });
    if (recent) return res.json(generic);

    await PasswordResetRequest.updateMany({ user: user._id, status: { $in: ['pending', 'approved', 'verified'] } }, { $set: { status: 'rejected', ...clearSecrets() } });
    const statusToken = newToken();
    const recoveryRequest = await PasswordResetRequest.create({ user: user._id, statusTokenHash: tokenHash(statusToken), requestIp: String(req.ip || '').slice(0, 80), userAgent: String(req.get('user-agent') || '').slice(0, 300) });
    await audit(req, 'PASSWORD_RECOVERY_REQUESTED', { userId: user._id, requestId: recoveryRequest._id });
    await notifyRecoveryApprovers({ req, request: recoveryRequest, user }).catch(async (error) => {
      const reason = String(error.message || 'Recovery notification failed').slice(0, 300);
      await PasswordResetRequest.updateOne({ _id: recoveryRequest._id }, { $set: { emailNotificationStatus: 'FAILED', emailLastError: reason, emailLastAttemptAt: new Date() }, $inc: { emailNotificationAttempts: 1 } });
      await audit(req, 'RECOVERY_NOTIFICATION_FAILED', { userId: user._id, requestId: recoveryRequest._id, metadata: { notificationType: 'email', reason } });
    });
    const cookie = `unichat_recovery_status=${statusToken}; Max-Age=900; Path=/api/auth/password-resets; HttpOnly; SameSite=${process.env.NODE_ENV === 'production' ? 'None; Secure' : 'Lax'}`;
    res.set('Set-Cookie', cookie);
    return res.json(generic);
  } catch (error) { next(error); }
});

router.get('/status', statusLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const statusToken = String(req.query.token || cookieToken(req));
    if (!validToken(statusToken)) return res.status(404).json({ error: 'Recovery request not found' });
    const reset = await PasswordResetRequest.findOne({ statusTokenHash: tokenHash(statusToken) }).select('+statusTokenHash').lean();
    if (!reset) return res.status(404).json({ error: 'Recovery request not found' });
    await expireReset(reset);
    return res.json(publicStatus(reset));
  } catch (error) { next(error); }
});

router.get('/approval', statusLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.query.token || '');
    if (!validToken(token)) return res.status(404).json({ error: 'Approval link is invalid or expired' });
    const reset = await PasswordResetRequest.findOne({ 'approvalTokens.hash': tokenHash(token) }).select('+approvalTokens').populate('user', 'displayName username email');
    if (!reset) return res.status(404).json({ error: 'Approval link is invalid or expired' });
    const tokenRecord = reset.approvalTokens.find((entry) => secureMatch(entry.hash, tokenHash(token)));
    if (reset.status !== 'pending' || !tokenRecord || tokenRecord.usedAt || tokenRecord.expiresAt <= new Date()) return res.json({ handled: true, status: reset.status });
    return res.json({ handled: false, request: { id: reset._id, employee: reset.user?.displayName || reset.user?.username, email: reset.user?.email, requestedAt: reset.requestedAt, userAgent: reset.userAgent, requestIp: reset.requestIp } });
  } catch (error) { next(error); }
});

router.post('/approval/:action', authenticate, requireSuperAdmin, statusLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.body?.token || req.query.token || '');
    const action = String(req.params.action || '');
    if (!['approve', 'reject'].includes(action) || !validToken(token)) return res.status(400).json({ error: 'Invalid approval request' });
    const hash = tokenHash(token);
    const reset = await PasswordResetRequest.findOne({ 'approvalTokens.hash': hash }).select('+approvalTokens +statusTokenHash').populate('user', 'displayName username email');
    if (!reset) return res.status(404).json({ error: 'Approval link is invalid or expired' });
    const tokenRecord = reset.approvalTokens.find((entry) => secureMatch(entry.hash, hash));
    if (reset.status !== 'pending' || !tokenRecord || tokenRecord.usedAt || tokenRecord.expiresAt <= new Date()) return res.status(409).json({ error: 'This recovery request has already been handled.' });
    // A link is bound to the approver it was issued to; another signed-in admin cannot use it.
    if (String(tokenRecord.approver) !== String(req.userId)) return res.status(403).json({ error: 'This approval link was issued to a different administrator.' });
    const approver = await User.findOne({ _id: tokenRecord.approver, role: 'SUPER_ADMIN', accountStatus: { $ne: 'disabled' } }).select('_id');
    if (!approver) return res.status(403).json({ error: 'This approval link is no longer authorized.' });
    const settings = await getRecoverySettings();
    const now = new Date();
    // Approval authorises recovery; it does not hand anything to the requester. The one-time code goes only
    // to the mailbox registered on the account, so the person who filed the request must also control it.
    const approving = action === 'approve';
    if (approving && !settings.otpEnabled) return res.status(409).json({ error: 'One-time-code recovery is disabled in Recovery settings.' });
    const generated = approving ? newCode(reset._id, settings.otpExpirationMinutes * 60 * 1000) : null;
    const set = approving
      ? { status: 'approved', approvedAt: now, approvedBy: tokenRecord.approver, approvalMethod: 'otp', verifiedAt: null, resetTokenHash: null, codeHash: generated.hash, expiresAt: generated.expiresAt, attempts: 0, 'approvalTokens.$.usedAt': now }
      : { status: 'rejected', approvedAt: null, approvedBy: tokenRecord.approver, approvalMethod: null, ...clearSecrets() };
    const handled = await PasswordResetRequest.findOneAndUpdate({ _id: reset._id, status: 'pending', approvalTokens: { $elemMatch: { hash, usedAt: null, expiresAt: { $gt: now } } } }, { $set: set }, { new: true });
    if (!handled) return res.status(409).json({ error: 'This recovery request has already been handled.' });
    let delivery = null;
    if (approving) {
      try {
        await sendEmail({ to: reset.user.email, subject: 'Reset your Unichat password', text: `An administrator approved your password recovery request.\n\nYour one-time code is ${generated.code}. It expires in ${settings.otpExpirationMinutes} minutes and can be used once. Never share it. If you did not request this, ignore this email and tell your administrator.` });
        delivery = 'SENT';
      } catch { delivery = 'FAILED'; console.error('Recovery code email could not be delivered'); }
      await PasswordResetRequest.updateOne({ _id: reset._id }, { $set: { emailNotificationStatus: delivery } });
    }
    await audit(req, approving ? 'PASSWORD_RECOVERY_APPROVED' : 'PASSWORD_RECOVERY_REJECTED', { userId: reset.user._id, requestId: reset._id, actorUserId: tokenRecord.approver, metadata: { approvalMethod: approving ? 'otp_emailed_to_account' : 'email', delivery } });
    req.app.get('io')?.to(`user:${tokenRecord.approver}`).emit('password-recovery:updated', { requestId: reset._id, status: handled.status });
    return res.json({ status: handled.status, directApproval: false, delivery, message: approving ? (delivery === 'SENT' ? 'Recovery approved. A one-time code was emailed to the account holder.' : 'Recovery approved, but the code email failed. Generate a code from the Admin Panel.') : 'Recovery request rejected.' });
  } catch (error) { next(error); }
});

router.post('/verify', verifyLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const email = emailFrom(req.body.email);
    const code = req.body.code;
    if (email === adminEmail() || typeof code !== 'string') return res.status(400).json({ error: 'Invalid recovery code' });
    if (!/^\d{6}$/.test(code || '') || !email) return res.status(400).json({ error: 'Invalid recovery code' });
    const settings = await getRecoverySettings();
    const maxAttempts = settings.maxOtpAttempts || MAX_ATTEMPTS;
    const user = await User.findOne({ email, accountStatus: { $ne: 'disabled' } }).select('_id');
    const reset = user && await PasswordResetRequest.findOne({ user: user._id, status: 'approved', approvalMethod: 'otp', verifiedAt: null }).sort({ approvedAt: -1 }).select('+codeHash');
    if (!reset || !reset.expiresAt || reset.expiresAt <= new Date() || reset.attempts >= maxAttempts) {
      if (reset && (reset.expiresAt <= new Date() || reset.attempts >= maxAttempts)) await PasswordResetRequest.updateOne({ _id: reset._id, status: 'approved' }, { $set: { status: reset.attempts >= maxAttempts ? 'locked' : 'expired', ...clearSecrets() } });
      return res.status(400).json({ error: 'Invalid or expired recovery code' });
    }
    if (!secureMatch(codeHash(reset._id, code), reset.codeHash)) {
      const changed = await PasswordResetRequest.findOneAndUpdate({ _id: reset._id, status: 'approved', attempts: { $lt: maxAttempts }, verifiedAt: null }, { $inc: { attempts: 1 } }, { new: true });
      if (changed?.attempts >= maxAttempts) { await PasswordResetRequest.updateOne({ _id: reset._id, status: 'approved' }, { $set: { status: 'locked', ...clearSecrets() } }); await audit(req, 'RECOVERY_OTP_LOCKED', { userId: user._id, requestId: reset._id }); }
      await audit(req, 'RECOVERY_OTP_FAILED', { userId: user._id, requestId: reset._id });
      return res.status(400).json({ error: 'Invalid or expired recovery code' });
    }
    const resetToken = newToken();
    const verified = await PasswordResetRequest.findOneAndUpdate({ _id: reset._id, status: 'approved', approvalMethod: 'otp', attempts: { $lt: maxAttempts }, verifiedAt: null, expiresAt: { $gt: new Date() } }, { $set: { status: 'verified', verifiedAt: new Date(), resetTokenHash: tokenHash(resetToken), codeHash: null } });
    if (!verified) return res.status(400).json({ error: 'Invalid or expired recovery code' });
    await audit(req, 'RECOVERY_OTP_VERIFIED', { userId: user._id, requestId: reset._id });
    return res.json({ resetToken, expiresAt: reset.expiresAt });
  } catch (error) { next(error); }
});

router.post('/complete', verifyLimit, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const email = emailFrom(req.body.email);
    const { resetToken, password, confirmPassword } = req.body;
    if (email === adminEmail()) return res.status(400).json({ error: 'Invalid reset details' });
    if (!validToken(resetToken) || !passwordValid(password) || password !== confirmPassword) return res.status(400).json({ error: 'Invalid reset details or password (minimum 10 characters)' });
    const user = await User.findOne({ email, accountStatus: { $ne: 'disabled' } }).select('+password +refreshToken +refreshSessions');
    const reset = user && await PasswordResetRequest.findOne({ user: user._id, status: 'verified', verifiedAt: { $ne: null }, expiresAt: { $gt: new Date() } }).sort({ verifiedAt: -1 }).select('+resetTokenHash');
    if (!reset || !secureMatch(tokenHash(resetToken), reset.resetTokenHash)) return res.status(400).json({ error: 'Invalid or expired reset session' });
    const consumed = await PasswordResetRequest.findOneAndUpdate({ _id: reset._id, status: reset.status, resetTokenHash: reset.resetTokenHash, expiresAt: { $gt: new Date() } }, { $set: { status: 'completed', usedAt: new Date(), resetTokenHash: null, codeHash: null, statusTokenHash: null, approvalTokens: [] } });
    if (!consumed) return res.status(400).json({ error: 'Invalid or expired reset session' });
    const hashedPassword = await bcrypt.hash(password, 12);
    await User.updateOne({ _id: user._id, accountStatus: 'active' }, { $set: { password: hashedPassword, refreshToken: null, refreshSessions: [], emailVerifiedAt: new Date() }, $inc: { sessionVersion: 1 } });
    await require('../services/pushNotifications').revokePushDevices(user._id);
    const io = req.app.get('io');
    if (io) (await io.in(`user:${user._id}`).fetchSockets()).forEach((socket) => socket.disconnect(true));
    await audit(req, 'PASSWORD_RECOVERY_COMPLETED', { userId: user._id, requestId: reset._id });
    await audit(req, 'PASSWORD_RESET_SUCCESS', { userId: user._id, requestId: reset._id });
    await audit(req, 'USER_SESSIONS_REVOKED', { userId: user._id, requestId: reset._id });
    return res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (error) { next(error); }
});

module.exports = router;
