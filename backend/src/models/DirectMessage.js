const mongoose = require('mongoose');

const directMessageSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  isGroup: { type: Boolean, default: false },
  directKey: { type: String },
  groupName: { type: String },
  groupIcon: { type: String },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastMessage: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  lastActivity: { type: Date, default: Date.now },
  memberData: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastRead: { type: Date, default: Date.now },
    isArchived: { type: Boolean, default: false },
    isMuted: { type: Boolean, default: false },
    notificationLevel: { type: String, enum: ['all', 'mentions', 'nothing'], default: 'all' },
  }],
}, { timestamps: true });

directMessageSchema.index({ workspace: 1, participants: 1 });
directMessageSchema.index({ workspace: 1, lastActivity: -1 });
directMessageSchema.index({ participants: 1, lastActivity: -1 });
directMessageSchema.index(
  { workspace: 1, directKey: 1 },
  { unique: true, partialFilterExpression: { isGroup: false, directKey: { $exists: true } } }
);

directMessageSchema.pre('validate', function (next) {
  // Creation requires three people (enforced by the API); a group may shrink as people leave, so only reject empty groups.
  if (this.isGroup && this.participants.length < 1) return next(new Error('Group DMs need at least one participant'));
  if (!this.isGroup && this.participants.length !== 2) return next(new Error('Direct DMs require exactly two participants'));
  next();
});

module.exports = mongoose.model('DirectMessage', directMessageSchema);
