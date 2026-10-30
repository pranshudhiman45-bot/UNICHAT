const express = require('express');
const { describeError } = require('../utils/logSafe');
const router = express.Router();
router.param('userId', (req, res, next, id) => require('mongoose').isValidObjectId(id) ? next() : res.status(404).json({ error: 'User not found' }));
router.param('dmId', (req, res, next, id) => require('mongoose').isValidObjectId(id) ? next() : res.status(404).json({ error: 'Conversation not found' }));
const DirectMessage = require('../models/DirectMessage');
const Message = require('../models/Message');
const Workspace = require('../models/Workspace');
const { authenticate } = require('../middleware/auth');
const { getWorkspaceContext, getDMContext } = require('../middleware/authorization');
const { getUnreadCounts } = require('../utils/unreadCounts');
const { grantDm, revokeDm } = require('../socket/rooms');
const User = require('../models/User');
const mongoose = require('mongoose');
const { loadPage, loadChanges } = require('../utils/messagePaging');

// GET /api/dms?workspaceId=xxx - List all DM conversations
// NOTE: kept as query param to avoid route collision with /:dmId/messages
router.get('/', authenticate, async (req, res) => {
  try {
    const { workspaceId } = req.query;
    if (!workspaceId) return res.status(400).json({ error: 'workspaceId query param required' });

    const workspaceContext = await getWorkspaceContext(workspaceId, req.userId);
    if (workspaceContext.error) return res.status(workspaceContext.status).json({ error: workspaceContext.error });

    const dms = await DirectMessage.find({
      workspace: workspaceId,
      participants: req.userId,
    })
      .populate('participants', 'displayName avatar username status statusMessage lastSeen')
      .populate({ path: 'lastMessage', populate: { path: 'sender', select: 'displayName username' } })
      .sort({ lastActivity: -1 });

    const unreadByDM = await getUnreadCounts(Message, dms.map((dm) => {
      const member = dm.memberData.find((entry) => entry.user.toString() === req.userId);
      return { id: dm._id, lastRead: member?.lastRead };
    }), 'dm', req.userId);

    const dmsWithUnread = dms.map((dm) => {
      const dmObj = dm.toObject();
      const memberData = dm.memberData.find(m => m.user.toString() === req.userId);
      if (memberData) {
        const counts = unreadByDM.get(String(dm._id));
        dmObj.unreadCount = counts?.unreadCount || 0;
        dmObj.mentionCount = counts?.mentionCount || 0;
      } else {
        dmObj.unreadCount = 0;
        dmObj.mentionCount = 0;
      }
      dmObj.isMuted = Boolean(memberData?.isMuted);
      dmObj.isArchived = Boolean(memberData?.isArchived);
      return dmObj;
    });

    res.json({ dms: dmsWithUnread });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to fetch DMs' });
  }
});

