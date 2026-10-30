const express = require('express');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const User = require('../models/User');
const Message = require('../models/Message');
const { authenticate } = require('../middleware/auth');
const { ensureDefaultWorkspaceMembership } = require('../utils/defaultWorkspace');
const { audit, isSuperAdmin } = require('../services/adminSecurity');
const { softDeleteWorkspace } = require('../services/workspaceAdministration');
const { limiter } = require('../services/redis');
const { publicRequest, summary, adminFilter, repairMembership, notifyAdmins, markRequestNotificationsRead, announceDecision } = require('../services/workspaceJoining');
const router = express.Router();
const { removeMember } = require('../services/workspaceMembership');
const writeLimit = limiter('workspace-write', { windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many workspace requests. Try again later.' } });

router.use(authenticate);
router.param('workspaceId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Workspace not found' }));
router.param('userId', (req, res, next, id) => mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'Member not found' }));
const active = { deletedAt: null, isArchived: false };
// A declined person may ask again after this cooldown (default 24h). Decided requests stay on record this long.
const JOIN_REQUEST_COOLDOWN_MS = Number(process.env.JOIN_REQUEST_COOLDOWN_HOURS ?? 24) * 3600 * 1000;
const JOIN_REQUEST_HISTORY_DAYS = Number(process.env.JOIN_REQUEST_HISTORY_DAYS || 365);
const MAX_PENDING_REQUESTS = 500;
const latestRequestFor = (requests, userId) => (requests || []).filter((entry) => String(entry.user) === String(userId))
  .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt) || String(b._id).localeCompare(String(a._id)))[0];

router.get('/', async (req, res, next) => {
  try {
    await ensureDefaultWorkspaceMembership(req.userId);
    const workspaces = await Workspace.find({ 'members.user': req.userId, ...active }).populate('owner', 'displayName avatar username').select('+joinRequests').sort({ name: 1 }).lean();
    for (const workspace of workspaces) {
      const member = workspace.members.find(member => String(member.user) === req.userId);
      if (member && ['owner', 'admin'].includes(member.role)) workspace.pendingJoinRequestCount = workspace.joinRequests?.filter(request => request.status === 'pending').length || 0;
      else delete workspace.inviteCode; // only administrators may hand out the invite code
      delete workspace.joinRequests;
    }
    res.json({ workspaces });
  } catch (error) { next(error); }
});

router.post('/', writeLimit, async (req, res, next) => {
  let workspace;
  try {
    if (process.env.WORKSPACE_CREATION === 'admin' && !isSuperAdmin(req.user)) return res.status(403).json({ error: 'Workspace creation is restricted to administrators' });
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const description = req.body.description === undefined ? '' : req.body.description;
    if (name.length < 2 || name.length > 80 || typeof description !== 'string' || description.length > 300) return res.status(400).json({ error: 'Use a workspace name of 2–80 characters and description under 300 characters' });
    const explicitSlug = req.body.slug;
    if (explicitSlug !== undefined && (typeof explicitSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(explicitSlug))) return res.status(400).json({ error: 'Invalid workspace slug' });
    const base = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 28) || 'workspace';
    const slug = explicitSlug || `${base}-${crypto.randomBytes(5).toString('hex')}`;
    workspace = await Workspace.create({ name, slug, description: description.trim(), owner: req.userId, members: [{ user: req.userId, role: 'owner' }] });
    const channels = await Channel.insertMany(['general', 'random'].map((channelName) => ({ workspace: workspace._id, name: channelName, description: channelName === 'general' ? 'Team announcements and everyday conversations' : 'A little room for everything else', type: 'public', createdBy: req.userId, isDefault: true, members: [{ user: req.userId, role: 'admin' }] })));
    await Message.create({ workspace: workspace._id, channel: channels[0]._id, sender: req.userId, content: `Welcome to ${name}!`, isSystemMessage: true, systemMessageType: 'workspace_created' });
    await User.updateOne({ _id: req.userId }, { $addToSet: { workspaces: workspace._id } });
    const io = req.app.get('io');
    io?.in(`user:${req.userId}`).socketsJoin(`workspace:${workspace._id}`);
    io?.to(`user:${req.userId}`).emit('workspace:created', workspace);
    await audit(req, 'WORKSPACE_CREATED', { workspaceId: workspace._id });
    return res.status(201).json({ workspace, channels });
  } catch (error) {
    // Compensate partial creation on standalone MongoDB as well as replica sets.
    if (workspace) await Promise.allSettled([Workspace.deleteOne({ _id: workspace._id }), Channel.deleteMany({ workspace: workspace._id }), Message.deleteMany({ workspace: workspace._id }), User.updateOne({ _id: req.userId }, { $pull: { workspaces: workspace._id } })]);
    next(error);
  }
});

