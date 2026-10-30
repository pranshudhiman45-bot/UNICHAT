const express = require('express');
const { describeError } = require('../utils/logSafe');
const mongoose = require('mongoose');
const router = express.Router();
const Notification = require('../models/Notification');
const activity = require('../services/activity');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const { authenticate } = require('../middleware/auth');
const { defaultPreference, asString } = require('../services/notifications');

const FILTER_TYPES = {
  all: null,
  mentions: ['mention'],
  threads: ['thread_reply'],
  reactions: ['reaction'],
  dms: ['direct_message'],
  channels: ['channel_message'],
  security: ['password_recovery', 'security_alert', 'admin_alert'],
};

function unreadQuery() {
  return { isRead: { $ne: true }, readAt: null };
}

function serialize(notification) {
  const value = notification.toObject ? notification.toObject() : notification;
  return { ...value, isRead: Boolean(value.readAt || value.isRead) };
}

async function requireWorkspace(workspaceId, userId) {
  if (!mongoose.isValidObjectId(workspaceId)) return { error: 'Valid workspaceId is required', status: 400 };
  const workspace = await Workspace.findOne({ _id: workspaceId, 'members.user': userId, deletedAt: null }).select('_id members');
  if (!workspace) return { error: 'Not a workspace member', status: 403 };
  return { workspace };
}

async function canViewNotification(notification, userId) {
  if (!notification.workspace || notification.workspace.deletedAt || !notification.workspace.members?.some((member) => asString(member.user) === asString(userId))) return false;
  if (['password_recovery', 'security_alert', 'admin_alert'].includes(notification.type)) return notification.recipient && asString(notification.recipient) === asString(userId);
  if (['mention', 'thread_reply', 'reaction', 'direct_message', 'channel_message'].includes(notification.type) && !notification.message) return false;
  if (notification.message && notification.message.isDeleted) return false;
  if (notification.channel) {
    if (notification.channel.type === 'private' && !notification.channel.members?.some((member) => asString(member.user) === asString(userId))) return false;
    if (notification.channel.type !== 'private' && !notification.workspace.members.some((member) => asString(member.user) === asString(userId))) return false;
  }
  if (notification.dm && !notification.dm.participants?.some((participant) => asString(participant?._id || participant) === asString(userId))) return false;
  return true;
}

function baseQuery(req) {
  const query = { recipient: req.userId };
  if (req.query.workspaceId) query.workspace = req.query.workspaceId;
  if (req.query.unreadOnly === 'true') Object.assign(query, unreadQuery());
  const filter = String(req.query.filter || 'all');
  if (!Object.prototype.hasOwnProperty.call(FILTER_TYPES, filter)) return { error: 'Invalid notification filter' };
  if (FILTER_TYPES[filter]) query.type = { $in: FILTER_TYPES[filter] };
  return { query };
}

function applyCursor(query, cursor) {
  if (!cursor) return query;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed.createdAt || !Number.isFinite(new Date(parsed.createdAt).getTime()) || typeof parsed.id !== 'string' || !mongoose.isValidObjectId(parsed.id)) return null;
    query.$and = [...(query.$and || []), { $or: [
      { createdAt: { $lt: new Date(parsed.createdAt) } },
      { createdAt: new Date(parsed.createdAt), _id: { $lt: parsed.id } },
    ] }];
    return query;
  } catch {
    return null;
  }
}

function nextCursor(last) {
  return last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last._id })).toString('base64url') : null;
}

async function populateNotifications(query, limit) {
  return Notification.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .populate('actor', 'displayName avatar username status')
    .populate('message', 'content formattedContent attachments createdAt isDeleted thread')
    .populate({ path: 'workspace', select: 'name members deletedAt' })
    .populate({ path: 'channel', select: 'name type members' })
    .populate({ path: 'dm', select: 'isGroup groupName participants', populate: { path: 'participants', select: 'displayName avatar username status' } })
    .populate('threadParent', '_id')
    .lean();
}

