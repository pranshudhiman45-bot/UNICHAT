const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { adminEmail, validAdminToken, compareAdminPassword, audit } = require('../services/adminSecurity');
const {
  ALLOWED_REGISTRATION_DOMAIN,
  isAllowedRegistrationEmail,
  ensureDefaultWorkspaceMembership,
} = require('../utils/defaultWorkspace');

const { readCookie, isCookieClient, refreshCookieOptions, sendTokens, hashRefreshToken, generateTokens, createSession } = require('../services/authSessions');
const { passwordValid, verificationRequired, consumeEmailProof, peekEmailProof } = require('../services/emailVerification');
const bcrypt = require('bcryptjs');

// bcrypt takes ~250ms. Comparing against a throwaway hash when the email is unknown keeps the response time
// identical for "no such account" and "wrong password", so timing cannot be used to list registered emails.
let dummyHash;
const getDummyHash = () => (dummyHash ||= bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12));
const { limiter } = require('../services/redis');
// Grace period in which the immediately previous refresh token still works, so a lost refresh response does
// not log the user out. Set REFRESH_REUSE_WINDOW_SECONDS=0 for strict single-use tokens.
const refreshReuseWindowMs = () => Math.max(0, Number(process.env.REFRESH_REUSE_WINDOW_SECONDS ?? 30)) * 1000;
const loginLimiter = limiter('login', { windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Try again later.' } });
// POST /api/auth/register
router.post('/register', loginLimiter, [
  body('email').isString().withMessage('Enter a valid email address').bail().trim().toLowerCase().isEmail().withMessage('Enter a valid email address'),
  body('password').custom(passwordValid).withMessage('Use at least 10 characters and at most 72 UTF-8 bytes'),
  body('username').isString().withMessage('Enter a username').bail().trim().toLowerCase().isLength({ min: 2, max: 30 }).withMessage('Username must contain 2–30 characters').bail().matches(/^[a-zA-Z0-9_.-]+$/).withMessage('Username can only contain letters, numbers, dots, underscores or hyphens. Use a name such as pranshu45, not an email address.'),
  body('displayName').isString().withMessage('Enter your full name').bail().trim().isLength({ min: 1, max: 50 }).withMessage('Full name must contain 1–50 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const details = errors.array({ onlyFirstError: true }).map(({ path, msg }) => ({ field: path, message: msg }));
      return res.status(400).json({ error: details.map(({ message }) => message).join(' '), details });
    }

    const { email, password, username, displayName } = req.body;

    if (adminEmail() && email === adminEmail()) return res.status(403).json({ error: 'This account is managed by the administrator' });

    if (!isAllowedRegistrationEmail(email)) {
      return res.status(400).json({
        error: `Only @${ALLOWED_REGISTRATION_DOMAIN} email addresses can create accounts`,
      });
    }

    // Prove mailbox ownership BEFORE saying anything about whether the address or username is taken, otherwise
    // this endpoint would let anyone test which emails are registered.
    if (verificationRequired() && !await peekEmailProof(email, req.body.emailVerificationToken)) return res.status(400).json({ error: 'Verify your email before creating an account', code: 'EMAIL_VERIFICATION_REQUIRED' });
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      const field = existingUser.email === email ? 'email' : 'username';
      return res.status(409).json({ error: `${field} already in use` });
    }

    if (verificationRequired() && !await consumeEmailProof(email, req.body.emailVerificationToken)) return res.status(400).json({ error: 'Verify your email before creating an account', code: 'EMAIL_VERIFICATION_REQUIRED' });
    const user = new User({ email, password, username, displayName, ...(verificationRequired() ? { emailVerifiedAt: new Date() } : {}) });
    await user.save();
    await ensureDefaultWorkspaceMembership(user._id);

    const { accessToken, refreshToken } = await createSession(user);

    sendTokens(req, res, user, { accessToken, refreshToken }, 201);
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, [
  body('email').isEmail().trim().toLowerCase(),
  body('password').isString().isLength({ min: 1, max: 1024 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid credentials format' });
    }

    const { email, password } = req.body;
    const adminAttempt = Boolean(adminEmail() && email === adminEmail());
    let user = await User.findOne({ email }).select('+password +refreshToken +refreshSessions');
    const isValid = adminAttempt ? await compareAdminPassword(email, password) : user ? await user.comparePassword(password) : (await bcrypt.compare(password, await getDummyHash()), false);
    if (!isValid) {
      if (adminAttempt) await audit(req, 'ADMIN_LOGIN_FAILED', { userId: user?._id });
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (adminAttempt) {
      if (!user) {
        user = await User.create({ email, username: `admin${crypto.randomBytes(5).toString('hex')}`, displayName: 'Unichat Admin', password: crypto.randomBytes(48).toString('hex'), role: 'SUPER_ADMIN' });
      }
      if (user.role !== 'SUPER_ADMIN') {
        user.role = 'SUPER_ADMIN';
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        user.refreshSessions = [];
        user.refreshToken = null;
      }
      // The configured bcrypt hash is the only accepted admin credential.
      await User.updateOne({ _id: user._id }, { $set: { password: process.env.ADMIN_PASSWORD_HASH } });
    }
    if (user.accountStatus === 'disabled') return res.status(403).json({ error: 'Account disabled' });

    if (user.isModified('role')) await user.save();
    const { accessToken, refreshToken } = await createSession(user);
    await ensureDefaultWorkspaceMembership(user._id);

    if (adminAttempt) { req.userId = user._id.toString(); await audit(req, 'ADMIN_LOGIN_SUCCESS', { userId: user._id }); }

    sendTokens(req, res, user, { accessToken, refreshToken });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = isCookieClient(req) ? readCookie(req, 'unichat_refresh') : req.body?.refreshToken;
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId).select('+refreshToken +refreshSessions');
    const presentedHash = hashRefreshToken(refreshToken);
    const graceCutoff = Date.now() - refreshReuseWindowMs();
    const session = user?.refreshSessions?.find((entry) => entry.sessionId === decoded.sid && (entry.tokenHash === presentedHash
      || (refreshReuseWindowMs() > 0 && entry.prevTokenHash === presentedHash && entry.rotatedAt && entry.rotatedAt.getTime() > graceCutoff)));
    if (!user || user.accountStatus === 'disabled' || !validAdminToken(user, decoded) || (decoded.ver || 0) !== (user.sessionVersion || 0) || !session) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const sessionId = decoded.sid || crypto.randomUUID();
    const tokens = generateTokens(user, sessionId);
    const rotated = await User.updateOne(
      { _id: user._id, sessionVersion: user.sessionVersion || 0, accountStatus: 'active', refreshSessions: { $elemMatch: { sessionId, $or: [{ tokenHash: presentedHash }, ...(refreshReuseWindowMs() > 0 ? [{ prevTokenHash: presentedHash, rotatedAt: { $gt: new Date(graceCutoff) } }] : [])] } } },
      { $set: { 'refreshSessions.$.prevTokenHash': session.tokenHash === presentedHash ? presentedHash : session.prevTokenHash, 'refreshSessions.$.rotatedAt': session.tokenHash === presentedHash ? new Date() : session.rotatedAt, 'refreshSessions.$.tokenHash': hashRefreshToken(tokens.refreshToken), 'refreshSessions.$.createdAt': new Date() } },
    );
    if (!rotated.modifiedCount) return res.status(401).json({ error: 'Refresh session already used or revoked' });

    sendTokens(req, res, null, tokens);
  } catch (err) {
    if (isCookieClient(req)) res.clearCookie('unichat_refresh', refreshCookieOptions(true));
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('+refreshToken +refreshSessions');
    if (user) {
      await User.updateOne({ _id: user._id }, { $pull: { refreshSessions: { sessionId: req.sessionId } }, $unset: { refreshToken: '' } });
    }
    await require('../services/pushNotifications').revokePushDevices(req.userId, req.sessionId);
    const io = req.app.get('io');
    if (io) {
      const sockets = await io.in(`user:${req.userId}`).fetchSockets();
      sockets.filter((socket) => !req.sessionId || socket.data.sessionId === req.sessionId).forEach((socket) => socket.disconnect(true));
    }
    res.clearCookie('unichat_refresh', refreshCookieOptions(true));
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try { await ensureDefaultWorkspaceMembership(req.userId); res.json({ user: req.user.toPublicJSON() }); } catch (error) { next(error); }
});

module.exports = router;
