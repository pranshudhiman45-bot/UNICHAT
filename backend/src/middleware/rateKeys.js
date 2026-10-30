const jwt = require('jsonwebtoken');

// IPv6 clients can rotate through an entire /64 for free, so they are bucketed by their /64 prefix.
function ipKeyGenerator(ip) {
  const value = String(ip || 'unknown').replace(/^::ffff:/i, '');
  if (!value.includes(':')) return value;
  const [head, tail = ''] = value.split('::');
  const left = head ? head.split(':') : []; const right = tail ? tail.split(':') : [];
  const groups = value.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((group) => group.toLowerCase().padStart(4, '0')).join(':');
}

// Signed-in traffic is budgeted per user, not per IP: offices and universities put hundreds of people behind
// one address. The key comes from a VERIFIED token, so a caller can only ever spend their own budget.
function verifiedUserId(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  try { return String(jwt.verify(header.slice(7), process.env.JWT_SECRET).userId); } catch { return null; }
}

function requestKey(req) {
  const userId = req.userId || verifiedUserId(req);
  return userId ? `u:${userId}` : `ip:${ipKeyGenerator(req.ip)}`;
}
const isUserKey = (req) => requestKey(req).startsWith('u:');
module.exports = { requestKey, isUserKey, verifiedUserId, ipKeyGenerator };