async function getPreference(userId, workspaceId) {
  const user = await User.findById(userId).select('notificationPreferences');
  return user?.notificationPreferences?.find((entry) => asString(entry.workspace) === asString(workspaceId)) || defaultPreference(workspaceId);
}

async function savePreference(userId, workspaceId, changes) {
  const user = await User.findById(userId).select('notificationPreferences');
  if (!user) return null;
  let preference = user.notificationPreferences.find((entry) => asString(entry.workspace) === asString(workspaceId));
  if (!preference) {
    user.notificationPreferences.push({ workspace: workspaceId, level: 'all', dndUntil: null });
    preference = user.notificationPreferences[user.notificationPreferences.length - 1];
  }
  if (changes.level !== undefined) preference.level = changes.level;
  if (changes.notifyThreadReplies !== undefined) preference.notifyThreadReplies = changes.notifyThreadReplies;
  if (changes.notifyReactions !== undefined) preference.notifyReactions = changes.notifyReactions;
  if (changes.playSound !== undefined) preference.playSound = changes.playSound;
  if (changes.mutedChannels !== undefined) preference.mutedChannels = changes.mutedChannels;
  if (changes.mutedDMs !== undefined) preference.mutedDMs = changes.mutedDMs;
  if (changes.dndUntil !== undefined) preference.dndUntil = changes.dndUntil;
  await user.save();
  return {
    workspace: workspaceId, level: preference.level,
    notifyThreadReplies: preference.notifyThreadReplies !== false,
    notifyReactions: preference.notifyReactions !== false,
    playSound: preference.playSound !== false,
    mutedChannels: preference.mutedChannels || [], mutedDMs: preference.mutedDMs || [], dndUntil: preference.dndUntil,
  };
}

// Explicit message visibility receipts. A fetch or socket subscription is not proof of reading.
router.post('/read-messages', authenticate, async (req, res, next) => {
  try {
    const { workspaceId, messageIds } = req.body || {};
    if (typeof workspaceId !== 'string' || !mongoose.isValidObjectId(workspaceId) || !Array.isArray(messageIds) || !messageIds.length || messageIds.length > 100 || messageIds.some(value => typeof value !== 'string' || !mongoose.isValidObjectId(value))) return res.status(400).json({ error: 'Provide a workspace and 1–100 valid message IDs' });
    const result = await activity.seeMessages(req.app.get('io'), req.userId, workspaceId, [...new Set(messageIds)]);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (error) { next(error); }
});

// GET /api/notifications
router.get('/', authenticate, async (req, res) => {
  try {
    const workspaceAccess = req.query.workspaceId ? await requireWorkspace(req.query.workspaceId, req.userId) : null;
    if (workspaceAccess?.error) return res.status(workspaceAccess.status).json({ error: workspaceAccess.error });
    if (req.query.scope === 'activity') {
      const types = activity.FILTERS[String(req.query.filter || 'all')];
      if (!types) return res.status(400).json({ error: 'Invalid activity filter' });
      const match = { type: { $in: types }, clearedAt: req.query.cleared === 'true' ? { $ne: null } : null, ...(req.query.unreadOnly === 'true' ? activity.unread : {}) };
      const cursorQuery = applyCursor(match, req.query.cursor);
      if (!cursorQuery) return res.status(400).json({ error: 'Invalid cursor' });
      if (cursorQuery.$and) cursorQuery.$and.forEach(entry => entry.$or?.forEach(condition => { if (condition._id?.$lt) condition._id.$lt = new mongoose.Types.ObjectId(condition._id.$lt); }));
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 50);
      const rows = await Notification.aggregate([...(await activity.visibleActivity(req.userId, req.query.workspaceId)), { $match: cursorQuery }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: limit + 1 }]);
      const notifications = await populateNotifications({ _id: { $in: rows.slice(0, limit).map(row => row._id) } }, limit);
      return res.json({ notifications: notifications.map(serialize), unreadCount: await activity.activityCount(req.userId, req.query.workspaceId), nextCursor: rows.length > limit ? nextCursor(rows[limit - 1]) : null });
    }
    const prepared = baseQuery(req);
    if (prepared.error) return res.status(400).json({ error: prepared.error });
    const query = applyCursor(prepared.query, req.query.cursor);
    if (!query) return res.status(400).json({ error: 'Invalid cursor' });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 50);
    const raw = await populateNotifications(query, limit + 1);
    const visible = [];
    for (const notification of raw) {
      if (await canViewNotification(notification, req.userId)) visible.push(serialize(notification));
      if (visible.length === limit) break;
    }
    const hasMore = raw.length > limit;
    const unreadFilter = { recipient: req.userId, ...(req.query.workspaceId ? { workspace: req.query.workspaceId } : {}), ...unreadQuery() };
    const unreadCount = await Notification.countDocuments(unreadFilter);
    res.json({ notifications: visible, unreadCount, nextCursor: hasMore && visible.length ? nextCursor(visible[visible.length - 1]) : null });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const workspaceAccess = await requireWorkspace(req.query.workspaceId, req.userId);
    if (workspaceAccess.error) return res.status(workspaceAccess.status).json({ error: workspaceAccess.error });
    if (req.query.scope === 'activity') return res.json({ unreadCount: await activity.activityCount(req.userId, req.query.workspaceId) });
    const count = await Notification.countDocuments({ recipient: req.userId, workspace: req.query.workspaceId, ...unreadQuery() });
    res.json({ unreadCount: count });
  } catch {
    res.status(500).json({ error: 'Failed to fetch notification count' });
  }
});

