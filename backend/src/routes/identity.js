const express = require('express');
const crypto = require('node:crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { limiter } = require('../services/redis');
const { adminEmail } = require('../services/adminSecurity');
const { createSession, sendTokens } = require('../services/authSessions');
const { normalizeEmail, validEmail, verificationRequired, requestEmailVerification, verifyEmailCode, consumeEmailProof } = require('../services/emailVerification');
const { isAllowedRegistrationEmail, ALLOWED_REGISTRATION_DOMAIN, ensureDefaultWorkspaceMembership } = require('../utils/defaultWorkspace');

const router = express.Router();
const google = new OAuth2Client();
const requestLimit = limiter('email-request', { windowMs: 15 * 60000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Try again later.' } });
const verifyLimit = limiter('identity-verify', { windowMs: 15 * 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again later.' } });
const googleClientIds = () => String(process.env.GOOGLE_CLIENT_IDS || '').split(',').map((id) => id.trim()).filter(Boolean);

router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/config', (req, res) => res.json({
  googleEnabled: googleClientIds().length > 0,
  googleClientId: process.env.GOOGLE_WEB_CLIENT_ID || googleClientIds()[0] || '',
  emailVerificationRequired: verificationRequired(),
  allowedRegistrationDomain: ALLOWED_REGISTRATION_DOMAIN,
  passwordRecoveryMode: process.env.PASSWORD_RECOVERY_MODE === 'admin' ? 'admin' : 'email',
  workspaceCreation: process.env.WORKSPACE_CREATION === 'admin' ? 'admin' : 'members',
}));

router.post('/email-verification/request', requestLimit, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!validEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!isAllowedRegistrationEmail(email)) return res.status(400).json({ error: `Use an @${ALLOWED_REGISTRATION_DOMAIN} email address` });
    if (email !== adminEmail()) await requestEmailVerification(email);
    res.json({ message: 'If this email is eligible, a verification code has been sent.', retryAfter: 60 });
  } catch (error) { next(error); }
});

router.post('/email-verification/verify', verifyLimit, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const proof = validEmail(email) && await verifyEmailCode(email, req.body.code);
    if (!proof) return res.status(400).json({ error: 'Invalid or expired code. Request a new code if needed.' });
    res.json({ emailVerificationToken: proof });
  } catch (error) { next(error); }
});

router.post('/google', verifyLimit, async (req, res, next) => {
  try {
    const audience = googleClientIds();
    if (!audience.length) return res.status(503).json({ error: 'Google sign-in is not configured yet' });
    if (typeof req.body.credential !== 'string' || req.body.credential.length > 16384) return res.status(400).json({ error: 'Google credential required' });
    let payload;
    try {
      const ticket = await google.verifyIdToken({ idToken: req.body.credential, audience });
      payload = ticket.getPayload();
    } catch { return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' }); }
    const email = normalizeEmail(payload?.email);
    if (!payload?.sub || payload.email_verified !== true || !validEmail(email)) return res.status(401).json({ error: 'Google must verify your email address first' });
    if (email === adminEmail()) return res.status(403).json({ error: 'Use the administrator password to sign in to this account' });
    let user = await User.findOne({ googleId: payload.sub }).select('+googleId +refreshSessions');
    if (!user) {
      if (!isAllowedRegistrationEmail(email)) return res.status(403).json({ error: `Use an @${ALLOWED_REGISTRATION_DOMAIN} email address` });
      user = await User.findOne({ email }).select('+googleId +refreshSessions');
      if (user?.googleId && user.googleId !== payload.sub) return res.status(409).json({ error: 'This email is linked to a different Google account' });
      if (user?.accountStatus === 'disabled' || user?.role === 'SUPER_ADMIN') return res.status(403).json({ error: 'This account cannot use Google sign-in' });
      // Always prove mailbox ownership before linking a password account. Google
      // is not authoritative for third-party addresses without a hosted domain.
      const needsProof = Boolean(user) || !(email.endsWith('@gmail.com') || payload.hd);
      if (needsProof && !await consumeEmailProof(email, req.body.emailVerificationToken)) return res.status(409).json({ code: 'EMAIL_VERIFICATION_REQUIRED', email, error: 'Verify your email to securely connect your Google account.' });
      if (!user) user = new User({ email, username: `user_${crypto.randomBytes(10).toString('hex')}`, displayName: String(payload.name || email.split('@')[0]).slice(0, 50), password: crypto.randomBytes(48).toString('base64') });
      user.googleId = payload.sub;
      user.emailVerifiedAt = new Date();
    }
    if (user.accountStatus === 'disabled' || user.role === 'SUPER_ADMIN') return res.status(403).json({ error: 'This account cannot use Google sign-in' });
    user.lastSeen = new Date();
    await user.save();
    const tokens = await createSession(user);
    await ensureDefaultWorkspaceMembership(user._id);
    return sendTokens(req, res, user, tokens);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Account changed during sign-in. Please try again.' });
    next(error);
  }
});

module.exports = router;
