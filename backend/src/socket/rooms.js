const Workspace = require('../models/Workspace');
const Channel = require('../models/Channel');
const DirectMessage = require('../models/DirectMessage');
const Message = require('../models/Message');

// Room naming is the single source of truth for who may receive what:
//   user:<id>       private per-user events (notifications, invites)
//   workspace:<id>  low-sensitivity workspace events only (presence, profile, member changes).
//                   NEVER message content.
//   channel:<id>    messages for a channel; joined only after a membership/visibility check
//   dm:<id>         messages for a DM or group DM; participants only
//   thread:<id>     replies for a thread; joined only after thread authorization
const rooms = {
  user: (id) => `user:${id}`,
  workspace: (id) => `workspace:${id}`,
  channel: (id) => `channel:${id}`,
  dm: (id) => `dm:${id}`,
  thread: (id) => `thread:${id}`,
};

// Rooms a user is entitled to on connect. Computed server-side from the database.
async function authorizedRoomsFor(userId) {
  const workspaces = await Workspace.find({ 'members.user': userId, deletedAt: null, isArchived: false }).select('_id').lean();
  const workspaceIds = workspaces.map((workspace) => workspace._id);
  const [channels, dms] = await Promise.all([
    Channel.find({ workspace: { $in: workspaceIds }, isArchived: false, 'members.user': userId }).select('_id').lean(),
    DirectMessage.find({ workspace: { $in: workspaceIds }, participants: userId }).select('_id').lean(),
  ]);
  return [
    ...workspaceIds.map((id) => rooms.workspace(id)),
    ...channels.map((channel) => rooms.channel(channel._id)),
    ...dms.map((dm) => rooms.dm(dm._id)),
  ];
}

// io.in(...).socketsJoin/socketsLeave go through the adapter, so they also reach
// sockets of the same user on other server instances and on every device.
async function grant(io, userId, roomNames) {
  if (io && roomNames.length) io.in(rooms.user(userId)).socketsJoin(roomNames);
}

async function revoke(io, userId, roomNames) {
  if (io && roomNames.length) io.in(rooms.user(userId)).socketsLeave(roomNames);
}

async function threadRoomsIn(filter) {
  const parents = await Message.find({ ...filter, 'thread.replyCount': { $gt: 0 } }).select('_id').lean();
  return parents.map((message) => rooms.thread(message._id));
}

const grantChannel = (io, userId, channelId) => grant(io, userId, [rooms.channel(channelId)]);
const grantDm = (io, userId, dmId) => grant(io, userId, [rooms.dm(dmId)]);

async function revokeChannel(io, userId, channelId) {
  await revoke(io, userId, [rooms.channel(channelId), ...await threadRoomsIn({ channel: channelId })]);
}

async function revokeDm(io, userId, dmId) {
  await revoke(io, userId, [rooms.dm(dmId), ...await threadRoomsIn({ dm: dmId })]);
}

// Removes a user from every room that belongs to a workspace (used on leave/removal).
async function revokeWorkspace(io, userId, workspaceId) {
  const [channels, dms] = await Promise.all([
    Channel.find({ workspace: workspaceId }).select('_id').lean(),
    DirectMessage.find({ workspace: workspaceId }).select('_id').lean(),
  ]);
  const threads = await threadRoomsIn({ workspace: workspaceId });
  await revoke(io, userId, [
    rooms.workspace(workspaceId),
    ...channels.map((channel) => rooms.channel(channel._id)),
    ...dms.map((dm) => rooms.dm(dm._id)),
    ...threads,
  ]);
}

module.exports = { rooms, authorizedRoomsFor, grant, revoke, grantChannel, grantDm, revokeChannel, revokeDm, revokeWorkspace };
