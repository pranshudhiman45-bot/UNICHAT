const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const { audit } = require('./adminSecurity');

async function softDeleteWorkspace(req, res, next) {
  try {
    const id = req.params.id || req.params.workspaceId;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Workspace not found' });
    const workspace = await Workspace.findById(id);
    if (!workspace || workspace.deletedAt) return res.status(404).json({ error: 'Workspace not found' });
    if (req.body.confirmName !== workspace.name) return res.status(400).json({ error: 'Type the exact workspace name to confirm' });
    workspace.deletedAt = new Date();
    workspace.isArchived = true;
    await workspace.save();
    const io = req.app.get('io');
    if (io) {
      io.to(`workspace:${workspace._id}`).emit('workspace:deleted', { workspaceId: workspace._id });
      const memberSockets = await Promise.all(workspace.members.map((member) => io.in(`user:${member.user}`).fetchSockets()));
      new Map(memberSockets.flat().map((socket) => [socket.id, socket])).forEach((socket) => socket.disconnect(true));
    }
    await audit(req, 'WORKSPACE_DELETED', { workspaceId: workspace._id });
    return res.json({ workspace });
  } catch (error) { next(error); }
}

module.exports = { softDeleteWorkspace };
