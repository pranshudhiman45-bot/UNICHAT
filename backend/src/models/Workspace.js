const mongoose = require('mongoose');
const crypto = require('node:crypto');

const memberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['owner', 'admin', 'member', 'guest'], default: 'member' },
  joinedAt: { type: Date, default: Date.now },
  customDisplayName: { type: String },
}, { _id: false });

const joinRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestedAt: { type: Date, default: Date.now },
  reviewedAt: Date,
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

const workspaceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  description: { type: String, default: '', maxlength: 300 },
  icon: { type: String, default: null },
  iconPublicId: { type: String, default: null },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: [memberSchema],
  // Kept with membership so approval and admission are one atomic write,
  // including on standalone MongoDB. Never expose applicants to ordinary members.
  joinRequests: { type: [joinRequestSchema], default: [], select: false },
  inviteCode: { type: String, default: () => crypto.randomBytes(8).toString('hex').toUpperCase(), unique: true },
  plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
  settings: {
    defaultChannels: [{ type: String }],
    allowGuestAccess: { type: Boolean, default: false },
    messageRetentionDays: { type: Number, default: 0 },
  },
  isArchived: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, { timestamps: true });

workspaceSchema.index({ 'members.user': 1 });
workspaceSchema.index({ 'joinRequests.user': 1 });

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

workspaceSchema.methods.getMember = function (userId) {
  const targetUserId = resolveUserId(userId);
  return this.members.find((member) => resolveUserId(member.user) === targetUserId);
};

workspaceSchema.methods.isMember = function (userId) {
  return !!this.getMember(userId);
};

workspaceSchema.methods.isAdmin = function (userId) {
  const m = this.getMember(userId);
  return m && ['owner', 'admin'].includes(m.role);
};

module.exports = mongoose.model('Workspace', workspaceSchema);
