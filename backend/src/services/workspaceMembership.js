const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const User = require('../models/User');
const { revokeWorkspace } = require('../socket/rooms');

// Guarantees every non-empty channel keeps an administrator after members disappear.
// Promotes the longest-standing member; archives a channel nobody belongs to any more.
async function repairChannelAdmins(channelIds) {
  for (const id of channelIds) {
    const channel = await Channel.findById(id);
    if (!channel || channel.isArchived) continue;
    if (!channel.members.length) {
      if (!channel.isDefault) { channel.isArchived = true; await channel.save(); }
      continue;
    }
    if (channel.members.some((member) => member.role === 'admin')) continue;
    const oldest = [...channel.members].sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt))[0];
    await Channel.updateOne({ _id: id, 'members.user': oldest.user }, { $set: { 'members.$.role': 'admin' } });
  }
}

// Removes a user from a workspace and everything inside it. The owner can never be removed this way.
async function removeMember({ io, workspaceId, userId, reason = 'removed' }) {
  const removed = await Workspace.updateOne(
    { _id: workspaceId, owner: { $ne: userId }, 'members.user': userId },
    { $pull: { members: { user: userId } } },
  );
  if (!removed.modifiedCount) return false;
  await User.updateOne({ _id: userId }, { $pull: { workspaces: workspaceId } });

  const affected = await Channel.find({ workspace: workspaceId, 'members.user': userId }).select('_id').lean();
  await Channel.updateMany({ workspace: workspaceId, 'members.user': userId }, { $pull: { members: { user: userId } } });
  await repairChannelAdmins(affected.map((channel) => channel._id));
  // Group conversations drop the person. One-to-one DMs stay for the other participant but become unreachable
  // for the removed user because DM access also requires workspace membership.
  await DirectMessage.updateMany({ workspace: workspaceId, isGroup: true, participants: userId }, { $pull: { participants: userId, memberData: { user: userId } } });

  await revokeWorkspace(io, userId, workspaceId);
  io?.to(`user:${userId}`).emit('workspace:removed', { workspaceId, reason });
  io?.to(`workspace:${workspaceId}`).emit('workspace:member_left', { workspaceId, userId });
  return true;
}

module.exports = { removeMember, repairChannelAdmins };