// An applicant can see only their own request and minimal workspace details.
router.get('/join-requests', async (req, res, next) => {
  try {
    const workspaces = await Workspace.find({ 'joinRequests.user': req.userId, ...active }).select('name icon +joinRequests').lean();
    // The latest request per workspace is the current status; older decisions stay in history on the server.
    const requests = workspaces.flatMap((workspace) => {
      const latest = latestRequestFor(workspace.joinRequests, req.userId);
      if (!latest) return [];
      const canRequestAgainAt = latest.status === 'rejected' && latest.reviewedAt ? new Date(new Date(latest.reviewedAt).getTime() + JOIN_REQUEST_COOLDOWN_MS) : null;
      return [{ ...publicRequest(latest), canRequestAgainAt, workspace: summary(workspace) }];
    });
    res.json({ requests });
  } catch (error) { next(error); }
});

router.post('/join/:inviteCode', writeLimit, async (req, res, next) => {
  try {
    const code = req.params.inviteCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{8,32}$/.test(code)) return res.status(400).json({ error: 'Enter a valid invite code' });
    let workspace = await Workspace.findOne({ inviteCode: code, ...active }).select('+joinRequests');
    if (!workspace) return res.status(404).json({ error: 'This invite is invalid or the workspace is unavailable' });
    const io = req.app.get('io');
    if (workspace.isMember(req.userId)) {
      const memberWorkspace = await repairMembership(io, workspace._id, req.userId);
      if (!memberWorkspace) return res.status(404).json({ error: 'Workspace is no longer available' });
      return res.json({ workspace: memberWorkspace, alreadyMember: true });
    }
    // History is kept (a rejected request stays on record); only very old decided requests are pruned.
    await Workspace.updateOne({ _id: workspace._id }, { $pull: { joinRequests: { status: { $in: ['approved', 'rejected'] }, reviewedAt: { $lt: new Date(Date.now() - JOIN_REQUEST_HISTORY_DAYS * 86400000) } } } });
    const cutoff = new Date(Date.now() - JOIN_REQUEST_COOLDOWN_MS);
    // One atomic conditional write decides everything: a request is created only if this person has no PENDING
    // request and no REJECTION inside the cooldown, is not already a member, and the code is still the current one.
    const blocking = { user: req.userId, $or: [{ status: 'pending' }, { status: 'rejected', reviewedAt: { $gt: cutoff } }] };
    const created = await Workspace.updateOne({
      _id: workspace._id, inviteCode: code, ...active, 'members.user': { $ne: req.userId }, joinRequests: { $not: { $elemMatch: blocking } },
      $expr: { $lt: [{ $size: { $filter: { input: { $ifNull: ['$joinRequests', []] }, cond: { $eq: ['$$this.status', 'pending'] } } } }, MAX_PENDING_REQUESTS] },
    }, { $push: { joinRequests: { user: req.userId } } });
    workspace = await Workspace.findOne({ _id: workspace._id, ...active }).select('+joinRequests');
    if (!workspace) return res.status(404).json({ error: 'Workspace is no longer available' });
    const latest = latestRequestFor(workspace.joinRequests, req.userId);
    if (!latest) return res.status(409).json({ error: 'This invite changed or the request queue is full. Ask the workspace administrator for help.' });
    const body = (request) => ({ ...publicRequest(request), workspace: summary(workspace) });
    // Only the call that actually created the request notifies admins (parallel submissions notify once).
    if (created.modifiedCount) {
      await notifyAdmins(io, workspace, latest, req.user);
      return res.status(202).json({ request: body(latest), message: 'Request sent. A workspace administrator must approve your access.' });
    }
    if (latest.status === 'pending') return res.status(202).json({ request: body(latest), message: 'Your request is already waiting for approval.' });
    if (latest.status === 'rejected' && latest.reviewedAt > cutoff) {
      const retryAt = new Date(latest.reviewedAt.getTime() + JOIN_REQUEST_COOLDOWN_MS);
      res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))));
      return res.status(429).json({ error: 'Your last request was declined. You can ask again later.', code: 'JOIN_COOLDOWN', retryAt, request: body(latest) });
    }
    return res.status(409).json({ error: 'This invite changed or the request queue is full. Ask the workspace administrator for help.' });
  } catch (error) { next(error); }
});

