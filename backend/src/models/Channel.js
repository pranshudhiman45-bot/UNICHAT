const mongoose = require('mongoose');

const channelMemberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  lastRead: { type: Date, default: Date.now },
  notificationLevel: { type: String, enum: ['all', 'mentions', 'nothing'], default: 'all' },
  joinedAt: { type: Date, default: Date.now },
}, { _id: false });

const pinnedMessageSchema = new mongoose.Schema({
  message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  pinnedAt: { type: Date, default: Date.now },
}, { _id: false });

const channelSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  name: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
  description: { type: String, default: '', maxlength: 300 },
  type: { type: String, enum: ['public', 'private'], default: 'public' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [channelMemberSchema],
  pinnedMessages: [pinnedMessageSchema],
  isDefault: { type: Boolean, default: false },
  isArchived: { type: Boolean, default: false },
  topic: { type: String, default: '', maxlength: 250 },
  lastActivity: { type: Date, default: Date.now },
  messageCount: { type: Number, default: 0 },
}, { timestamps: true });

channelSchema.index({ workspace: 1, name: 1 }, { unique: true });
channelSchema.index({ workspace: 1, 'members.user': 1 });

function resolveUserId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (typeof value === 'object') {
    if (value._id) return resolveUserId(value._id);
    if (value.id) return value.id.toString();
  }
  return value.toString?.() || null;
}

channelSchema.methods.isMember = function (userId) {
  const targetUserId = resolveUserId(userId);
  return this.members.some((member) => resolveUserId(member.user) === targetUserId);
};

channelSchema.methods.getMemberLastRead = function (userId) {
  const targetUserId = resolveUserId(userId);
  const member = this.members.find((entry) => resolveUserId(entry.user) === targetUserId);
  return member ? member.lastRead : null;
};

module.exports = mongoose.model('Channel', channelSchema);