// POST /api/dms - Create or get DM
router.post('/', authenticate, async (req, res) => {
  try {
    const { workspaceId, participantIds = [], isGroup = false, groupName } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required' });
    }
    if (!Array.isArray(participantIds)) {
      return res.status(400).json({ error: 'participantIds must be an array' });
    }

    const workspace = await Workspace.findById(workspaceId);
    if (!workspace || workspace.deletedAt) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isMember(req.userId)) return res.status(403).json({ error: 'Not a member' });

    const requestedParticipantIds = [...new Set(participantIds.map((id) => id?.toString()).filter(Boolean))];
    if (requestedParticipantIds.length === 0) {
      return res.status(400).json({ error: 'At least one participant is required' });
    }

    const invalidParticipantId = requestedParticipantIds.find((participantId) => !workspace.isMember(participantId));
    if (invalidParticipantId) {
      return res.status(403).json({ error: 'One or more participants are not members of this workspace' });
    }

    const allParticipants = [...new Set([req.userId, ...requestedParticipantIds])];
    if (!isGroup && allParticipants.length !== 2) {
      return res.status(400).json({ error: 'Direct messages must have exactly two participants' });
    }
    if (isGroup && allParticipants.length < 3) {
      return res.status(400).json({ error: 'Group DMs must have at least three participants' });
    }
    if (!isGroup && requestedParticipantIds.includes(req.userId)) {
      return res.status(400).json({ error: 'You cannot message yourself' });
    }

    if (!isGroup && allParticipants.length === 2) {
      // Find existing DM
      const existing = await DirectMessage.findOne({
        workspace: workspaceId,
        isGroup: false,
        participants: { $all: allParticipants, $size: 2 },
      }).populate('participants', 'displayName avatar username status');

      if (existing) return res.json({ dm: existing });
    }

    const dm = new DirectMessage({
      workspace: workspaceId,
      participants: allParticipants,
      isGroup,
      directKey: !isGroup ? allParticipants.slice().sort().join(':') : undefined,
      groupName: isGroup ? (groupName || undefined) : undefined,
      createdBy: req.userId,
      memberData: allParticipants.map(uid => ({ user: uid, lastRead: new Date() })),
    });
    await dm.save();

    const populated = await DirectMessage.findById(dm._id)
      .populate('participants', 'displayName avatar username status');

    const io = req.app.get('io');
    await Promise.all(allParticipants.map((uid) => grantDm(io, uid, dm._id)));
    allParticipants.forEach(uid => {
      io.to(`user:${uid}`).emit('dm:created', populated);
    });

    res.status(201).json({ dm: populated });
  } catch (err) {
    console.error(describeError(err));
    res.status(500).json({ error: 'Failed to create DM' });
  }
});

// GET /api/dms/:dmId/messages?limit=&before=&beforeId= (never marks the conversation read)
router.get('/:dmId/messages', authenticate, async (req, res) => {
  try {
    const access = await getDMContext(req.params.dmId, req.userId, { light: true });
    if (access.error) return res.status(access.status).json({ error: access.error });
    const { dm } = access;
    const serverTime = new Date();
    const memberData = dm.memberData.find((member) => member.user.toString() === req.userId);
    const lastReadAt = memberData?.lastRead || null;
    const [page, unreadCount] = await Promise.all([
      loadPage({ dm: dm._id }, req.query),
      memberData ? Message.countDocuments({ dm: dm._id, 'thread.parentMessage': null, createdAt: { $gt: memberData.lastRead }, sender: { $ne: req.userId }, isDeleted: false }) : 0,
    ]);
    res.json({ messages: page.messages, hasMore: page.hasMore, nextCursor: page.nextCursor, unreadCount, lastReadAt, serverTime });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Failed to fetch DM messages' });
  }
});