router.patch('/:id/read', authenticate, async (req, res) => {
  try {
    const updated = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.userId },
      { $set: { readAt: new Date(), isRead: true } },
      { new: true },
    );
    if (!updated) return res.status(404).json({ error: 'Notification not found' });
    req.app.get('io').to(`user:${req.userId}`).emit('notification:read', { notificationId: updated._id, readAt: updated.readAt });
    activity.changed(req.app.get('io'), req.userId, updated.workspace);
    res.json({ notification: serialize(updated) });
  } catch {
    res.status(500).json({ error: 'Failed to mark notification read' });
  }
});

router.put('/:id/read', authenticate, async (req, res) => {
  req.url = `/${req.params.id}/read`;
  req.method = 'PATCH';
  return router.handle(req, res);
});

router.patch('/:id/unread', authenticate, async (req, res) => {
  try {
    const updated = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.userId },
      { $set: { readAt: null, isRead: false, clearedAt: null } },
      { new: true },
    );
    if (!updated) return res.status(404).json({ error: 'Notification not found' });
    req.app.get('io').to(`user:${req.userId}`).emit('notification:read', { notificationId: updated._id, readAt: null });
    activity.changed(req.app.get('io'), req.userId, updated.workspace);
    res.json({ notification: serialize(updated) });
  } catch {
    res.status(500).json({ error: 'Failed to mark notification unread' });
  }
});

router.patch('/:id/clear', authenticate, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Activity not found' });
    const now = new Date();
    const notification = await Notification.findOneAndUpdate({ _id: req.params.id, recipient: req.userId, type: { $in: activity.ACTIVITY_TYPES } }, { $set: { clearedAt: now, readAt: now, isRead: true } }, { new: true });
    if (!notification) return res.status(404).json({ error: 'Activity not found' });
    activity.changed(req.app.get('io'), req.userId, notification.workspace);
    res.json({ notification: serialize(notification) });
  } catch (error) { next(error); }
});

