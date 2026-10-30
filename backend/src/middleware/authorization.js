const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const Message = require('../models/Message');

function isValidId(value) {
  return Boolean(value && mongoose.isValidObjectId(value));
}

function resolveUserId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value._id) return resolveUserId(value._id);
  return value.toString();
}

// `light: true` loads only the caller's own member entry instead of the whole members array. In a workspace
// with thousands of people the full array is hundreds of KB on every request; membership and role checks
// (isMember / isAdmin / getMember for THIS user) work identically on the slice. Use the default (full) only
// where the code needs other members, e.g. validating a list of people to add.
async function getWorkspaceContext(workspaceId, userId, { light = false } = {}) {
  if (!isValidId(workspaceId)) return { status: 404, error: 'Workspace not found' };

  const workspace = light
    ? await Workspace.findById(workspaceId).select({ name: 1, slug: 1, owner: 1, deletedAt: 1, isArchived: 1, members: { $elemMatch: { user: userId } } })
    : await Workspace.findById(workspaceId);
  if (!workspace || workspace.deletedAt || workspace.isArchived) return { status: 404, error: 'Workspace not found' };
  if (!workspace.isMember(userId)) return { status: 403, error: 'Not a member of this workspace' };

  return { workspace };
}

// Roles inside a channel. Workspace owners/admins may manage PUBLIC channels without joining them.
// Private channels are different: a workspace admin is not automatically a member, so they cannot read
// or manage a private channel they were not invited to (this keeps "admin" from meaning "reads everything").
async function getChannelContext(channelId, userId, { requireMembership = false, writable = false, manage = false, light = false } = {}) {
  if (!isValidId(channelId)) return { status: 404, error: 'Channel not found' };

  const channel = light
    ? await Channel.findById(channelId).select({ workspace: 1, name: 1, type: 1, isDefault: 1, isArchived: 1, createdBy: 1, topic: 1, description: 1, members: { $elemMatch: { user: userId } } })
    : await Channel.findById(channelId);
  if (!channel) return { status: 404, error: 'Channel not found' };

  const workspaceContext = await getWorkspaceContext(channel.workspace, userId, { light });
  if (workspaceContext.error) return workspaceContext;
  // Archived channels stay readable but reject every write-style operation.
  if (writable && channel.isArchived) return { status: 403, error: 'This channel is archived' };

  const isChannelMember = channel.isMember(userId);
  const workspaceAdmin = Boolean(workspaceContext.workspace.isAdmin(userId));
  const allowedWithoutMembership = manage && channel.type === 'public' && workspaceAdmin;
  if ((channel.type === 'private' || requireMembership || manage) && !isChannelMember && !allowedWithoutMembership) {
    return { status: 403, error: 'Not a member of this channel' };
  }
  const member = channel.members.find((entry) => resolveUserId(entry.user) === String(userId));
  const isChannelAdmin = member?.role === 'admin';
  return { channel, workspace: workspaceContext.workspace, isChannelMember, isChannelAdmin, canManage: isChannelAdmin || (workspaceAdmin && (channel.type === 'public' || isChannelMember)) };
}

async function getDMContext(dmId, userId, { light = false } = {}) {
  if (!isValidId(dmId)) return { status: 404, error: 'Conversation not found' };

  const dm = await DirectMessage.findById(dmId);
  if (!dm) return { status: 404, error: 'Conversation not found' };

  const workspaceContext = await getWorkspaceContext(dm.workspace, userId, { light });
  if (workspaceContext.error) return workspaceContext;
  if (!dm.participants.some((participant) => resolveUserId(participant) === String(userId))) {
    return { status: 403, error: 'Not a member of this conversation' };
  }

  return { dm, workspace: workspaceContext.workspace };
}

async function getThreadContext(messageId, userId) {
  if (!isValidId(messageId)) return { status: 404, error: 'Message not found' };
  const message = await Message.findById(messageId);
  if (!message || message.isDeleted) return { status: 404, error: 'Message not found' };

  const parent = message.thread?.parentMessage
    ? await Message.findById(message.thread.parentMessage)
    : message;
  if (!parent || parent.isDeleted || (!parent.channel && !parent.dm)) {
    return { status: 400, error: 'Invalid thread parent' };
  }

  const access = parent.channel
    ? await getChannelContext(parent.channel, userId, { light: true })
    : await getDMContext(parent.dm, userId, { light: true });
  if (access.error) return access;
  if (String(parent.workspace) !== String(access.workspace._id)) {
    return { status: 403, error: 'Message workspace does not match conversation workspace' };
  }

  return { message, parent, ...access };
}

async function getMessageContext(messageId, userId, { allowDeleted = false, light = true } = {}) {
  if (!isValidId(messageId)) return { status: 404, error: 'Message not found' };
  const message = await Message.findById(messageId);
  if (!message || (!allowDeleted && message.isDeleted)) return { status: 404, error: 'Message not found' };
  const access = message.channel
    ? await getChannelContext(message.channel, userId, { light })
    : await getDMContext(message.dm, userId, { light });
  if (access.error) return access;
  if (String(message.workspace) !== String(access.workspace._id)) return { status: 403, error: 'Message workspace does not match conversation workspace' };
  return { message, ...access };
}

function sendAuthorizationError(res, result) {
  return res.status(result.status || 403).json({ error: result.error });
}

async function requireWorkspaceMember(req, res, next) {
  try {
    const workspaceId = req.params.workspaceId || req.body.workspaceId || req.query.workspaceId;
    const result = await getWorkspaceContext(workspaceId, req.userId);
    if (result.error) return sendAuthorizationError(res, result);
    req.workspace = result.workspace;
    next();
  } catch (err) {
    next(err);
  }
}

async function requireWorkspaceAdmin(req, res, next) {
  try {
    if (!req.workspace) {
      const workspaceId = req.params.workspaceId || req.body.workspaceId || req.query.workspaceId;
      const result = await getWorkspaceContext(workspaceId, req.userId);
      if (result.error) return sendAuthorizationError(res, result);
      req.workspace = result.workspace;
    }

    if (!req.workspace.isAdmin(req.userId)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireChannelAccess({ requireMembership = false } = {}) {
  return async (req, res, next) => {
    try {
      const channelId = req.params.channelId || req.body.channelId || req.query.channelId;
      const result = await getChannelContext(channelId, req.userId, { requireMembership });
      if (result.error) return sendAuthorizationError(res, result);
      req.channel = result.channel;
      req.workspace = result.workspace;
      req.isChannelMember = result.isChannelMember;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  getWorkspaceContext,
  getChannelContext,
  getDMContext,
  getThreadContext,
  getMessageContext,
  requireWorkspaceMember,
  requireWorkspaceAdmin,
  requireChannelAccess,
};
