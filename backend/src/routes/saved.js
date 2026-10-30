const express = require('express');
const { describeError } = require('../utils/logSafe');
const mongoose = require('mongoose');
const router = express.Router();
const SavedMessage = require('../models/SavedMessage');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const Message = require('../models/Message');
const { authenticate } = require('../middleware/auth');
const { getWorkspaceContext, getChannelContext, getDMContext } = require('../middleware/authorization');

// Tells the user's other devices that their saved list changed (web and mobile share this one list).
const announce = (req) => req.app.get('io')?.to(`user:${req.userId}`).emit('saved:changed', {});

async function resolveMessageAccess(messageId, userId) {
  if (!mongoose.isValidObjectId(messageId)) return { status: 404, error: 'Message not found' };
  const message = await Message.findById(messageId);
  if (!message || message.isDeleted) return { status: 404, error: 'Message not found' };
  const access = message.channel
    ? await getChannelContext(message.channel, userId, { light: true })
    : await getDMContext(message.dm, userId, { light: true });
  if (access.error) return access;
  if (String(message.workspace) !== String(access.workspace._id)) return { status: 403, error: 'Message workspace does not match conversation workspace' };
  return { message, ...access };
}

function populateSaved(query) {
  return query
    .populate({ path: 'message', populate: [
      { path: 'sender', select: 'displayName avatar username status' },
      { path: 'thread.parentMessage', select: '_id' },
    ] })
    .populate('channel', 'name type')
    .populate({ path: 'dm', select: 'isGroup groupName participants', populate: { path: 'participants', select: 'displayName avatar username' } });
}

// GET /api/saved?workspaceId=...
router.get('/', authenticate, async (req, res) => {
  try {
    const { workspaceId, limit = 100 } = req.query;
    const workspaceAccess = await getWorkspaceContext(workspaceId, req.userId);
    if (workspaceAccess.error) return res.status(workspaceAccess.status).json({ error: workspaceAccess.error });
    const [channels, dms] = await Promise.all([
      Channel.find({ workspace: workspaceId, isArchived: false, $or: [{ type: 'public' }, { 'members.user': req.userId }] }).select('_id'),
      DirectMessage.find({ workspace: workspaceId, participants: req.userId }).select('_id'),
    ]);
    const saved = await populateSaved(SavedMessage.find({
      user: req.userId,
      workspace: workspaceId,
      $or: [{ channel: { $in: channels.map((channel) => channel._id) } }, { dm: { $in: dms.map((dm) => dm._id) } }],
    }).sort({ createdAt: -1 }).limit(Math.min(Math.max(Number(limit) || 100, 1), 100)));
    const active = saved.filter((item) => item.message && !item.message.isDeleted);
    res.json({ saved: active });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to fetch saved messages' });
  }
});

// POST /api/saved
router.post('/', authenticate, async (req, res) => {
  try {
    const { messageId, workspaceId } = req.body;
    if (!mongoose.isValidObjectId(workspaceId) || !mongoose.isValidObjectId(messageId)) return res.status(400).json({ error: 'messageId and workspaceId are required' });
    const access = await resolveMessageAccess(messageId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (String(access.message.workspace) !== String(workspaceId)) return res.status(403).json({ error: 'Message does not belong to this workspace' });
    const existing = await SavedMessage.findOne({ user: req.userId, message: messageId });
    if (existing) return res.status(409).json({ error: 'Message already saved', saved: existing });
    const saved = await SavedMessage.create({
      user: req.userId,
      workspace: workspaceId,
      message: access.message._id,
      channel: access.message.channel || null,
      dm: access.message.dm || null,
    });
    announce(req);
    res.status(201).json({ saved });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Message already saved' });
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// DELETE /api/saved/:messageId
router.delete('/:messageId', authenticate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.messageId)) return res.json({ success: true });
    await SavedMessage.findOneAndDelete({ user: req.userId, message: req.params.messageId });
    announce(req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsave message' });
  }
});

module.exports = router;