router.get('/:workspaceId/join-requests', async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isAdmin(req.userId)) return res.status(403).json({ error: 'Workspace administrator access required' });
    const pending = await Workspace.findById(workspace._id).select('+joinRequests').populate('joinRequests.user', 'displayName username email emailVerifiedAt avatar');
    res.json({ requests: pending.joinRequests.filter(request => request.status === 'pending' && request.user).map(request => ({ ...publicRequest(request), user: request.user })) });
  } catch (error) { next(error); }
});

router.post('/:workspaceId/join-requests/:requestId/:decision', writeLimit, async (req, res, next) => {
  try {
    const { workspaceId, requestId, decision } = req.params;
    if (!mongoose.isValidObjectId(requestId) || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'Invalid join request decision' });
    let workspace = await Workspace.findOne({ _id: workspaceId, ...active }).select('+joinRequests');
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isAdmin(req.userId)) return res.status(403).json({ error: 'Workspace administrator access required' });
    let request = workspace.joinRequests.id(requestId);
    if (!request) return res.status(404).json({ error: 'Join request not found' });
    const targetStatus = decision === 'approve' ? 'approved' : 'rejected';
    if (request.status !== 'pending' && request.status !== targetStatus) return res.status(409).json({ error: 'This request has already been reviewed. Refresh the list.' });
    if (decision === 'approve' && !await User.exists({ _id: request.user, accountStatus: { $ne: 'disabled' } })) return res.status(409).json({ error: 'The applicant account is unavailable' });
    const applicantId = String(request.user);
    let decided = false;
    if (request.status === 'pending') {
      const changes = { $set: { 'joinRequests.$[request].status': targetStatus, 'joinRequests.$[request].reviewedAt': new Date(), 'joinRequests.$[request].reviewedBy': req.userId } };
      const filter = { _id: workspaceId, ...active, ...adminFilter(req.userId), joinRequests: { $elemMatch: { _id: requestId, status: 'pending' } } };
      if (decision === 'approve' && !workspace.isMember(applicantId)) {
        filter['members.user'] = { $ne: applicantId };
        changes.$push = { members: { user: applicantId, role: 'member' } };
      }
      const changed = await Workspace.updateOne(filter, changes, { arrayFilters: [{ 'request._id': new mongoose.Types.ObjectId(requestId) }] });
      workspace = await Workspace.findOne({ _id: workspaceId, ...active }).select('+joinRequests');
      if (!workspace || !workspace.isAdmin(req.userId)) return res.status(403).json({ error: 'Workspace administrator access required' });
      request = workspace.joinRequests.id(requestId);
      if (request?.status !== targetStatus) return res.status(409).json({ error: 'This request has already been reviewed. Refresh the list.' });
      decided = Boolean(changed.modifiedCount);
      if (changed.modifiedCount) await audit(req, decision === 'approve' ? 'WORKSPACE_JOIN_APPROVED' : 'WORKSPACE_JOIN_REJECTED', { workspaceId, userId: applicantId, metadata: { requestId } });
    }
    const io = req.app.get('io');
    if (decision === 'approve') {
      if (!await repairMembership(io, workspaceId, applicantId)) return res.status(409).json({ error: 'Workspace membership is no longer available' });
    }
    // A repeated decision on an already-decided request is a harmless no-op: no second membership, no repeat events.
    if (!decided) return res.json({ request: publicRequest(request), alreadyDecided: true });
    if (decision === 'approve') io?.to(`workspace:${workspaceId}`).emit('workspace:member_joined', { workspaceId, userId: applicantId });
    await markRequestNotificationsRead(io, workspaceId, requestId);
    await announceDecision(io, workspace, request, targetStatus, req.user);
    for (const member of workspace.members.filter(member => ['owner', 'admin'].includes(member.role))) io?.to(`user:${member.user}`).emit('workspace:join_request', { workspaceId });
    res.json({ request: publicRequest(request) });
  } catch (error) { next(error); }
});

