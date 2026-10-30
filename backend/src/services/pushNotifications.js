const User = require('../models/User');
const PushDevice = require('../models/PushDevice');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function isExpoPushToken(token) {
  return typeof token === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token);
}

function previewText(value, enabled) {
  if (!enabled || !value) return 'Open Unichat to view this notification';
  return String(value).replace(/<@[^>]+>/g, '@someone').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Open Unichat to view this notification';
}

function destinationData(notification) {
  return {
    notificationId: String(notification._id),
    type: notification.type,
    workspaceId: String(notification.workspace?._id || notification.workspace || ''),
    channelId: notification.channel?._id ? String(notification.channel._id) : notification.channel ? String(notification.channel) : undefined,
    dmId: notification.dm?._id ? String(notification.dm._id) : notification.dm ? String(notification.dm) : undefined,
    messageId: notification.message?._id ? String(notification.message._id) : notification.message ? String(notification.message) : undefined,
    threadParentId: notification.threadParent?._id ? String(notification.threadParent._id) : notification.threadParent ? String(notification.threadParent) : undefined,
  };
}

// Push credentials die with the session: call on logout (sessionId) or on any revocation (no sessionId).
async function revokePushDevices(userId, sessionId) {
  await PushDevice.deleteMany({ user: userId, ...(sessionId ? { sessionId } : {}) });
}

async function registerPushDevice(userId, sessionId, token, platform = '') {
  // Reassigns the token if another account previously registered it on this device.
  await PushDevice.findOneAndUpdate({ token }, { $set: { user: userId, sessionId: sessionId || null, platform: String(platform).slice(0, 20), lastUsedAt: new Date() } }, { upsert: true });
  await User.updateMany({ pushTokens: token }, { $pull: { pushTokens: token } });
}

async function sendPushToUser(user, notification) {
  if (!user?.notificationSettings?.pushEnabled) return;
  const devices = await PushDevice.find({ user: user._id }).select('token').lean();
  const tokens = [...new Set(devices.map((device) => device.token).filter(isExpoPushToken))];
  if (!tokens.length) return;

  const actor = notification.actor?.displayName || (notification.type === 'system' ? 'Unichat' : 'New activity');
  const labels = {
    mention: 'mentioned you', thread_reply: 'replied in a thread', reaction: 'reacted to your message',
    direct_message: 'sent you a message', channel_message: 'posted a message', channel_invite: 'invited you to a channel',
    workspace_invite: 'invited you to a workspace', workspace_join_approved: 'accepted your request to join', system: 'notification',
    file_shared: 'shared a file', call_invite: 'started a call', missed_call: 'missed call',
    password_recovery: 'requested password recovery', security_alert: 'security alert', admin_alert: 'admin alert',
  };
  const body = user.notificationSettings.pushPreview === false
    ? `${actor} ${labels[notification.type] || 'sent an update'}`
    : previewText(notification.message?.content || notification.content || notification.metadata?.preview, true);
  const messages = tokens.map((to) => ({
    to,
    title: actor,
    body,
    sound: user.notificationSettings.sounds === false || notification.metadata?.sound === false ? null : 'default',
    priority: 'high',
    channelId: 'messages',
    data: destinationData(notification),
  }));

  for (let offset = 0; offset < messages.length; offset += 100) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST', headers, body: JSON.stringify(messages.slice(offset, offset + 100)),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(`Expo push API returned ${response.status}`);
      const result = await response.json();
      const tickets = result.data || [];
      const invalid = tickets.flatMap((ticket, index) => ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered'
        ? [messages[offset + index]?.to] : []).filter(Boolean);
      if (invalid.length) await PushDevice.deleteMany({ token: { $in: invalid } });
    } catch (error) {
      console.warn('Push delivery failed:', error.message);
    }
  }
}

module.exports = { sendPushToUser, isExpoPushToken, revokePushDevices, registerPushDevice };
