const EmailChallenge = require('../models/EmailChallenge');
const { codeHash, newCode, newToken, tokenHash, secureMatch } = require('./passwordRecovery');
const { sendEmail } = require('./emailService');

const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordValid = (value) => typeof value === 'string' && value.length >= 10 && Buffer.byteLength(value, 'utf8') <= 72;
const verificationRequired = () => process.env.NODE_ENV === 'production' || process.env.REQUIRE_EMAIL_VERIFICATION !== 'false';

async function requestEmailVerification(email) {
  const now = new Date();
  const generated = newCode(`email:${email}`);
  // A unique email row and conditional upsert enforce a shared resend cooldown.
  let challenge;
  try {
    challenge = await EmailChallenge.findOneAndUpdate({ email, requestedAt: { $lte: new Date(Date.now() - 60000) } }, {
      $set: { codeHash: generated.hash, proofHash: null, attempts: 0, verifiedAt: null, requestedAt: now, expiresAt: generated.expiresAt },
      $setOnInsert: { email },
    }, { upsert: true, new: true });
  } catch (error) { if (error.code === 11000) return; throw error; }
  try {
    await sendEmail({ to: email, subject: 'Verify your Unichat email', text: `Your Unichat verification code is ${generated.code}.\n\nIt expires in 10 minutes. Never share this code. If you did not request it, ignore this email.` });
  } catch (error) {
    await EmailChallenge.deleteOne({ _id: challenge._id, requestedAt: now });
    throw error;
  }
}

async function verifyEmailCode(email, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  // Reserve an attempt before comparison, so concurrent guesses cannot bypass the limit.
  const challenge = await EmailChallenge.findOneAndUpdate({ email, verifiedAt: null, attempts: { $lt: 5 }, expiresAt: { $gt: new Date() } }, { $inc: { attempts: 1 } }, { new: true }).select('+codeHash');
  if (!challenge || !secureMatch(codeHash(`email:${email}`, code), challenge.codeHash)) return null;
  const proof = newToken();
  const result = await EmailChallenge.updateOne({ _id: challenge._id, verifiedAt: null, codeHash: challenge.codeHash, requestedAt: challenge.requestedAt, expiresAt: { $gt: new Date() } }, { $set: { proofHash: tokenHash(proof), codeHash: null, verifiedAt: new Date() } });
  return result.modifiedCount ? proof : null;
}

async function consumeEmailProof(email, proof) {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const result = await EmailChallenge.deleteOne({ email, proofHash: tokenHash(proof), verifiedAt: { $ne: null }, expiresAt: { $gt: new Date() } });
  return result.deletedCount === 1;
}

// Read-only check that a proof is valid (consumeEmailProof is the one that spends it).
async function peekEmailProof(email, proof) {
  if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)) return false;
  return Boolean(await EmailChallenge.exists({ email, proofHash: tokenHash(proof), verifiedAt: { $ne: null }, expiresAt: { $gt: new Date() } }));
}

module.exports = { peekEmailProof, normalizeEmail, validEmail, passwordValid, verificationRequired, requestEmailVerification, verifyEmailCode, consumeEmailProof };
