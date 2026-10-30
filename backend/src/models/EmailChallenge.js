const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  codeHash: { type: String, select: false },
  proofHash: { type: String, select: false },
  attempts: { type: Number, default: 0 },
  verifiedAt: { type: Date, default: null },
  requestedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('EmailChallenge', schema);
