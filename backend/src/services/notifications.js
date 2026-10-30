const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const Notification = require('../models/Notification');
const Message = require('../models/Message');
const MessageSeen = require('../models/MessageSeen');
const { ACTIVITY_TYPES } = require('./activity');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { NOTIFICATION_TYPE_VALUES, NOTIFICATION_TYPES, isImportantNotification, isSecurityNotification } = require('./notificationTypes');
const { sendPushToUser } = require('./pushNotifications');
const { sendWebPushToUser } = require('./webPush');

function asString(value) {
  return value == null ? null : value.toString();
}

function preferenceFor(user, workspaceId) {
  return user.notificationPreferences?.find((entry) => asString(entry.workspace) === asString(workspaceId)) || {
    level: 'all',
    dndUntil: null,
  };
}

function mutedId(preference, key, id) {
  return Boolean(id && preference?.[key]?.some((value) => asString(value) === asString(id)));
}

async function loadContext(payload) {
  const [channel, dm] = await Promise.all([
    payload.channel ? Channel.findById(payload.channel).select('members type workspace name') : null,
    payload.dm ? DirectMessage.findById(payload.dm).select('participants memberData workspace isGroup groupName') : null,
  ]);
  return { channel, dm };
}

function channelMember(channel, recipient) {
  return channel?.members?.find((entry) => asString(entry.user) === asString(recipient));
}

function dmMember(dm, recipient) {
  return dm?.memberData?.find((entry) => asString(entry.user) === asString(recipient));
}

// Which users currently have a socket in a room. fetchSockets goes through the adapter, so this is correct
// when the app runs on several instances (the previous in-memory lookup only saw sockets on this process).
async function usersInRoom(io, room) {
  if (!io || !room) return new Set();
  try { return new Set((await io.in(room).fetchSockets()).map((socket) => asString(socket.data?.userId)).filter(Boolean)); }
  catch { return new Set(); }
}

function allowedByPreferences({ user, preference, type, recipient, channel, dm, payload }) {
  // Security notifications are private system events and must not be hidden by
  // ordinary workspace DND or message notification preferences.
  if (!user) return false;
  if (type === 'workspace_join_request' || type === 'workspace_join_approved') return true;
  if (isSecurityNotification(type)) return user.notificationSettings?.securityAlerts !== false;
  if (preference.level === 'nothing' || preference.level === 'muted') return false;
  if (preference.dndUntil && new Date(preference.dndUntil).getTime() > Date.now()) return false;
  if (preference.level === 'mentions_dms' && !['mention', 'direct_message'].includes(type)) return false;
  if (preference.level === 'mentions' && type !== 'mention') return false;
  if (preference.level === 'important' && !isImportantNotification(type)) return false;
  if (type === 'mention' && user.notificationSettings?.mentions === false) return false;
  if (type === 'direct_message' && user.notificationSettings?.directMessages === false) return false;
  if (type === 'channel_message' && user.notificationSettings?.channelMessages === false) return false;
  if (type === 'thread_reply' && (user.notificationSettings?.threadReplies === false || preference.notifyThreadReplies === false)) return false;
  if (type === 'reaction' && (user.notificationSettings?.reactions === false || preference.notifyReactions === false)) return false;
  if (['call_invite', 'missed_call'].includes(type) && user.notificationSettings?.calls === false) return false;

  const member = channelMember(channel, recipient);
  if (channel && !member) return false;
  if (dm && !dm.participants?.some((id) => asString(id) === asString(recipient))) return false;

  const isDirectMention = type === 'mention';
  if (channel && member?.notificationLevel === 'nothing' && !isDirectMention) return false;
  if (dm && dmMember(dm, recipient)?.isMuted && !isDirectMention) return false;
  if (mutedId(preference, 'mutedChannels', payload.channel) && !isDirectMention) return false;
  if (mutedId(preference, 'mutedDMs', payload.dm) && !isDirectMention) return false;
  if (channel && member?.notificationLevel === 'mentions' && !isDirectMention && type !== 'thread_reply') return false;
  if (dm && dmMember(dm, recipient)?.notificationLevel === 'mentions' && !isDirectMention && type !== 'thread_reply') return false;
  return true;
}

function dedupeKeyFor(payload, recipient) {
  if (payload.dedupeKey) return payload.dedupeKey;
  if (payload.type === 'mention' && payload.message) return `mention:${payload.message}:${recipient}`;
  if (payload.type === 'thread_reply' && payload.message) return `thread_reply:${payload.message}:${recipient}`;
  if (payload.type === 'reaction' && payload.message) return `reaction:${payload.message}:${payload.actor}:${payload.metadata?.emoji || payload.content || ''}`;
  return undefined;
}

function serializeNotification(notification) {
  const value = notification.toObject ? notification.toObject() : notification;
  return { ...value, isRead: Boolean(value.readAt || value.isRead) };
}

