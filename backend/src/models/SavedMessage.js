const mongoose = require('mongoose');

const savedMessageSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', default: null },
  dm: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectMessage', default: null },
}, { timestamps: true });

savedMessageSchema.index({ user: 1, message: 1 }, { unique: true });
savedMessageSchema.index({ user: 1, workspace: 1, createdAt: -1 });

module.exports = mongoose.model('SavedMessage', savedMessageSchema);
