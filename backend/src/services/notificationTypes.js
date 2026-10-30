// Keep notification values stable on the wire while giving the backend one
// source of truth for validation, preference policy, and delivery priority.
const NOTIFICATION_TYPES = Object.freeze({
  MENTION: 'mention',
  THREAD_REPLY: 'thread_reply',
  REACTION: 'reaction',
  DIRECT_MESSAGE: 'direct_message',
  CHANNEL_MESSAGE: 'channel_message',
  CHANNEL_INVITE: 'channel_invite',
  WORKSPACE_INVITE: 'workspace_invite',
  WORKSPACE_JOIN_REQUEST: 'workspace_join_request',
  WORKSPACE_JOIN_APPROVED: 'workspace_join_approved',
  FILE_SHARED: 'file_shared',
  CALL_INVITE: 'call_invite',
  MISSED_CALL: 'missed_call',
  PASSWORD_RECOVERY: 'password_recovery',
  SECURITY_ALERT: 'security_alert',
  ADMIN_ALERT: 'admin_alert',
  SYSTEM: 'system',
});

const NOTIFICATION_TYPE_VALUES = new Set(Object.values(NOTIFICATION_TYPES));
const SECURITY_TYPES = new Set([
  NOTIFICATION_TYPES.PASSWORD_RECOVERY,
  NOTIFICATION_TYPES.SECURITY_ALERT,
  NOTIFICATION_TYPES.ADMIN_ALERT,
]);
const IMPORTANT_TYPES = new Set([
  NOTIFICATION_TYPES.MENTION,
  NOTIFICATION_TYPES.THREAD_REPLY,
  NOTIFICATION_TYPES.DIRECT_MESSAGE,
  NOTIFICATION_TYPES.REACTION,
  NOTIFICATION_TYPES.CALL_INVITE,
  NOTIFICATION_TYPES.MISSED_CALL,
  ...SECURITY_TYPES,
]);

function isSecurityNotification(type) { return SECURITY_TYPES.has(type); }
function isImportantNotification(type) { return IMPORTANT_TYPES.has(type); }

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_VALUES,
  SECURITY_TYPES,
  IMPORTANT_TYPES,
  isSecurityNotification,
  isImportantNotification,
};
