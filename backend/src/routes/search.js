const express = require('express');
const { describeError } = require('../utils/logSafe');
const mongoose = require('mongoose');
const router = express.Router();
const Message = require('../models/Message');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { getWorkspaceContext } = require('../middleware/authorization');

const MAX_QUERY_LENGTH = 120;
const MAX_LIMIT = 50;
const MAX_SKIP = 10000;

function parseDate(value, label) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`${label} must be a valid date`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function conversationLabel(message) {
  if (message.channel) return { type: 'channel', id: message.channel._id, name: `#${message.channel.name}` };
  if (message.dm) {
    const name = message.dm.isGroup
      ? (message.dm.groupName || 'Group direct message')
      : 'Direct message';
    return { type: 'dm', id: message.dm._id, name };
  }
  return null;
}

function serializeMessage(message) {
  const parentId = message.thread?.parentMessage?._id || message.thread?.parentMessage || null;
  return {
    _id: message._id,
    content: message.content,
    sender: message.sender,
    channel: message.channel,
    dm: message.dm,
    createdAt: message.createdAt,
    attachments: message.attachments || [],
    thread: message.thread,
    threadParentId: parentId ? String(parentId) : null,
    isThreadReply: Boolean(parentId),
    isPinned: Boolean(message.isPinned),
    conversation: conversationLabel(message),
  };
}

// GET /api/search?workspaceId=...&q=...
router.get('/', authenticate, async (req, res) => {
  try {
    const { q, workspaceId, channelId, senderId, hasAttachments } = req.query;
    const queryText = String(q || '').trim();
    if (!queryText) return res.status(400).json({ error: 'Query required' });
    if (queryText.length > MAX_QUERY_LENGTH) return res.status(400).json({ error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer` });
    const workspaceAccess = await getWorkspaceContext(workspaceId, req.userId);
    if (workspaceAccess.error) return res.status(workspaceAccess.status).json({ error: workspaceAccess.error });

    const [accessibleChannels, accessibleDMs] = await Promise.all([
      Channel.find({ workspace: workspaceId, isArchived: false, $or: [{ type: 'public' }, { 'members.user': req.userId }] }).select('_id name type'),
      DirectMessage.find({ workspace: workspaceId, participants: req.userId }).select('_id isGroup groupName participants'),
    ]);
    const channelIds = accessibleChannels.map((channel) => String(channel._id));
    const dmIds = accessibleDMs.map((dm) => String(dm._id));
    const requestedChannel = channelId ? String(channelId) : null;
    if (requestedChannel && !channelIds.includes(requestedChannel)) return res.json({ results: [], query: queryText, total: 0, hasMore: false });

    const after = parseDate(req.query.after || req.query.from, 'after');
    const before = parseDate(req.query.before || req.query.to, 'before');
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), MAX_LIMIT);
    const skip = Math.min(Math.max(Number(req.query.skip) || 0, 0), MAX_SKIP);
    const accessQuery = {
      workspace: workspaceId,
      isDeleted: false,
      $or: requestedChannel
        ? [{ channel: requestedChannel }]
        : [{ channel: { $in: channelIds } }, { dm: { $in: dmIds } }],
    };
    if (senderId) {
      if (!mongoose.isValidObjectId(senderId)) return res.status(400).json({ error: 'Invalid senderId' });
      accessQuery.sender = senderId;
    }
    if (after || before) accessQuery.createdAt = { ...(after ? { $gte: after } : {}), ...(before ? { $lte: before } : {}) };
    if (hasAttachments === 'true') accessQuery['attachments.0'] = { $exists: true };
    if (hasAttachments === 'false') accessQuery['attachments.0'] = { $exists: false };

    const populateSearch = (query) => query
      .sort({ createdAt: -1 })
      .limit(skip + limit)
      .populate('sender', 'displayName avatar username status')
      .populate('channel', 'name type')
      .populate({ path: 'dm', select: 'isGroup groupName participants', populate: { path: 'participants', select: 'displayName avatar username' } })
      .populate('thread.parentMessage', '_id')
      .lean();

    const textQuery = { ...accessQuery, $text: { $search: queryText } };
    const [matchedMessages, total] = await Promise.all([
      populateSearch(Message.find(textQuery)),
      Message.countDocuments(textQuery),
    ]);
    const messages = matchedMessages.slice(skip, skip + limit);
    const results = messages.map(serializeMessage);
    res.json({ results, messages: results, query: queryText, total, hasMore: skip + results.length < total, filters: { workspaceId, channelId: requestedChannel, senderId: senderId || null, after, before, hasAttachments: hasAttachments || null } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(describeError(err));
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
