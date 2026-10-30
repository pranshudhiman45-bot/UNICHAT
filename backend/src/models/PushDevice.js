const mongoose = require('mongoose');

// One row per physical Expo push token. The unique token means a device can belong to exactly one
// user at a time: signing in as someone else on the same phone moves it, it never duplicates it.
const schema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sessionId: { type: String, default: null, index: true },
  platform: { type: String, default: '' },
  lastUsedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Devices that have not re-registered for 30 days (apps re-register on every launch) are dropped.
schema.index({ lastUsedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
module.exports = mongoose.model('PushDevice', schema);
