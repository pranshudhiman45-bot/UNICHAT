const Workspace = require('../models/Workspace');
async function emitToTeammates(io, userId, event, payload) {
  if (!io) return;
  const workspaces = await Workspace.find({ 'members.user': userId, deletedAt: null, isArchived: false }).select('_id').lean();
  io.to([`user:${userId}`, ...workspaces.map((workspace) => `workspace:${workspace._id}`)]).emit(event, payload);
}
module.exports = { emitToTeammates };
