const webpush = require('web-push');
const WebPushSubscription = require('../models/WebPushSubscription');

function publicKey() {
  return process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT
    ? process.env.WEB_PUSH_PUBLIC_KEY : null;
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (
      host === 'fcm.googleapis.com'
      || host === 'updates.push.services.mozilla.com'
      || host === 'push.services.mozilla.com'
      || host === 'web.push.apple.com'
      || host.endsWith('.notify.windows.com')
    );
  } catch { return false; }
}

function notificationUrl(notification) {
  if (['password_recovery', 'security_alert', 'admin_alert'].includes(notification.type)) return '/admin?tab=password-resets';
  const workspaceId = String(notification.workspace?._id || notification.workspace || '');
  if (notification.type === 'workspace_join_request') return `/workspaces?review=${encodeURIComponent(workspaceId)}`;
  if (notification.type === 'workspace_join_approved') return `/chat/${encodeURIComponent(workspaceId)}`;
  const query = new URLSearchParams();
  const channelId = notification.channel?._id || notification.channel;
  const dmId = notification.dm?._id || notification.dm;
  const threadParentId = notification.threadParent?._id || notification.threadParent;
  if (channelId) query.set('channelId', String(channelId));
  if (dmId) query.set('dmId', String(dmId));
  if (threadParentId) query.set('threadParentId', String(threadParentId));
  if (notification.message) query.set('messageId', String(notification.message?._id || notification.message));
  return `/chat/${encodeURIComponent(workspaceId)}?${query.toString()}`;
}

async function sendWebPushToUser(user, notification) {
  if (user.notificationSettings?.webPushEnabled !== true || !publicKey()) return;
  const subscriptions = await WebPushSubscription.find({ user: user._id }).lean();
  if (!subscriptions.length) return;
  const actor = notification.actor?.displayName || 'Unichat';
  const content = notification.message?.content || notification.content || '';
  const preview = user.notificationSettings?.pushPreview === false
    ? 'Open Unichat to view this update'
    : String(content).replace(/<@[^>]+>/g, '@someone').replace(/\s+/g, ' ').trim().slice(0, 160) || 'New activity in Unichat';
  const payload = JSON.stringify({
    title: actor,
    body: preview,
    url: notificationUrl(notification),
    notificationId: String(notification._id),
    silent: user.notificationSettings?.sounds === false || notification.metadata?.sound === false,
  });
  const vapidDetails = {
    subject: process.env.WEB_PUSH_SUBJECT,
    publicKey: process.env.WEB_PUSH_PUBLIC_KEY,
    privateKey: process.env.WEB_PUSH_PRIVATE_KEY,
  };
  await Promise.allSettled(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
        vapidDetails, TTL: 3600, timeout: 8000,
      });
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await WebPushSubscription.deleteOne({ _id: subscription._id });
      } else {
        console.warn('Web Push delivery failed:', error.message);
      }
    }
  }));
}

module.exports = { publicKey, validEndpoint, sendWebPushToUser };
