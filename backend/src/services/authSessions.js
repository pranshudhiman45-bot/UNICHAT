const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { adminTokenVersion } = require('./adminSecurity');
function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  try { return decodeURIComponent(entry.slice(name.length + 1)); } catch { return null; }
}

function isCookieClient(req) {
  return req.get('X-Client-Auth') === 'cookie';
}

function refreshCookieOptions(clear = false) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    ...(!clear ? { maxAge: Number(process.env.JWT_REFRESH_COOKIE_MAX_AGE_MS) || 30 * 24 * 60 * 60 * 1000 } : {}),
  };
}

function sendTokens(req, res, user, tokens, status = 200) {
  res.set('Cache-Control', 'no-store');
  if (isCookieClient(req)) res.cookie('unichat_refresh', tokens.refreshToken, refreshCookieOptions());
  return res.status(status).json({
    ...(user ? { user: user.toPublicJSON() } : {}),
    accessToken: tokens.accessToken,
    ...(!isCookieClient(req) ? { refreshToken: tokens.refreshToken } : {}),
  });
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const generateTokens = (user, sessionId) => {
  const userId = user._id;
  const ver = user.sessionVersion || 0;
  const av = user.role === 'SUPER_ADMIN' ? adminTokenVersion() : undefined;
  const role = user.role || 'USER';
  const accessToken = jwt.sign(
    { userId, sid: sessionId, ver, av, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = jwt.sign(
    { userId, sid: sessionId, ver, av, role },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d', jwtid: crypto.randomUUID() }
  );
  return { accessToken, refreshToken };
};

async function createSession(user) {
  const sessionId = crypto.randomUUID();
  const tokens = generateTokens(user, sessionId);
  const result = await require('../models/User').updateOne({ _id: user._id, sessionVersion: user.sessionVersion || 0, accountStatus: 'active' }, {
    $set: { refreshToken: null, lastSeen: new Date() },
    $push: { refreshSessions: { $each: [{ sessionId, tokenHash: hashRefreshToken(tokens.refreshToken), createdAt: new Date() }], $sort: { createdAt: -1 }, $slice: 10 } },
  });
  if (!result.modifiedCount) throw Object.assign(new Error('Account changed during sign-in. Try again.'), { status: 401 });
  return tokens;
}
module.exports = { readCookie, isCookieClient, refreshCookieOptions, sendTokens, hashRefreshToken, generateTokens, createSession };