router.post('/read-all', authenticate, async (req, res) => {
  try {
    const query = { recipient: req.userId, ...unreadQuery() };
    if (req.body?.workspaceId) {
      const workspaceAccess = await requireWorkspace(req.body.workspaceId, req.userId);
      if (workspaceAccess.error) return res.status(workspaceAccess.status).json({ error: workspaceAccess.error });
      query.workspace = req.body.workspaceId;
    }
    if (req.body?.scope === 'activity') { query.type = { $in: activity.ACTIVITY_TYPES }; query.clearedAt = null; }
    const readAt = new Date();
    const result = await Notification.updateMany(query, { $set: { readAt, isRead: true } });
    req.app.get('io').to(`user:${req.userId}`).emit('notification:read_all', { workspaceId: req.body?.workspaceId || null, scope: req.body?.scope || 'all', readAt });
    res.json({ success: true, modifiedCount: result.modifiedCount || result.nModified || 0 });
  } catch {
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

router.put('/mark-all-read', authenticate, async (req, res) => {
  req.url = '/read-all';
  req.method = 'POST';
  return router.handle(req, res);
});

router.get('/preferences', authenticate, async (req, res) => {
  try {
    const access = await requireWorkspace(req.query.workspaceId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    res.json({ preference: await getPreference(req.userId, req.query.workspaceId) });
  } catch {
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.patch('/preferences', authenticate, async (req, res) => {
  try {
    const { workspaceId, level, dndUntil, channelId, dmId, muted, notifyThreadReplies, notifyReactions, playSound } = req.body || {};
    const access = await requireWorkspace(workspaceId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (level !== undefined && !['all', 'mentions_dms', 'mentions', 'important', 'nothing', 'muted'].includes(level)) return res.status(400).json({ error: 'Invalid notification level' });
    for (const [name, value] of Object.entries({ notifyThreadReplies, notifyReactions, playSound })) {
      if (value !== undefined && typeof value !== 'boolean') return res.status(400).json({ error: `${name} must be a boolean` });
    }
    if (dndUntil !== undefined && dndUntil !== null && Number.isNaN(new Date(dndUntil).getTime())) return res.status(400).json({ error: 'Invalid dndUntil value' });
    if (channelId) {
      const channel = await Channel.findOne({ _id: channelId, workspace: workspaceId });
      if (!channel || !channel.isMember(req.userId)) return res.status(403).json({ error: 'Not a channel member' });
      const member = channel.members.find((entry) => asString(entry.user) === asString(req.userId));
      member.notificationLevel = muted ? 'nothing' : 'all';
      await channel.save();
    }
    if (dmId) {
      const dm = await DirectMessage.findOne({ _id: dmId, workspace: workspaceId, participants: req.userId });
      if (!dm) return res.status(403).json({ error: 'Not a DM participant' });
      const member = dm.memberData.find((entry) => asString(entry.user) === asString(req.userId));
      if (member) {
        member.isMuted = Boolean(muted);
        member.notificationLevel = muted ? 'nothing' : 'all';
      }
      await dm.save();
    }
    const user = await User.findById(req.userId).select('notificationPreferences');
    const existingPreference = user?.notificationPreferences?.find((entry) => asString(entry.workspace) === asString(workspaceId));
    const mutedChannels = [...new Set((existingPreference?.mutedChannels || []).map(asString).filter(Boolean))];
    const mutedDMs = [...new Set((existingPreference?.mutedDMs || []).map(asString).filter(Boolean))];
    if (channelId) {
      const target = mutedChannels.indexOf(asString(channelId));
      if (muted ? target < 0 : target >= 0) muted ? mutedChannels.push(asString(channelId)) : mutedChannels.splice(target, 1);
    }
    if (dmId) {
      const target = mutedDMs.indexOf(asString(dmId));
      if (muted ? target < 0 : target >= 0) muted ? mutedDMs.push(asString(dmId)) : mutedDMs.splice(target, 1);
    }
    const preference = await savePreference(req.userId, workspaceId, {
      level, notifyThreadReplies, notifyReactions, playSound,
      mutedChannels, mutedDMs,
      dndUntil: dndUntil === undefined ? undefined : (dndUntil ? new Date(dndUntil) : null),
    });
    res.json({ preference });
  } catch {
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

module.exports = router;
