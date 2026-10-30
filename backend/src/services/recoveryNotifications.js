const Workspace = require('../models/Workspace');
const { getRecoverySettings } = require('./recoveryConfiguration');
const { tokenHash, newToken } = require('./passwordRecovery');
const { createNotifications } = require('./notifications');
const { audit } = require('./adminSecurity');
const { configured: emailConfigured, sendEmail } = require('./emailService');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function reviewUrl(requestId) {
  const configured = process.env.RECOVERY_REVIEW_URL || `${process.env.CLIENT_URL || ''}/admin`;
  if (!configured) return null;
  const separator = configured.includes('?') ? '&' : '?';
  return `${configured}${separator}tab=password-resets&requestId=${encodeURIComponent(String(requestId))}`;
}

function emailContent({ user, request, approver }) {
  const link = reviewUrl(request._id);
  const name = escapeHtml(user.displayName || user.username || 'Unichat user');
  const email = escapeHtml(user.email);
  const device = escapeHtml(request.userAgent || 'Unknown');
  const ip = escapeHtml(request.requestIp || 'Unknown');
  const requested = new Date(request.requestedAt).toISOString();
  return {
    from: process.env.SMTP_FROM || process.env.SMTP_USER || approver.notificationEmail,
    to: approver.notificationEmail,
    subject: `[Unichat] Password recovery request — ${user.displayName || user.username}`,
    text: `Unichat Password Recovery Request\n\nEmployee: ${user.displayName || user.username}\nEmail: ${user.email}\nRequested: ${requested}\nDevice/browser: ${request.userAgent || 'Unknown'}\nIP: ${request.requestIp || 'Unknown'}\n\nReview: ${link || 'Open the Unichat Admin Panel to review this request.'}`,
    html: `<main style="font-family:Arial,sans-serif;line-height:1.5;color:#172033"><h2>Unichat Security</h2><p><strong>Password recovery request</strong></p><dl><dt>Employee</dt><dd>${name}</dd><dt>Email</dt><dd>${email}</dd><dt>Requested</dt><dd>${requested}</dd><dt>Device/browser</dt><dd>${device}</dd><dt>IP address</dt><dd>${ip}</dd></dl>${link ? `<p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Review Request</a></p><p style="font-size:12px;color:#667085">You must sign in as a SUPER_ADMIN before approving, rejecting, or generating a recovery code.</p>` : '<p>Open the Unichat Admin Panel to review this request.</p>'}</main>`,
  };
}

async function markEmailState(request, status, errorMessage = '') {
  request.emailNotificationStatus = status;
  request.emailNotificationAttempts = (request.emailNotificationAttempts || 0) + 1;
  request.emailLastAttemptAt = new Date();
  request.emailLastError = errorMessage.slice(0, 300);
  if (status === 'SENT') request.emailSentAt = new Date();
  await request.save();
}

async function notifyRecoveryApprovers({ req, request, user }) {
  const settings = await getRecoverySettings();
  const approvers = (settings.approvers || []).filter((entry) => entry.user && entry.user.accountStatus !== 'disabled');
  const emailApprovers = approvers.filter((entry) => entry.emailNotifications && /^\S+@\S+\.\S+$/.test(entry.notificationEmail || ''));
  // Rebuild the token records with the raw values kept only in this local scope.
  // Keep existing approval token storage for compatibility with the secure
  // recovery service, but never place these authorization tokens in email URLs.
  const tokenRecords = emailApprovers.map((entry) => {
    const token = newToken();
    return { entry, token, record: { approver: entry.user._id || entry.user, hash: tokenHash(token), expiresAt: new Date(Date.now() + settings.approvalLinkExpirationMinutes * 60 * 1000) } };
  });
  request.approvalTokens = tokenRecords.map((item) => item.record);
  request.emailNotificationStatus = 'PENDING';
  await request.save();

  const io = req?.app?.get('io');
  const inAppPayloads = [];
  for (const entry of approvers.filter((item) => item.inAppNotifications)) {
    const approverId = entry.user._id || entry.user;
    const workspaces = await Workspace.find({ 'members.user': approverId, deletedAt: null }).select('_id').lean();
    for (const workspace of workspaces) inAppPayloads.push({
      recipient: approverId,
      workspace: workspace._id,
      type: 'password_recovery',
      content: `${user.displayName || user.username} requested a password reset.`,
      metadata: { requestId: String(request._id), preview: `${user.displayName || user.username} requested a password reset.` },
      dedupeKey: `password_recovery:${request._id}:${approverId}:${workspace._id}`,
    });
  }
  if (inAppPayloads.length) {
    try {
      const created = await createNotifications(io, inAppPayloads);
      await Promise.all(created.map((notification) => audit(req, 'RECOVERY_IN_APP_NOTIFICATION_SENT', {
        userId: user._id,
        requestId: request._id,
        actorUserId: notification.recipient,
        metadata: { recipient: String(notification.recipient), notificationId: String(notification._id) },
      })));
    } catch (error) {
      await audit(req, 'RECOVERY_IN_APP_NOTIFICATION_FAILED', {
        userId: user._id,
        requestId: request._id,
        metadata: { reason: String(error.message || 'In-app notification failed').slice(0, 160) },
      });
    }
  }

  if (!tokenRecords.length || !emailConfigured() || !reviewUrl(request._id)) {
    const reason = !tokenRecords.length ? 'No recovery email approver is configured' : (!emailConfigured() ? 'SMTP is not configured' : 'Recovery review URL is not configured');
    await markEmailState(request, 'FAILED', reason);
    await audit(req, 'RECOVERY_NOTIFICATION_FAILED', { userId: user._id, requestId: request._id, metadata: { reason, notificationType: 'email' } });
    return { emailStatus: 'FAILED', inAppCount: inAppPayloads.length };
  }

  const deliveries = await Promise.allSettled(emailApprovers.map((entry) => sendEmail(emailContent({ user, request, approver: entry }))));
  const failed = deliveries.filter((result) => result.status === 'rejected');
  if (failed.length === 0) {
    await markEmailState(request, 'SENT');
    await audit(req, 'RECOVERY_NOTIFICATION_SENT', { userId: user._id, requestId: request._id, metadata: { notificationType: 'email', approverCount: tokenRecords.length } });
    return { emailStatus: 'SENT', inAppCount: inAppPayloads.length };
  }
  const reason = failed[0].reason?.message || 'Email delivery failed';
  await markEmailState(request, 'FAILED', reason);
  await audit(req, 'RECOVERY_NOTIFICATION_FAILED', { userId: user._id, requestId: request._id, metadata: { notificationType: 'email', reason: reason.slice(0, 120), failedCount: failed.length } });
  return { emailStatus: 'FAILED', inAppCount: inAppPayloads.length };
}

module.exports = { notifyRecoveryApprovers, reviewUrl };