// Creates notifications for many recipients using a fixed number of queries (independent of the recipient
// count): preload every referenced entity once, decide per recipient in memory, then write in bulk.
async function createNotifications(io, payloads) {
  const occurredAt = new Date();
  if (!Array.isArray(payloads) || payloads.length === 0) return [];
  const validPayloads = payloads.filter((payload) => payload?.recipient && NOTIFICATION_TYPE_VALUES.has(payload.type));
  if (!validPayloads.length) return [];

  const unique = (values) => [...new Set(values.filter(Boolean).map(asString))];
  const workspaceIds = unique(validPayloads.map((payload) => payload.workspace));
  const recipients = unique(validPayloads.map((payload) => payload.recipient));
  const messageIds = unique(validPayloads.map((payload) => payload.message));
  const [workspaces, users, messages] = await Promise.all([
    Workspace.find({ _id: { $in: workspaceIds }, 'members.user': { $in: recipients }, deletedAt: null }).select('_id name members').lean(),
    User.find({ _id: { $in: recipients }, accountStatus: { $ne: 'disabled' } }).select('notificationSettings notificationPreferences'),
    messageIds.length ? Message.find({ _id: { $in: messageIds } }).select('workspace channel dm thread createdAt content isDeleted').lean() : [],
  ]);
  const workspaceMap = new Map(workspaces.map((workspace) => [asString(workspace._id), { ...workspace, memberIds: new Set(workspace.members.map((member) => asString(member.user))) }]));
  const userMap = new Map(users.map((user) => [asString(user._id), user]));
  const messageMap = new Map(messages.map((message) => [asString(message._id), message]));

  // A message's own context overrides whatever the producer passed.
  const normalized = validPayloads.map((payload) => {
    const message = payload.message ? messageMap.get(asString(payload.message)) : null;
    return message ? { ...payload, channel: message.channel || undefined, dm: message.dm || undefined, threadParent: message.thread?.parentMessage || undefined } : payload;
  });
  const channelIds = unique(normalized.map((payload) => payload.channel));
  const dmIds = unique(normalized.map((payload) => payload.dm));
  const [channelDocs, dmDocs] = await Promise.all([
    channelIds.length ? Channel.find({ _id: { $in: channelIds } }).select('members type workspace name') : [],
    dmIds.length ? DirectMessage.find({ _id: { $in: dmIds } }).select('participants memberData workspace isGroup groupName') : [],
  ]);
  const channelMap = new Map(channelDocs.map((channel) => [asString(channel._id), channel]));
  const dmMap = new Map(dmDocs.map((dm) => [asString(dm._id), dm]));

  const candidates = [];
  const batchKeys = new Set();
  for (const payload of normalized) {
    const recipient = asString(payload.recipient);
    const actor = asString(payload.actor);
    if (!recipient || (actor && recipient === actor)) continue;
    const workspace = workspaceMap.get(asString(payload.workspace));
    const user = userMap.get(recipient);
    if (!workspace || !user || !workspace.memberIds.has(recipient)) continue;
    const channel = payload.channel ? channelMap.get(asString(payload.channel)) : null;
    const dm = payload.dm ? dmMap.get(asString(payload.dm)) : null;
    const preference = preferenceFor(user, payload.workspace);
    // Delivery preferences pause alerts; focused activity remains available to catch up.
    if (payload.channel && (!channel || !channelMember(channel, recipient))) continue;
    if (payload.dm && (!dm || !dm.participants.some((id) => asString(id) === recipient))) continue;
    const deliver = allowedByPreferences({ user, preference, type: payload.type, recipient, channel, dm, payload });
    if (!deliver && !ACTIVITY_TYPES.includes(payload.type)) continue;
    const dedupeKey = dedupeKeyFor(payload, recipient);
    if (dedupeKey) { const batchKey = `${recipient}\u0000${dedupeKey}`; if (batchKeys.has(batchKey)) continue; batchKeys.add(batchKey); }
    candidates.push({ payload, recipient, actor, user, preference, deliver, dedupeKey, channel, dm });
  }
  if (!candidates.length) return [];

  // Skip anything already recorded (one query for all recipients).
  const keyed = candidates.filter((candidate) => candidate.dedupeKey);
  if (keyed.length) {
    const existing = await Notification.find({ recipient: { $in: unique(keyed.map((c) => c.recipient)) }, dedupeKey: { $in: unique(keyed.map((c) => c.dedupeKey)) } }).select('recipient dedupeKey').lean();
    const known = new Set(existing.map((row) => `${asString(row.recipient)}\u0000${row.dedupeKey}`));
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index];
      if (candidate.dedupeKey && known.has(`${candidate.recipient}\u0000${candidate.dedupeKey}`)) candidates.splice(index, 1);
    }
    if (!candidates.length) return [];
  }

  // One bulk insert. If a concurrent producer wins a unique-key race, the survivors are still inserted and
  // we read back exactly which rows exist.
  const docs = candidates.map((candidate) => ({
    ...candidate.payload,
    _id: new mongoose.Types.ObjectId(),
    createdAt: occurredAt,
    recipient: candidate.recipient,
    actor: candidate.actor || undefined,
    metadata: { ...(candidate.payload.metadata || {}), sound: candidate.preference.playSound !== false, deliverySuppressed: !candidate.deliver },
    // Older deployments may have a unique index that treats a missing key as null: give every row a key.
    dedupeKey: candidate.dedupeKey || crypto.randomUUID(),
  }));
  try {
    await Notification.insertMany(docs, { ordered: false });
  } catch (error) {
    if (error?.code !== 11000 && !error?.writeErrors?.every?.((writeError) => writeError.code === 11000)) throw error;
  }
  const insertedIds = new Set((await Notification.find({ _id: { $in: docs.map((doc) => doc._id) } }).select('_id').lean()).map((row) => asString(row._id)));
  const inserted = candidates.map((candidate, index) => ({ candidate, doc: docs[index] })).filter(({ doc }) => insertedIds.has(asString(doc._id)));
  if (!inserted.length) return [];

  // A notification can finish inserting after the user has already seen its message: reconcile in bulk.
  const readIds = new Map();
  if (messageIds.length) {
    const seenRows = await MessageSeen.find({ user: { $in: unique(inserted.map(({ candidate }) => candidate.recipient)) }, message: { $in: messageIds } }).lean();
    const seenMap = new Map(seenRows.map((row) => [`${asString(row.user)}\u0000${asString(row.message)}`, row]));
    for (const { candidate, doc } of inserted) {
      const message = candidate.payload.message ? messageMap.get(asString(candidate.payload.message)) : null;
      const seen = message && seenMap.get(`${candidate.recipient}\u0000${asString(message._id)}`);
      const eventTime = candidate.payload.type === 'reaction' ? occurredAt : message?.createdAt;
      if (seen && eventTime && seen.seenAt >= eventTime) readIds.set(asString(doc._id), seen.seenAt);
    }
    if (readIds.size) await Notification.bulkWrite([...readIds].map(([id, readAt]) => ({ updateOne: { filter: { _id: id }, update: { $set: { isRead: true, readAt } } } })), { ordered: false, timestamps: false });
  }

  // Build the client-facing shape from data already in memory (no per-notification populate).
  const actorIds = unique(inserted.map(({ candidate }) => candidate.actor));
  const actorDocs = actorIds.length ? await User.find({ _id: { $in: actorIds } }).select('displayName avatar username status').lean() : [];
  const actorMap = new Map(actorDocs.map((actor) => [asString(actor._id), actor]));
  const created = [];
  const roomMembers = new Map();
  for (const { candidate, doc } of inserted) {
    const { payload, recipient, deliver } = candidate;
    const message = payload.message ? messageMap.get(asString(payload.message)) : null;
    const workspace = workspaceMap.get(asString(payload.workspace));
    const readAt = readIds.get(asString(doc._id));
    const serialized = {
      ...doc,
      isRead: Boolean(readAt),
      ...(readAt ? { readAt } : {}),
      actor: doc.actor ? actorMap.get(asString(doc.actor)) || doc.actor : doc.actor,
      message: message ? { _id: message._id, content: message.content, createdAt: message.createdAt, isDeleted: message.isDeleted } : doc.message,
      workspace: workspace ? { _id: workspace._id, name: workspace.name } : doc.workspace,
      channel: candidate.channel ? { _id: candidate.channel._id, name: candidate.channel.name, type: candidate.channel.type } : doc.channel,
      dm: candidate.dm ? { _id: candidate.dm._id, isGroup: candidate.dm.isGroup, groupName: candidate.dm.groupName } : doc.dm,
      updatedAt: occurredAt,
    };
    created.push(serialized);
    io?.to(`user:${recipient}`).emit('notification:new', serialized);
    if (!deliver || serialized.isRead) continue;
    sendWebPushToUser(candidate.user, serialized).catch((error) => console.warn('Web Push notification error:', error.message));
    const dnd = candidate.preference.dndUntil && new Date(candidate.preference.dndUntil).getTime() > Date.now();
    if (dnd) continue;
    const room = payload.channel ? `channel:${payload.channel}` : payload.dm ? `dm:${payload.dm}` : null;
    if (room && !roomMembers.has(room)) roomMembers.set(room, usersInRoom(io, room));
    Promise.resolve(room ? roomMembers.get(room) : new Set()).then((present) => {
      // Someone looking at the conversation does not also get a phone push.
      if (!present.has(recipient)) return sendPushToUser(candidate.user, serialized);
      return undefined;
    }).catch((error) => console.warn('Push notification error:', error.message));
  }
  return created;
}

function defaultPreference(workspaceId) {
  return {
    workspace: workspaceId, level: 'all', notifyThreadReplies: true,
    notifyReactions: true, playSound: true, mutedChannels: [], mutedDMs: [], dndUntil: null,
  };
}

// `notify` is the public service name used by new event producers. Keep the
// legacy export so existing routes do not need a risky all-at-once migration.
const notify = createNotifications;

module.exports = { createNotifications, notify, defaultPreference, preferenceFor, asString, usersInRoom, NOTIFICATION_TYPES };
