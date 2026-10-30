const mongoose = require('mongoose');

const approverSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notificationEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  emailNotifications: { type: Boolean, default: true },
  inAppNotifications: { type: Boolean, default: true },
}, { _id: false });

const schema = new mongoose.Schema({
  key: { type: String, default: 'default', unique: true, immutable: true },
  approvers: { type: [approverSchema], default: [] },
  directApprovalEnabled: { type: Boolean, default: true },
  otpEnabled: { type: Boolean, default: true },
  otpExpirationMinutes: { type: Number, default: 10, min: 1, max: 60 },
  maxOtpAttempts: { type: Number, default: 5, min: 1, max: 10 },
  approvalLinkExpirationMinutes: { type: Number, default: 15, min: 5, max: 60 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('RecoverySettings', schema);