// GET /api/dms/:dmId/sync?since=ISO
router.get('/:dmId/sync', authenticate, async (req, res) => {
  try {
    const access = await getDMContext(req.params.dmId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    res.json(await loadChanges({ dm: access.dm._id }, req.query));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Failed to sync messages' });
  }
});

// PUT /api/dms/:dmId/mark-read
router.put('/:dmId/mark-read', authenticate, async (req, res) => {
  try {
    const access = await getDMContext(req.params.dmId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    await DirectMessage.updateOne(
      { _id: req.params.dmId, 'memberData.user': req.userId },
      { $set: { 'memberData.$.lastRead': new Date() } }
    );
    req.app.get('io').to(`dm:${req.params.dmId}`).emit('dm:read', {
      dmId: req.params.dmId,
      userId: req.userId,
      readAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});


// ---- Group conversation management -------------------------------------------------------------
// Any participant may rename or add people to a group; anyone may leave; only the creator removes others.
// New participants can read the group's earlier messages (documented product rule).
async function groupContext(req, res) {
  const access = await getDMContext(req.params.dmId, req.userId);
  if (access.error) { res.status(access.status).json({ error: access.error }); return null; }
  if (!access.dm.isGroup) { res.status(400).json({ error: 'This is not a group conversation' }); return null; }
  return access;
}
const populateDm = (id) => DirectMessage.findById(id).populate('participants', 'displayName avatar username status statusMessage lastSeen');

router.patch('/:dmId', authenticate, async (req, res) => {
  try {
    const access = await groupContext(req, res); if (!access) return null;
    const name = typeof req.body?.groupName === 'string' ? req.body.groupName.trim() : '';
    if (!name || name.length > 80) return res.status(400).json({ error: 'Group name must be 1-80 characters' });
    await DirectMessage.updateOne({ _id: access.dm._id }, { $set: { groupName: name } });
    const dm = await populateDm(access.dm._id);
    req.app.get('io').to(`dm:${dm._id}`).emit('dm:updated', dm);
    res.json({ dm });
  } catch { res.status(500).json({ error: 'Failed to rename group' }); }
});

router.post('/:dmId/participants', authenticate, async (req, res) => {
  try {
    const access = await groupContext(req, res); if (!access) return null;
    const ids = Array.isArray(req.body?.userIds) ? [...new Set(req.body.userIds.map(String))] : [];
    if (!ids.length || ids.length > 50 || ids.some((id) => !mongoose.isValidObjectId(id))) return res.status(400).json({ error: 'Provide 1-50 valid userIds' });
    if (ids.some((id) => !access.workspace.isMember(id))) return res.status(403).json({ error: 'Everyone must be a member of this workspace' });
    const fresh = ids.filter((id) => !access.dm.participants.some((p) => String(p) === id));
    if (access.dm.participants.length + fresh.length > 50) return res.status(400).json({ error: 'A group can have at most 50 people' });
    if (fresh.length) {
      await DirectMessage.updateOne({ _id: access.dm._id }, { $addToSet: { participants: { $each: fresh } }, $push: { memberData: { $each: fresh.map((user) => ({ user, lastRead: new Date() })) } } });
    }
    const dm = await populateDm(access.dm._id);
    const io = req.app.get('io');
    for (const id of fresh) { await grantDm(io, id, dm._id); io.to(`user:${id}`).emit('dm:created', dm); }
    io.to(`dm:${dm._id}`).emit('dm:updated', dm);
    res.json({ dm });
  } catch { res.status(500).json({ error: 'Failed to add participants' }); }
});

router.delete('/:dmId/participants/:userId', authenticate, async (req, res) => {
  try {
    const access = await groupContext(req, res); if (!access) return null;
    const { dm } = access;
    const leaving = req.params.userId === req.userId;
    if (!leaving && String(dm.createdBy) !== req.userId) return res.status(403).json({ error: 'Only the group creator can remove other people' });
    if (!dm.participants.some((p) => String(p) === req.params.userId)) return res.status(404).json({ error: 'Not a participant' });
    await DirectMessage.updateOne({ _id: dm._id }, { $pull: { participants: req.params.userId, memberData: { user: req.params.userId } } });
    const io = req.app.get('io');
    await revokeDm(io, req.params.userId, dm._id);
    io.to(`user:${req.params.userId}`).emit('dm:removed', { dmId: dm._id, reason: leaving ? 'left' : 'removed' });
    const updated = await populateDm(dm._id);
    io.to(`dm:${dm._id}`).emit('dm:updated', updated);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to update group' }); }
});

// PATCH /api/dms/:dmId/me { isMuted?, isArchived? } - per-user conversation preferences
router.patch('/:dmId/me', authenticate, async (req, res) => {
  try {
    const access = await getDMContext(req.params.dmId, req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const set = {};
    for (const key of ['isMuted', 'isArchived']) {
      if (req.body?.[key] !== undefined) { if (typeof req.body[key] !== 'boolean') return res.status(400).json({ error: `${key} must be a boolean` }); set[`memberData.$.${key}`] = req.body[key]; }
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update' });
    if (set['memberData.$.isMuted'] !== undefined) set['memberData.$.notificationLevel'] = set['memberData.$.isMuted'] ? 'nothing' : 'all';
    await DirectMessage.updateOne({ _id: access.dm._id, 'memberData.user': req.userId }, { $set: set });
    req.app.get('io').to(`user:${req.userId}`).emit('dm:preferences', { dmId: String(access.dm._id), ...Object.fromEntries(Object.entries(set).map(([k, v]) => [k.split('.').pop(), v])) });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to update conversation' }); }
});

module.exports = router;
