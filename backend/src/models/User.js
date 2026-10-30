const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const notificationPreferenceSchema = new mongoose.Schema({
  workspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true },
  level: { type: String, enum: ['all', 'mentions_dms', 'mentions', 'important', 'nothing', 'muted'], default: 'all' },
  notifyThreadReplies: { type: Boolean, default: true },
  notifyReactions: { type: Boolean, default: true },
  playSound: { type: Boolean, default: true },
  mutedChannels: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  mutedDMs: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  dndUntil: { type: Date, default: null },
}, { _id: false });

const refreshSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  tokenHash: { type: String, required: true },
  // The immediately previous token stays valid briefly so a lost refresh response does not log the user out.
  prevTokenHash: { type: String, default: null },
  rotatedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, required: true },
}, { _id: false });

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 2, maxlength: 30 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 6, select: false },
  googleId: { type: String, unique: true, sparse: true, select: false },
  resetEmailRequestedAt: { type: Date, default: null, select: false },
  emailVerifiedAt: { type: Date, default: null },
  role: { type: String, enum: ['SUPER_ADMIN', 'USER'], default: 'USER' },
  accountStatus: { type: String, enum: ['active', 'disabled'], default: 'active' },
  sessionVersion: { type: Number, default: 0 },
  displayName: { type: String, required: true, trim: true },
  avatar: { type: String, default: null },
  avatarPublicId: { type: String, default: null },
  status: { type: String, enum: ['online', 'away', 'busy', 'offline'], default: 'offline' },
  statusMessage: { type: String, default: '', maxlength: 100 },
  bio: { type: String, default: '', maxlength: 200 },
  timezone: { type: String, default: 'UTC' },
  phone: { type: String, default: '' },
  title: { type: String, default: '', maxlength: 80 },
  workspaces: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' }],
  lastSeen: { type: Date, default: Date.now },
  refreshToken: { type: String, select: false },
  refreshSessions: { type: [refreshSessionSchema], default: [], select: false },
  notificationSettings: {
    mentions: { type: Boolean, default: true },
    directMessages: { type: Boolean, default: true },
    channelMessages: { type: Boolean, default: false },
    threadReplies: { type: Boolean, default: true },
    reactions: { type: Boolean, default: true },
    calls: { type: Boolean, default: true },
    securityAlerts: { type: Boolean, default: true },
    desktopNotifications: { type: Boolean, default: true },
    sounds: { type: Boolean, default: true },
    pushEnabled: { type: Boolean, default: false },
    webPushEnabled: { type: Boolean, default: false },
    pushPreview: { type: Boolean, default: true },
  },
  notificationPreferences: { type: [notificationPreferenceSchema], default: [] },
  theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
  pushTokens: [{ type: String }],
}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toPublicJSON = function () {
  return {
    _id: this._id,
    username: this.username,
    email: this.email,
    role: this.role,
    accountStatus: this.accountStatus,
    displayName: this.displayName,
    avatar: this.avatar,
    status: this.status,
    statusMessage: this.statusMessage,
    bio: this.bio,
    title: this.title,
    timezone: this.timezone,
    lastSeen: this.lastSeen,
    notificationSettings: this.notificationSettings,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
