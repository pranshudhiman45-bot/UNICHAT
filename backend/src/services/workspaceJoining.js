const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { createNotifications } = require('./notifications');
const { grant } = require('../socket/rooms');

const active = { deletedAt: null, isArchived: false };
const publicRequest = (request) => ({ _id: request._id, status: request.status, requestedAt: request.requestedAt, reviewedAt: request.reviewedAt });
const summary = (workspace) => ({ _id: workspace._id, name: workspace.name, icon: workspace.icon });
const adminFilter = (userId) => ({ members: { $elemMatch: { user: userId, role: { $in: ['owner', 'admin'] } } } });

async function repairMembership(io, workspaceId, userId) {
  // Membership in Workspace is authoritative; channel/user projections are repairable.
  const workspace = await Workspace.findOne({ _id: workspaceId, ...active, 'members.user': userId });
  if (!workspace) return null;
  await Channel.updateMany({ workspace: workspaceId, isDefault: true, 'members.user': { $ne: userId } }, { $push: { members: { user: userId, role: 'member' } } });
  await User.updateOne({ _id: userId }, { $addToSet: { workspaces: workspaceId } });
  // The user's already-open sockets (any device) gain access immediately: the workspace room plus the default
  // channels they were just added to. Nothing else; private channels and DMs stay closed to them.
  const defaults = await Channel.find({ workspace: workspaceId, isDefault: true, isArchived: false, 'members.user': userId }).select('_id').lean();
  await grant(io, userId, [`workspace:${workspaceId}`, ...defaults.map((channel) => `channel:${channel._id}`)]);
  return workspace;
}

async function notifyAdmins(io, workspace, request, applicant) {
  await createNotifications(io, workspace.members.filter(m => ['owner', 'admin'].includes(m.role)).map(member => ({
    recipient: member.user, workspace: workspace._id, actor: applicant._id,
    type: 'workspace_join_request', content: `${applicant.displayName} wants to join your workspace.`,
    metadata: { joinRequestId: String(request._id), workspaceName: workspace.name }, dedupeKey: `workspace_join:${request._id}`,
  })));
  for (const member of workspace.members.filter(m => ['owner', 'admin'].includes(m.role))) {
    io?.to(`user:${member.user}`).emit('workspace:join_request', { workspaceId: workspace._id });
  }
}

async function markRequestNotificationsRead(io, workspaceId, requestId) {
  const readAt = new Date();
  const notifications = await Notification.find({ workspace: workspaceId, type: 'workspace_join_request', 'metadata.joinRequestId': String(requestId), isRead: false }).select('_id recipient');
  await Notification.updateMany({ _id: { $in: notifications.map(n => n._id) } }, { $set: { isRead: true, readAt } });
  for (const notification of notifications) io?.to(`user:${notification.recipient}`).emit('notification:read', { notificationId: notification._id, readAt });
}
// Tells the requester how their request ended. Only the requester's own user room is addressed. Approval also
// leaves a persistent activity item (they are a member by then); a rejected requester is not a member, so for them
// the durable record is the request status (GET /api/workspaces/join-requests).
async function announceDecision(io, workspace, request, status, reviewer) {
  const payload = { workspaceId: String(workspace._id), requestId: String(request._id), status };
  const userRoom = `user:${request.user}`;
  io?.to(userRoom).emit('workspace:join_decided', { workspaceId: payload.workspaceId, status });
  if (status === 'approved') {
    io?.to(userRoom).emit('workspace:join_request_approved', { ...payload, workspace: { _id: workspace._id, name: workspace.name, icon: workspace.icon } });
    await createNotifications(io, [{
      recipient: request.user, workspace: workspace._id, actor: reviewer._id || reviewer, type: 'workspace_join_approved',
      content: `Your request to join ${workspace.name} was accepted.`, metadata: { joinRequestId: String(request._id), workspaceName: workspace.name },
      dedupeKey: `workspace_join_approved:${request._id}`,
    }]).catch((error) => console.error('Approval notification failed:', error.message));
  } else {
    io?.to(userRoom).emit('workspace:join_request_rejected', payload);
  }
}

module.exports = { announceDecision, active, publicRequest, summary, adminFilter, repairMembership, notifyAdmins, markRequestNotificationsRead };
