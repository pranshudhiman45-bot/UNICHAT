const mongoose = require('mongoose');

const webPushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true, maxlength: 2048 },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  userAgent: { type: String, default: '', maxlength: 512 },
  lastUsedAt: { type: Date, default: Date.now },
}, { timestamps: true });

webPushSubscriptionSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model('WebPushSubscription', webPushSubscriptionSchema);
