const mongoose = require('mongoose');

const storedAttachmentSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel', default: null, index: true },
  dm: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectMessage', default: null, index: true },
  parentMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  publicId: { type: String, required: true, unique: true },
  url: { type: String, required: true },
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  type: { type: String, enum: ['image', 'video', 'document'], required: true },
  size: { type: Number, required: true },
  width: { type: Number },
  height: { type: Number },
  format: { type: String },
  resourceType: { type: String, enum: ['image', 'video', 'raw'], required: true },
  accessMode: { type: String, enum: ['public', 'authenticated'], default: 'public', required: true },
  status: { type: String, enum: ['staged', 'attached', 'deleted'], default: 'staged', index: true },
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null, index: true },
  // Cleanup bookkeeping: a deleted attachment whose stored file could not be removed is retried with backoff.
  assetDeleted: { type: Boolean, default: false },
  cleanupAttempts: { type: Number, default: 0 },
  nextCleanupAt: { type: Date, default: null },
}, { timestamps: true });

storedAttachmentSchema.index({ uploadedBy: 1, status: 1, createdAt: 1 });
storedAttachmentSchema.index({ status: 1, createdAt: 1 });
storedAttachmentSchema.index({ status: 1, assetDeleted: 1, nextCleanupAt: 1 });

// Bookkeeping rows for files that are fully gone from storage are dropped after 30 days.
storedAttachmentSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 30 * 86400, partialFilterExpression: { status: 'deleted', assetDeleted: true }, name: 'deleted_attachment_retention' });

module.exports = mongoose.model('StoredAttachment', storedAttachmentSchema);
