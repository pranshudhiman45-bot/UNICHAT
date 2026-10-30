const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const Message = require('../models/Message');
const MessageSeen = require('../models/MessageSeen');
const { getChannelContext, getDMContext } = require('../middleware/authorization');
const ACTIVITY_TYPES = ['mention', 'thread_reply', 'reaction', 'channel_invite', 'workspace_invite', 'workspace_join_request', 'workspace_join_approved'];
const MESSAGE_TYPES = ['mention', 'thread_reply', 'reaction'];
const FILTERS = { all: ACTIVITY_TYPES, mentions: ['mention'], threads: ['thread_reply'], reactions: ['reaction'], invitations: ['channel_invite', 'workspace_invite', 'workspace_join_request', 'workspace_join_approved'] };
const unread = { isRead: { $ne: true }, readAt: null };
const id = value => new mongoose.Types.ObjectId(value);

async function visibleActivity(userId, workspaceId) {
  const workspaces = await Workspace.find({ ...(workspaceId ? { _id: workspaceId } : {}), 'members.user': userId, deletedAt: null, isArchived: false }).select('_id');
  const workspaceIds = workspaces.map(w => w._id);
  const [channels, dms] = await Promise.all([
    Channel.find({ workspace: { $in: workspaceIds }, $or: [{ type: 'public' }, { 'members.user': userId }] }).select('_id'),
    DirectMessage.find({ workspace: { $in: workspaceIds }, participants: userId }).select('_id'),
  ]);
  return [
    { $match: { recipient: id(userId), workspace: { $in: workspaceIds }, type: { $in: ACTIVITY_TYPES } } },
    { $lookup: { from: 'messages', localField: 'message', foreignField: '_id', as: '_message' } },
    { $set: { _message: { $arrayElemAt: ['$_message', 0] } } },
    { $match: { $and: [
      { $or: [{ channel: null }, { channel: { $in: channels.map(c => c._id) } }] },
      { $or: [{ dm: null }, { dm: { $in: dms.map(d => d._id) } }] },
      { $or: [{ type: { $nin: MESSAGE_TYPES } }, { $and: [
        { '_message.isDeleted': false },
        { $or: [{ '_message.channel': { $in: channels.map(c => c._id) } }, { '_message.dm': { $in: dms.map(d => d._id) } }] },
      ] }] },
    ] } },
  ];
}
async function activityCount(userId, workspaceId) {
  const result = await Notification.aggregate([...(await visibleActivity(userId, workspaceId)), { $match: { ...unread, clearedAt: null } }, { $count: 'count' }]);
  return result[0]?.count || 0;
}
function changed(io, userId, workspaceId) { io?.to(`user:${userId}`).emit('activity:changed', { workspaceId: String(workspaceId) }); }

async function seeMessages(io, userId, workspaceId, messageIds) {
  const messages = await Message.find({ _id: { $in: messageIds }, workspace: workspaceId, isDeleted: false }).select('_id workspace channel dm createdAt thread');
  if (messages.length !== messageIds.length) return { status: 404, error: 'Message not found' };
  const checked = new Map();
  for (const message of messages) {
    const key = String(message.channel || message.dm);
    if (!checked.has(key)) checked.set(key, message.channel ? await getChannelContext(message.channel, userId, { light: true }) : await getDMContext(message.dm, userId, { light: true }));
    if (checked.get(key).error) return checked.get(key);
  }
  const seenAt = new Date();
  await Promise.all(messages.map(async message => {
    try { await MessageSeen.updateOne({ user: userId, message: message._id }, { $max: { seenAt, expiresAt: new Date(+seenAt + 90 * 86400000) } }, { upsert: true }); }
    catch (error) { if (error.code !== 11000) throw error; await MessageSeen.updateOne({ user: userId, message: message._id }, { $max: { seenAt, expiresAt: new Date(+seenAt + 90 * 86400000) } }); }
  }));
  const result = await Notification.updateMany({ recipient: userId, workspace: workspaceId, message: { $in: messageIds }, createdAt: { $lte: seenAt }, ...unread }, { $set: { isRead: true, readAt: seenAt } });
  if (result.modifiedCount) changed(io, userId, workspaceId);
  return { readAt: seenAt, modifiedCount: result.modifiedCount };
}
module.exports = { ACTIVITY_TYPES, FILTERS, unread, visibleActivity, activityCount, changed, seeMessages };
