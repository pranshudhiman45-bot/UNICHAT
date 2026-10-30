const mongoose = require('mongoose');
const { NOTIFICATION_TYPE_VALUES } = require('../services/notificationTypes');

const notificationSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  type: {
    type: String,
    enum: [...NOTIFICATION_TYPE_VALUES],
    required: true,
  },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'Channel' },
  dm: { type: mongoose.Schema.Types.ObjectId, ref: 'DirectMessage' },
  threadParent: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  content: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  dedupeKey: { type: String },
  isRead: { type: Boolean, default: false },
  readAt: { type: Date },
  clearedAt: { type: Date, default: null },
}, { timestamps: true });

notificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ workspace: 1, recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, dedupeKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ message: 1 });
notificationSchema.index({ threadParent: 1 });

// Retention: notifications older than N days are deleted by MongoDB itself (0 disables). Activity older than
// a quarter is not actionable and would otherwise grow without bound.
const retentionDays = Number(process.env.NOTIFICATION_RETENTION_DAYS ?? 90);
if (retentionDays > 0) notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: Math.round(retentionDays * 86400), name: 'notification_retention' });

module.exports = mongoose.model('Notification', notificationSchema);
