const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const SavedMessage = require('../models/SavedMessage');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const { authenticate } = require('../middleware/auth');
const { getWorkspaceContext, getMessageContext } = require('../middleware/authorization');

// DEPRECATED compatibility alias. "Starred" and "saved" are one product concept stored in the SavedMessage
// collection; /api/saved is canonical. This endpoint keeps older mobile builds working with their original
// response shape ({ starred: [...] }) while reading and writing the very same rows, so a message saved on
// web appears starred on mobile and vice versa.
router.use((req, res, next) => { res.set({ Deprecation: 'true', Link: '</api/saved>; rel="successor-version"' }); next(); });

const announce = (req) => req.app.get('io')?.to(`user:${req.userId}`).emit('saved:changed', {});

router.get('/', authenticate, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    const workspaceAccess = await getWorkspaceContext(workspaceId, req.userId);
    if (workspaceAccess.error) return res.status(workspaceAccess.status).json({ error: workspaceAccess.error });
    const [channels, dms] = await Promise.all([
      Channel.find({ workspace: workspaceId, isArchived: false, $or: [{ type: 'public' }, { 'members.user': req.userId }] }).select('_id'),
      DirectMessage.find({ workspace: workspaceId, participants: req.userId }).select('_id'),
    ]);
    const saved = await SavedMessage.find({ user: req.userId, workspace: workspaceId, $or: [{ channel: { $in: channels.map((c) => c._id) } }, { dm: { $in: dms.map((d) => d._id) } }] })
      .sort({ createdAt: -1 }).limit(100)
      .populate({ path: 'message', populate: { path: 'sender', select: 'displayName avatar username' } })
      .populate('channel', 'name')
      .lean();
    res.json({ starred: saved.filter((item) => item.message && !item.message.isDeleted) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch starred messages' });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    const { messageId, workspaceId } = req.body || {};
    if (!mongoose.isValidObjectId(messageId) || !mongoose.isValidObjectId(workspaceId)) return res.status(400).json({ error: 'messageId and workspaceId required' });
    const access = await getMessageContext(messageId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (String(access.message.workspace) !== String(workspaceId)) return res.status(403).json({ error: 'Message does not belong to this workspace' });
    const existing = await SavedMessage.findOne({ user: req.userId, message: messageId });
    if (existing) return res.status(409).json({ error: 'Already starred', starred: existing });
    const saved = await SavedMessage.create({ user: req.userId, workspace: workspaceId, message: messageId, channel: access.message.channel || null, dm: access.message.dm || null });
    announce(req);
    res.status(201).json({ starred: saved });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Already starred' });
    res.status(500).json({ error: 'Failed to star message' });
  }
});

router.delete('/:messageId', authenticate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.messageId)) return res.json({ success: true });
    await SavedMessage.deleteOne({ user: req.userId, message: req.params.messageId });
    announce(req);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unstar message' });
  }
});

module.exports = router;