router.get('/:workspaceId', async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active }).populate('members.user', 'displayName avatar username status statusMessage title').populate('owner', 'displayName avatar username');
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isMember(req.userId)) return res.status(403).json({ error: 'You are not a member of this workspace' });
    const body = workspace.toObject();
    if (!workspace.isAdmin(req.userId)) delete body.inviteCode;
    res.json({ workspace: body });
  } catch (error) { next(error); }
});
router.get('/:workspaceId/members', async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active }).populate('members.user', 'displayName avatar username status statusMessage title lastSeen');
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isMember(req.userId)) return res.status(403).json({ error: 'You are not a member of this workspace' });
    res.json({ members: workspace.members.filter((member) => member.user) });
  } catch (error) { next(error); }
});

async function updateWorkspace(req, res, next) {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isAdmin(req.userId)) return res.status(403).json({ error: 'Workspace administrator access required' });
    const { name, description, icon } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80)) return res.status(400).json({ error: 'Invalid workspace name' });
    if (description !== undefined && (typeof description !== 'string' || description.length > 300)) return res.status(400).json({ error: 'Invalid description' });
    if (icon !== undefined && icon !== null && (typeof icon !== 'string' || icon.length > 16 || /[<>:/]/.test(icon))) return res.status(400).json({ error: 'Choose a short workspace emoji' });
    if (name !== undefined) workspace.name = name.trim();
    if (description !== undefined) workspace.description = description.trim();
    if (icon !== undefined) workspace.icon = icon;
    await workspace.save();
    req.app.get('io')?.to(`workspace:${workspace._id}`).emit('workspace:updated', { _id: workspace._id, name: workspace.name, description: workspace.description, icon: workspace.icon });
    res.json({ workspace });
  } catch (error) { next(error); }
}
router.put('/:workspaceId', writeLimit, updateWorkspace);
router.patch('/:workspaceId', writeLimit, updateWorkspace);
router.post('/:workspaceId/regenerate-invite', writeLimit, async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isAdmin(req.userId)) return res.status(403).json({ error: 'Workspace administrator access required' });
    workspace.inviteCode = crypto.randomBytes(8).toString('hex').toUpperCase();
    await workspace.save();
    res.json({ inviteCode: workspace.inviteCode });
  } catch (error) { next(error); }
});

// ---- Member management -------------------------------------------------------------------------
// Roles: owner (exactly one) > admin > member/guest. Only the owner changes admin roles or transfers
// ownership. Admins may remove ordinary members. Nobody removes the owner; transfer ownership first.
const ASSIGNABLE_ROLES = ['admin', 'member'];

router.put('/:workspaceId/members/:userId/role', writeLimit, async (req, res, next) => {
  try {
    const { role } = req.body || {};
    if (!ASSIGNABLE_ROLES.includes(role)) return res.status(400).json({ error: 'role must be "admin" or "member"' });
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (String(workspace.owner) !== req.userId) return res.status(403).json({ error: 'Only the workspace owner can change roles' });
    const target = workspace.getMember(req.params.userId);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === 'owner') return res.status(400).json({ error: 'Transfer ownership to change the owner\'s role' });
    const result = await Workspace.updateOne({ _id: workspace._id, owner: req.userId, members: { $elemMatch: { user: req.params.userId, role: { $ne: 'owner' } } } }, { $set: { 'members.$.role': role } });
    if (!result.matchedCount) return res.status(409).json({ error: 'Membership changed. Refresh and try again.' });
    await audit(req, 'WORKSPACE_ROLE_CHANGED', { workspaceId: workspace._id, userId: req.params.userId, metadata: { role } });
    req.app.get('io')?.to(`workspace:${workspace._id}`).emit('workspace:member_updated', { workspaceId: String(workspace._id), userId: req.params.userId, role });
    res.json({ userId: req.params.userId, role });
  } catch (error) { next(error); }
});

