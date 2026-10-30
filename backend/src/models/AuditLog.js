const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  action: { type: String, required: true, maxlength: 80, index: true },
  targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  targetRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'PasswordResetRequest', default: null, index: true },
  targetWorkspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', default: null },
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ createdAt: -1 });
module.exports = mongoose.model('AuditLog', schema);
