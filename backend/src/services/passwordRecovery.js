const crypto = require('crypto');

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function codeHash(requestId, code) {
  // A keyed hash prevents offline brute-forcing of a six-digit database value.
  const key = process.env.PASSWORD_RESET_PEPPER || process.env.JWT_SECRET;
  if (!key) throw new Error('Password reset signing key is not configured');
  return crypto.createHmac('sha256', key).update(`${requestId}:${code}`).digest('hex');
}
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function secureMatch(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function newCode(requestId, lifetimeMs = CODE_LIFETIME_MS) {
  const code = String(crypto.randomInt(100000, 1000000));
  return { code, hash: codeHash(requestId, code), expiresAt: new Date(Date.now() + lifetimeMs) };
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }

module.exports = { CODE_LIFETIME_MS, MAX_ATTEMPTS, codeHash, tokenHash, secureMatch, newCode, newToken };
