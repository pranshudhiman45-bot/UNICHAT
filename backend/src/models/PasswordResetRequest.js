const mongoose = require('mongoose');

const approvalTokenSchema = new mongoose.Schema({
  hash: { type: String, required: true },
  approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { _id: false });

const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  status: { type: String, enum: ['pending', 'approved', 'verified', 'completed', 'used', 'expired', 'rejected', 'locked'], default: 'pending', index: true },
  codeHash: { type: String, select: false, default: null },
  resetTokenHash: { type: String, select: false, default: null },
  statusTokenHash: { type: String, select: false, default: null },
  approvalTokens: { type: [approvalTokenSchema], select: false, default: [] },
  approvalMethod: { type: String, enum: ['direct', 'otp', null], default: null },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, default: null },
  requestedAt: { type: Date, default: Date.now },
  approvedAt: { type: Date, default: null },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  verifiedAt: { type: Date, default: null },
  usedAt: { type: Date, default: null },
  emailNotificationStatus: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
  emailNotificationAttempts: { type: Number, default: 0 },
  emailLastAttemptAt: { type: Date, default: null },
  emailSentAt: { type: Date, default: null },
  emailLastError: { type: String, default: '', maxlength: 300 },
  requestIp: { type: String, default: '' },
  userAgent: { type: String, default: '' },
}, { timestamps: true });

schema.index({ user: 1, requestedAt: -1 });
schema.index({ 'approvalTokens.hash': 1 });
schema.index({ status: 1, expiresAt: 1 });
module.exports = mongoose.model('PasswordResetRequest', schema);
