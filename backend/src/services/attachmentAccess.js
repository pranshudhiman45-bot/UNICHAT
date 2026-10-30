const crypto = require('crypto');

const ACCESS_TTL_SECONDS = 5 * 60;

function accessSignature(uploadId, userId, expiresAt) {
  return crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(`${uploadId}.${userId}.${expiresAt}`)
    .digest('hex');
}

function createAccessUrl(uploadId, userId, req) {
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  const signature = accessSignature(String(uploadId), String(userId), expiresAt);
  const configuredBase = process.env.PUBLIC_API_URL?.trim().replace(/\/$/, '');
  const base = configuredBase || `${req.protocol}://${req.get('host')}/api`;
  return `${base}/files/access/${uploadId}?user=${encodeURIComponent(userId)}&expires=${expiresAt}&signature=${signature}`;
}

function verifyAccessSignature(uploadId, userId, expiresAt, signature) {
  const exp = Number(expiresAt);
  if (!Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000) || exp > Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS + 5) return false;
  if (typeof signature !== 'string' || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(accessSignature(String(uploadId), String(userId), exp), 'hex');
  const supplied = Buffer.from(signature, 'hex');
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

// Fields that would let a client reach the raw storage object without going through authorization.
const RAW_STORAGE_FIELDS = ['secureUrl', 'publicId'];

function mapAttachments(value, transform) {
  if (Array.isArray(value)) return value.map((entry) => mapAttachments(entry, transform));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.toObject === 'function') value = value.toObject();
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const result = { ...value };
  for (const [key, entry] of Object.entries(result)) {
    if (key === 'attachments' && Array.isArray(entry)) {
      result[key] = entry.map((attachment) => (attachment?.accessMode !== 'authenticated' || !attachment.uploadId ? mapAttachments(attachment, transform) : transform(attachment)));
    } else {
      result[key] = mapAttachments(entry, transform);
    }
  }
  return result;
}

function withoutRawFields(attachment) {
  const copy = { ...attachment };
  for (const field of RAW_STORAGE_FIELDS) delete copy[field];
  return copy;
}

// HTTP responses: each authenticated attachment gets a short-lived URL bound to the requesting user.
function secureAttachmentLinks(value, req) {
  return mapAttachments(value, (attachment) => ({
    ...withoutRawFields(attachment),
    url: createAccessUrl(attachment.uploadId, req.userId, req),
    urlExpiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
  }));
}

// Socket broadcasts reach many users at once, so they must not carry any URL. Clients resolve a
// fresh per-user URL on demand (POST /api/files/urls), which also covers long-open chats.
function stripAttachmentLinks(value) {
  return mapAttachments(value, (attachment) => ({ ...withoutRawFields(attachment), url: '', urlRequired: true }));
}

module.exports = { ACCESS_TTL_SECONDS, createAccessUrl, secureAttachmentLinks, stripAttachmentLinks, verifyAccessSignature };
