const User = require('../models/User');
const RecoverySettings = require('../models/RecoverySettings');

const DEFAULTS = Object.freeze({
  directApprovalEnabled: false,
  otpEnabled: true,
  otpExpirationMinutes: 10,
  maxOtpAttempts: 5,
  approvalLinkExpirationMinutes: 15,
});

async function getRecoverySettings() {
  const stored = await RecoverySettings.findOne({ key: 'default' }).populate('approvers.user', 'displayName email role accountStatus workspaces').lean();
  if (stored) return { ...DEFAULTS, ...stored, directApprovalEnabled: false, approvers: stored.approvers || [] };
  const fallback = await User.findOne({ role: 'SUPER_ADMIN', accountStatus: { $ne: 'disabled' } }).sort({ createdAt: 1 }).select('displayName email role accountStatus workspaces').lean();
  return {
    ...DEFAULTS,
    approvers: fallback ? [{ user: fallback, notificationEmail: process.env.ADMIN_EMAIL || fallback.email, emailNotifications: true, inAppNotifications: true }] : [],
  };
}

module.exports = { DEFAULTS, getRecoverySettings };
