const express = require('express');
const { describeError } = require('../utils/logSafe');
const mongoose = require('mongoose');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Channel = require('../models/Channel');
const Workspace = require('../models/Workspace');
const Message = require('../models/Message');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { getWorkspaceContext, getChannelContext } = require('../middleware/authorization');
const { createNotifications } = require('../services/notifications');
const { getUnreadCounts } = require('../utils/unreadCounts');
const { grantChannel, revokeChannel } = require('../socket/rooms');

router.param('channelId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Channel not found' }));
router.param('workspaceId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Workspace not found' }));
router.param('memberId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Member not found' }));

// Slack-style names: lowercase letters, digits, hyphen, underscore. Whitespace becomes a hyphen.
function normalizeChannelName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(name) ? name : null;
}
const CHANNEL_NAME_ERROR = 'Channel names may contain lowercase letters, numbers, hyphens and underscores (max 80 characters)';

// GET /api/channels/workspace/:workspaceId
router.get('/workspace/:workspaceId', authenticate, async (req, res) => {
  try {
    const workspace = await Workspace.findById(req.params.workspaceId);
    if (!workspace || workspace.deletedAt || !workspace.isMember(req.userId)) {
      return res.status(403).json({ error: 'Not a member' });
    }

    const channels = await Channel.find({
      workspace: req.params.workspaceId,
      isArchived: false,
      $or: [{ type: 'public' }, { 'members.user': req.userId }],
    }).populate('createdBy', 'displayName username').sort({ name: 1 });

    const unreadByChannel = await getUnreadCounts(Message, channels.map((channel) => {
      const member = channel.members.find((entry) => entry.user.toString() === req.userId);
      return { id: channel._id, lastRead: member?.lastRead };
    }), 'channel', req.userId);

    const channelsWithUnread = channels.map((ch) => {
      const chObj = ch.toObject();
      const memberData = ch.members.find(m => m.user.toString() === req.userId);
      if (memberData && memberData.lastRead) {
        const counts = unreadByChannel.get(String(ch._id));
        chObj.unreadCount = counts?.unreadCount || 0;
        chObj.mentionCount = counts?.mentionCount || 0;
        chObj.isMember = true;
      } else {
        chObj.unreadCount = 0;
        chObj.mentionCount = 0;
        chObj.isMember = ch.members.some(m => m.user.toString() === req.userId);
      }
      chObj.canPin = Boolean(workspace.isAdmin(req.userId) || memberData?.role === 'admin');
      chObj.canManage = Boolean(memberData?.role === 'admin' || (workspace.isAdmin(req.userId) && (ch.type === 'public' || memberData)));
      chObj.isMuted = memberData?.notificationLevel === 'nothing';
      return chObj;
    });

    res.json({ channels: channelsWithUnread });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// POST /api/channels - Create channel
router.post('/', authenticate, [
  body('name').isLength({ min: 1, max: 80 }).trim().toLowerCase(),
  body('workspaceId').isMongoId(),
  body('type').isIn(['public', 'private']).optional(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed' });

    const { workspaceId, description, type = 'public', memberIds = [] } = req.body;
    const name = normalizeChannelName(req.body.name);
    if (!name) return res.status(400).json({ error: CHANNEL_NAME_ERROR });

    const workspaceContext = await getWorkspaceContext(workspaceId, req.userId);
    if (workspaceContext.error) {
      return res.status(workspaceContext.status).json({ error: workspaceContext.error });
    }
    const workspace = workspaceContext.workspace;

    if (!Array.isArray(memberIds)) {
      return res.status(400).json({ error: 'memberIds must be an array' });
    }

    const uniqueMemberIds = [...new Set([req.userId, ...memberIds.map(String)])];
    const workspaceMemberIds = workspace.members.map((member) => member.user.toString());
    if (uniqueMemberIds.some((memberId) => !workspaceMemberIds.includes(memberId))) {
      return res.status(400).json({ error: 'All channel members must belong to the workspace' });
    }

    const existing = await Channel.findOne({ workspace: workspaceId, name: name.toLowerCase() });
    if (existing) return res.status(409).json({ error: `Channel #${name} already exists` });

    const initialMembers = uniqueMemberIds.map(uid => ({
      user: uid,
      role: uid === req.userId ? 'admin' : 'member',
    }));

    const channel = new Channel({
      workspace: workspaceId,
      name: name.toLowerCase(),
      description,
      type,
      createdBy: req.userId,
      members: initialMembers,
    });
    await channel.save();

    // System message
    await Message.create({
      workspace: workspaceId,
      channel: channel._id,
      sender: req.userId,
      content: `Channel #${name} created`,
      isSystemMessage: true,
      systemMessageType: 'channel_created',
    });

    const io = req.app.get('io');
    await Promise.all(channel.members.map((member) => grantChannel(io, member.user, channel._id)));
    if (channel.type === 'public') {
      io.to(`workspace:${workspaceId}`).emit('channel:created', channel);
    } else {
      channel.members.forEach((member) => {
        io.to(`user:${member.user}`).emit('channel:created', channel);
      });
    }

    res.status(201).json({ channel });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// GET /api/channels/:channelId/pins
router.get('/:channelId/pins', authenticate, async (req, res) => {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const channel = await Channel.findById(req.params.channelId)
      .populate({ path: 'pinnedMessages.message', populate: [
        { path: 'sender', select: 'displayName avatar username status' },
      ] })
      .populate('pinnedMessages.pinnedBy', 'displayName avatar username');
    const pinnedMessages = (channel?.pinnedMessages || []).filter((entry) => entry.message && !entry.message.isDeleted);
    res.json({ pinnedMessages });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to fetch pinned messages' });
  }
});

// GET /api/channels/:channelId
router.get('/:channelId', authenticate, async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId)
      .populate('members.user', 'displayName avatar username status')
      .populate('createdBy', 'displayName username')
      .populate({ path: 'pinnedMessages.message', populate: { path: 'sender', select: 'displayName avatar username' } });

    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const access = await getChannelContext(channel._id, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const channelData = channel.toObject();
    const member = channel.members.find((entry) => entry.user.toString() === req.userId);
    channelData.canPin = Boolean(access.workspace.isAdmin(req.userId) || member?.role === 'admin');
    channelData.canManage = Boolean(access.canManage);
    channelData.myRole = member?.role || null;
    channelData.isMuted = member?.notificationLevel === 'nothing';
    res.json({ channel: channelData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch channel' });
  }
});

// POST /api/channels/:channelId/join (public channels only)
router.post('/:channelId/join', authenticate, async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    // Authorize against the workspace first so nothing is revealed about channels in other workspaces.
    const workspaceContext = await getWorkspaceContext(channel.workspace, req.userId);
    if (workspaceContext.error) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type === 'private') return res.status(403).json({ error: 'Cannot join private channel' });
    if (channel.isArchived) return res.status(403).json({ error: 'This channel is archived' });
    if (channel.isMember(req.userId)) return res.status(409).json({ error: 'Already a member' });

    const joined = await Channel.findOneAndUpdate(
      { _id: channel._id, isArchived: false, 'members.user': { $ne: req.userId } },
      { $push: { members: { user: req.userId, role: 'member' } } },
      { new: true },
    );
    if (!joined) return res.status(409).json({ error: 'Already a member' });

    const io = req.app.get('io');
    await grantChannel(io, req.userId, channel._id);
    io.to(`channel:${channel._id}`).emit('channel:member_joined', { channelId: channel._id, userId: req.userId });

    res.json({ channel: joined });
  } catch (err) {
    res.status(500).json({ error: 'Failed to join channel' });
  }
});

// POST /api/channels/:channelId/leave
router.post('/:channelId/leave', authenticate, async (req, res) => {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId, { requireMembership: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { channel } = access;
    if (channel.isDefault) return res.status(400).json({ error: 'Cannot leave default channel' });
    // A channel must never be left without an administrator while it still has members.
    const others = channel.members.filter((m) => m.user.toString() !== req.userId);
    const otherAdmins = others.filter((m) => m.role === 'admin');
    if (access.isChannelAdmin && others.length && !otherAdmins.length) {
      return res.status(409).json({ error: 'You are the only admin. Make another member an admin before leaving.', code: 'LAST_CHANNEL_ADMIN' });
    }

    // Conditional update: concurrent leaves/removals cannot both succeed in orphaning the channel.
    const updated = await Channel.findOneAndUpdate(
      { _id: channel._id, 'members.user': req.userId, ...(access.isChannelAdmin && others.length ? { members: { $elemMatch: { user: { $ne: req.userId }, role: 'admin' } } } : {}) },
      { $pull: { members: { user: req.userId } } },
      { new: true },
    );
    if (!updated) return res.status(409).json({ error: 'Channel membership changed. Please try again.' });
    if (!updated.members.length && !updated.isArchived) { updated.isArchived = true; await updated.save(); } // nobody left: archive instead of orphaning

    const io = req.app.get('io');
    await revokeChannel(io, req.userId, channel._id);
    io.to(`channel:${channel._id}`).emit('channel:member_left', { channelId: channel._id, userId: req.userId });
    io.to(`user:${req.userId}`).emit('channel:removed', { channelId: channel._id, reason: 'left' });
    res.json({ message: 'Left channel' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

// PUT /api/channels/:channelId/mark-read
router.put('/:channelId/mark-read', authenticate, async (req, res) => {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId, { light: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    await Channel.updateOne(
      { _id: req.params.channelId, 'members.user': req.userId },
      { $set: { 'members.$.lastRead': new Date() } }
    );
    // Other devices of this user (and their badges) learn about the new read position.
    req.app.get('io').to(`user:${req.userId}`).emit('channel:read', { channelId: req.params.channelId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// Shared by PUT and PATCH. Requires channel admin, or workspace admin for public channels.
async function updateChannel(req, res) {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId, { manage: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { channel } = access;
    if (!access.canManage) return res.status(403).json({ error: 'Admin required' });

    const { name, description, topic, isArchived } = req.body || {};
    if (name !== undefined) {
      const normalized = normalizeChannelName(name);
      if (!normalized) return res.status(400).json({ error: CHANNEL_NAME_ERROR });
      if (channel.isDefault && normalized !== channel.name) return res.status(400).json({ error: 'Default channels cannot be renamed' });
      if (normalized !== channel.name && await Channel.exists({ workspace: channel.workspace, name: normalized, _id: { $ne: channel._id } })) return res.status(409).json({ error: `Channel #${normalized} already exists` });
      channel.name = normalized;
    }
    if (description !== undefined) { if (typeof description !== 'string' || description.length > 300) return res.status(400).json({ error: 'Description must be 300 characters or fewer' }); channel.description = description; }
    if (topic !== undefined) { if (typeof topic !== 'string' || topic.length > 250) return res.status(400).json({ error: 'Topic must be 250 characters or fewer' }); channel.topic = topic; }
    if (isArchived !== undefined) {
      if (channel.isDefault && isArchived) return res.status(400).json({ error: 'Cannot archive a default channel' });
      channel.isArchived = Boolean(isArchived);
    }
    await channel.save();
    const io = req.app.get('io');
    const audience = channel.type === 'public' ? `workspace:${channel.workspace}` : `channel:${channel._id}`;
    io.to(audience).emit(channel.isArchived ? 'channel:archived' : 'channel:updated', channel.isArchived ? { channelId: channel._id } : channel);
    res.json({ channel });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A channel with this name already exists' });
    res.status(500).json({ error: 'Failed to update channel' });
  }
}
router.put('/:channelId', authenticate, updateChannel);
router.patch('/:channelId', authenticate, updateChannel);

// DELETE archives (soft delete); PATCH { isArchived: false } restores.
router.delete('/:channelId', authenticate, async (req, res) => {
  req.body = { isArchived: true };
  return updateChannel(req, res);
});

// POST /api/channels/:channelId/invite
router.post('/:channelId/invite', authenticate, async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds must be a non-empty array' });
    }
    const access = await getChannelContext(req.params.channelId, req.userId, { manage: true, writable: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { channel, workspace } = access;
    if (!access.canManage) return res.status(403).json({ error: 'Admin required' });

    const workspaceMemberIds = workspace.members.map((entry) => entry.user.toString());
    const uniqueUserIds = [...new Set(userIds.map(String))];
    if (uniqueUserIds.length > 100) return res.status(400).json({ error: 'Invite at most 100 people at a time' });
    if (uniqueUserIds.some((userId) => !mongoose.isValidObjectId(userId) || !workspaceMemberIds.includes(userId))) {
      return res.status(400).json({ error: 'Invited users must belong to the workspace' });
    }

    const newMembers = uniqueUserIds.filter(uid => !channel.isMember(uid));
    if (newMembers.length) {
      // $ne guard makes a concurrent double-invite add each person once.
      await Channel.updateOne({ _id: channel._id }, { $push: { members: { $each: newMembers.map((uid) => ({ user: uid, role: 'member' })) } } });
    }
    const fresh = await Channel.findById(channel._id);

    const io = req.app.get('io');
    await createNotifications(io, newMembers.map((uid) => ({
      recipient: uid,
      workspace: channel.workspace,
      type: 'channel_invite',
      actor: req.userId,
      channel: channel._id,
      content: `You were invited to #${channel.name}`,
      metadata: { channelName: channel.name },
    })));
    const users = await User.find({ _id: { $in: newMembers } }).select('displayName');
    for (const addedUser of users) {
      await grantChannel(io, addedUser._id, channel._id);
      io.to(`user:${addedUser._id}`).emit('channel:invited', { channelId: channel._id, channel: fresh });
      const sysMsg = await Message.create({
        workspace: channel.workspace, channel: channel._id, sender: req.userId,
        content: `invited ${addedUser.displayName} to the channel`, isSystemMessage: true, systemMessageType: 'user_joined',
      });
      io.to(`channel:${channel._id}`).emit('channel:member_joined', { channelId: channel._id, userId: addedUser._id });
      io.to(`channel:${channel._id}`).emit('message:new', await sysMsg.populate('sender', 'displayName avatar username'));
    }

    res.json({ channel: fresh });
  } catch (err) {
    res.status(500).json({ error: 'Failed to invite members' });
  }
});

// PUT /api/channels/:channelId/members/:memberId/role { role: 'admin' | 'member' }
router.put('/:channelId/members/:memberId/role', authenticate, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'role must be "admin" or "member"' });
    const access = await getChannelContext(req.params.channelId, req.userId, { manage: true, writable: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (!access.canManage) return res.status(403).json({ error: 'Admin required' });
    const { channel } = access;
    const target = channel.members.find((m) => m.user.toString() === req.params.memberId);
    if (!target) return res.status(404).json({ error: 'User is not a member of this channel' });
    if (target.role === role) return res.json({ channel });
    if (role === 'member' && target.role === 'admin' && channel.members.filter((m) => m.role === 'admin').length <= 1) {
      return res.status(409).json({ error: 'A channel needs at least one admin. Promote someone else first.', code: 'LAST_CHANNEL_ADMIN' });
    }
    await Channel.updateOne({ _id: channel._id, 'members.user': req.params.memberId }, { $set: { 'members.$.role': role } });
    const fresh = await Channel.findById(channel._id);
    req.app.get('io').to(`channel:${channel._id}`).emit('channel:updated', fresh);
    res.json({ channel: fresh });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change role' });
  }
});

// DELETE /api/channels/:channelId/members/:memberId
router.delete('/:channelId/members/:memberId', authenticate, async (req, res) => {
  try {
    const access = await getChannelContext(req.params.channelId, req.userId, { manage: true, writable: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { channel } = access;
    if (!access.canManage) return res.status(403).json({ error: 'Admin required' });
    if (req.params.memberId === req.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
    const target = channel.members.find((m) => m.user.toString() === req.params.memberId);
    if (!target) return res.status(400).json({ error: 'User is not a member' });
    if (channel.isDefault) return res.status(400).json({ error: 'Members cannot be removed from a default channel' });
    if (target.role === 'admin' && channel.members.filter((m) => m.role === 'admin').length <= 1) {
      return res.status(409).json({ error: 'Cannot remove the only admin of a channel.', code: 'LAST_CHANNEL_ADMIN' });
    }

    await Channel.updateOne({ _id: channel._id }, { $pull: { members: { user: req.params.memberId } } });
    const fresh = await Channel.findById(channel._id);

    const io = req.app.get('io');
    await revokeChannel(io, req.params.memberId, channel._id);
    io.to(`channel:${channel._id}`).emit('channel:member_left', { channelId: channel._id, userId: req.params.memberId });
    io.to(`user:${req.params.memberId}`).emit('channel:removed', { channelId: channel._id, reason: 'removed' });

    const removedUser = await User.findById(req.params.memberId);
    if (removedUser) {
      const sysMsg = await Message.create({
        workspace: channel.workspace, channel: channel._id, sender: req.userId,
        content: `removed ${removedUser.displayName} from the channel`, isSystemMessage: true, systemMessageType: 'user_left',
      });
      io.to(`channel:${channel._id}`).emit('message:new', await sysMsg.populate('sender', 'displayName avatar username'));
    }

    res.json({ message: 'Member removed', channel: fresh });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;