router.delete('/:workspaceId/members/:userId', writeLimit, async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const actor = workspace.getMember(req.userId);
    if (!actor) return res.status(403).json({ error: 'You are not a member of this workspace' });
    if (req.params.userId === req.userId) return res.status(400).json({ error: 'Use "leave workspace" to remove yourself' });
    const target = workspace.getMember(req.params.userId);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === 'owner' || String(workspace.owner) === req.params.userId) return res.status(403).json({ error: 'The workspace owner cannot be removed. Transfer ownership first.' });
    const isOwner = actor.role === 'owner';
    if (!isOwner && !(actor.role === 'admin' && !['owner', 'admin'].includes(target.role))) return res.status(403).json({ error: 'You do not have permission to remove this member' });
    if (!await removeMember({ io: req.app.get('io'), workspaceId: workspace._id, userId: req.params.userId, reason: 'removed' })) return res.status(409).json({ error: 'Membership changed. Refresh and try again.' });
    await audit(req, 'WORKSPACE_MEMBER_REMOVED', { workspaceId: workspace._id, userId: req.params.userId });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/:workspaceId/leave', writeLimit, async (req, res, next) => {
  try {
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.isMember(req.userId)) return res.status(403).json({ error: 'You are not a member of this workspace' });
    if (String(workspace.owner) === req.userId) return res.status(409).json({ error: 'The owner cannot leave. Transfer ownership first or delete the workspace.', code: 'OWNER_CANNOT_LEAVE' });
    if (!await removeMember({ io: req.app.get('io'), workspaceId: workspace._id, userId: req.userId, reason: 'left' })) return res.status(409).json({ error: 'Membership changed. Refresh and try again.' });
    await audit(req, 'WORKSPACE_MEMBER_LEFT', { workspaceId: workspace._id, userId: req.userId });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.post('/:workspaceId/transfer-ownership', writeLimit, async (req, res, next) => {
  try {
    const targetId = req.body?.userId;
    if (!mongoose.isValidObjectId(targetId) || targetId === req.userId) return res.status(400).json({ error: 'Choose another member as the new owner' });
    const workspace = await Workspace.findOne({ _id: req.params.workspaceId, ...active });
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (String(workspace.owner) !== req.userId) return res.status(403).json({ error: 'Only the owner can transfer ownership' });
    if (req.body.confirmName !== workspace.name) return res.status(400).json({ error: 'Type the exact workspace name to confirm' });
    if (!workspace.isMember(targetId) || !await User.exists({ _id: targetId, accountStatus: { $ne: 'disabled' } })) return res.status(400).json({ error: 'The new owner must be an active member of the workspace' });
    // Single atomic update: the owner field and both roles change together or not at all.
    const result = await Workspace.updateOne(
      { _id: workspace._id, owner: req.userId, 'members.user': targetId },
      { $set: { owner: targetId, 'members.$[next].role': 'owner', 'members.$[previous].role': 'admin' } },
      { arrayFilters: [{ 'next.user': new mongoose.Types.ObjectId(targetId) }, { 'previous.user': new mongoose.Types.ObjectId(req.userId) }] },
    );
    if (!result.modifiedCount) return res.status(409).json({ error: 'Ownership changed. Refresh and try again.' });
    await audit(req, 'WORKSPACE_OWNERSHIP_TRANSFERRED', { workspaceId: workspace._id, userId: targetId });
    req.app.get('io')?.to(`workspace:${workspace._id}`).emit('workspace:ownership_transferred', { workspaceId: String(workspace._id), ownerId: targetId, previousOwnerId: req.userId });
    res.json({ owner: targetId });
  } catch (error) { next(error); }
});

router.delete('/:workspaceId', writeLimit, async (req, res, next) => {
  try {
    const workspace = await Workspace.findById(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!isSuperAdmin(req.user) && String(workspace.owner) !== req.userId) return res.status(403).json({ error: 'Only the workspace owner can delete it' });
    return softDeleteWorkspace(req, res, next);
  } catch (error) { next(error); }
});
module.exports = router;
