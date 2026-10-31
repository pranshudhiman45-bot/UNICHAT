const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const mongoose = require('mongoose');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const { authenticate } = require('../middleware/auth');
const { isConfigured, hasValidFileSignature, uploadBuffer, destroyAsset } = require('../services/fileStorage');
const { emitToTeammates } = require('../services/presence');
const WebPushSubscription = require('../models/WebPushSubscription');
const PushDevice = require('../models/PushDevice');
const pushService = require('../services/pushNotifications');
const { publicKey, validEndpoint } = require('../services/webPush');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)),
});

function receiveAvatar(req, res, next) {
  avatarUpload.single('avatar')(req, res, (error) => {
    if (!error) return next();
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Profile photo must be 5 MB or smaller' : 'Invalid profile photo upload' });
  });
}

function emitProfile(req, user) {
  void emitToTeammates(req.app.get('io'), String(user._id), 'user:profile_updated', {
    userId: String(user._id), displayName: user.displayName, avatar: user.avatar,
    title: user.title, bio: user.bio, timezone: user.timezone, statusMessage: user.statusMessage,
  }).catch(() => undefined);
}

function removeOwnedAvatar(req) {
  const publicId = req.user.avatarPublicId;
  if (typeof publicId !== 'string' || !publicId.startsWith(`unichat/avatars/${req.userId}/`)) return;
  void destroyAsset(publicId, 'image').catch((error) => console.error('Avatar cleanup failed:', error));
}

// GET /api/users/profile/:userId
router.get('/profile/:userId', authenticate, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) return res.status(404).json({ error: 'User not found' });
    // Visible to yourself and to people you share an active workspace with; otherwise indistinguishable from "no such user".
    if (req.params.userId !== req.userId) {
      const shared = await Workspace.exists({ deletedAt: null, isArchived: false, $and: [{ members: { $elemMatch: { user: req.userId } } }, { members: { $elemMatch: { user: req.params.userId } } }] });
      if (!shared) return res.status(404).json({ error: 'User not found' });
    }
    const user = await User.findById(req.params.userId).lean();
    if (!user || user.accountStatus === 'disabled') return res.status(404).json({ error: 'User not found' });
    res.json({ user: { 
      _id: user._id, 
      username: user.username, 
      displayName: user.displayName, 
      avatar: user.avatar, 
      status: user.status, 
      statusMessage: user.statusMessage, 
      bio: user.bio, 
      title: user.title, 
      timezone: user.timezone, 
      lastSeen: user.lastSeen, 
      createdAt: user.createdAt 
    } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /api/users/profile
router.put('/profile', authenticate, [
  body('displayName').optional().isString().trim().isLength({ min: 1, max: 50 }),
  body('bio').optional().isString().trim().isLength({ max: 200 }),
  body('title').optional().isString().trim().isLength({ max: 80 }),
  body('statusMessage').optional().isString().trim().isLength({ max: 100 }),
  body('status').optional().isIn(['online', 'away', 'busy', 'offline']),
  body('timezone').optional().isString().isLength({ min: 1, max: 80 }).custom((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { throw new Error('Invalid timezone'); }
  }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed' });
    const allowed = ['displayName', 'bio', 'title', 'statusMessage', 'timezone', 'status'];
    if (!req.body || Object.keys(req.body).some((key) => !allowed.includes(key))) return res.status(400).json({ error: 'Unsupported profile field' });
    const updates = {};
    allowed.forEach((field) => { if (req.body[field] !== undefined) updates[field] = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field]; });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No profile changes provided' });
    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    emitProfile(req, user);
    if (updates.status !== undefined || updates.statusMessage !== undefined) await emitToTeammates(req.app.get('io'), req.userId, 'user:presence_update', { userId: req.userId, status: user.status, statusMessage: user.statusMessage });
    res.json({ user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Profile photos are public avatars. The server chooses the Cloudinary location.
router.post('/avatar', authenticate, receiveAvatar, async (req, res) => {
  if (!req.file || !hasValidFileSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'Choose a valid JPEG, PNG, WebP or GIF image' });
  if (!isConfigured()) return res.status(503).json({ error: 'Profile photo storage is not configured' });
  let uploaded;
  try {
    uploaded = await uploadBuffer(req.file.buffer, {
      folder: `unichat/avatars/${req.userId}`, resource_type: 'image', type: 'upload',
      use_filename: false, unique_filename: true,
    });
    const user = await User.findByIdAndUpdate(req.userId, { $set: { avatar: uploaded.secure_url, avatarPublicId: uploaded.public_id } }, { new: true });
    if (!user) {
      await destroyAsset(uploaded.public_id, 'image').catch(() => undefined);
      return res.status(404).json({ error: 'User not found' });
    }
    removeOwnedAvatar(req);
    emitProfile(req, user);
    return res.json({ user: user.toPublicJSON() });
  } catch (error) {
    if (uploaded?.public_id) await destroyAsset(uploaded.public_id, 'image').catch(() => undefined);
    console.error('Profile photo upload failed:', error);
    return res.status(503).json({ error: 'Profile photo storage is temporarily unavailable' });
  }
});

router.delete('/avatar', authenticate, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.userId, { $set: { avatar: null, avatarPublicId: null } }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    removeOwnedAvatar(req);
    emitProfile(req, user);
    return res.json({ user: user.toPublicJSON() });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to remove profile photo' });
  }
});

// PUT /api/users/password
router.put('/password', authenticate, [
  body('currentPassword').exists(),
  body('newPassword').custom(require('../services/emailVerification').passwordValid),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: `Use a password with at least ${require('../services/emailVerification').MIN_PASSWORD_LENGTH} characters and at most 72 UTF-8 bytes` });
    const user = await User.findById(req.userId).select('+password');
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.role === 'SUPER_ADMIN') return res.status(403).json({ error: 'Administrator password is managed server-side' });
    const valid = await user.comparePassword(req.body.currentPassword);
    if (!valid) return res.status(400).json({ error: 'Current password incorrect' });
    const password = await require('bcryptjs').hash(req.body.newPassword, 12);
    await User.updateOne({ _id: user._id, password: user.password }, { $set: { password, refreshToken: null, refreshSessions: [] }, $inc: { sessionVersion: 1 } });
    await pushService.revokePushDevices(user._id);
    req.app.get('io')?.in(`user:${user._id}`).disconnectSockets(true);
    res.json({ message: 'Password updated. Sign in again on all devices.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// GET /api/users/search
router.get('/search', authenticate, async (req, res) => {
  try {
    const { q, workspaceId } = req.query;
    if (typeof q !== 'string' || !q.trim() || q.length > 50) return res.status(400).json({ error: 'Query required (max 50 characters)' });
    if (!mongoose.isValidObjectId(workspaceId)) return res.status(404).json({ error: 'Workspace not found' });
    const ws = await Workspace.findById(workspaceId).select('members deletedAt');
    if (!ws || ws.deletedAt) return res.status(404).json({ error: 'Workspace not found' });
    if (!ws.isMember(req.userId)) return res.status(403).json({ error: 'Not a workspace member' });
    const memberIds = ws ? ws.members.map(m => m.user) : [];
    const escapedQuery = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedQuery, 'i');
    const users = await User.find({
      _id: { $in: memberIds },
      $or: [{ displayName: regex }, { username: regex }],
    }).limit(20).select('displayName avatar username status statusMessage title');
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// PUT /api/users/notification-settings
router.put('/notification-settings', authenticate, async (req, res) => {
  try {
    const allowed = [
      'mentions', 'directMessages', 'channelMessages', 'threadReplies', 'reactions', 'calls',
      'securityAlerts', 'desktopNotifications', 'sounds', 'pushEnabled', 'webPushEnabled', 'pushPreview',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) {
        if (typeof req.body[key] !== 'boolean') return res.status(400).json({ error: `${key} must be a boolean` });
        updates[`notificationSettings.${key}`] = req.body[key];
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'At least one valid notification setting is required' });
    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ notificationSettings: user.notificationSettings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

router.get('/web-push/config', authenticate, (req, res) => {
  res.json({ publicKey: publicKey() });
});

router.post('/web-push/subscriptions', authenticate, async (req, res) => {
  try {
    if (!publicKey()) return res.status(503).json({ error: 'Web Push is not configured on the server' });
    const { endpoint, keys, userAgent } = req.body || {};
    if (!validEndpoint(endpoint) || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string'
      || keys.p256dh.length > 512 || keys.auth.length > 256 || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid browser push subscription' });
    }
    const existing = await WebPushSubscription.findOne({ endpoint }).select('user');
    if (existing && String(existing.user) !== String(req.userId)) {
      return res.status(409).json({ error: 'Browser push subscription is already registered to another account' });
    }
    await WebPushSubscription.findOneAndUpdate(
      { endpoint }, { $set: { user: req.userId, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: String(userAgent || req.get('user-agent') || '').slice(0, 512), lastUsedAt: new Date() } },
      { upsert: true, new: true, runValidators: true },
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register browser push subscription' });
  }
});

router.delete('/web-push/subscriptions', authenticate, async (req, res) => {
  try {
    if (!validEndpoint(req.body?.endpoint)) return res.status(400).json({ error: 'Invalid browser push subscription' });
    await WebPushSubscription.deleteOne({ user: req.userId, endpoint: req.body.endpoint });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to remove browser push subscription' });
  }
});

// POST /api/users/push-token - bind a device token to the current user and session.
router.post('/push-token', authenticate, async (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!pushService.isExpoPushToken(token) || token.length > 200) return res.status(400).json({ error: 'Invalid Expo push token' });
    await pushService.registerPushDevice(req.userId, req.sessionId, token, platform);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save push token' });
  }
});

router.delete('/push-token/:token', authenticate, async (req, res) => {
  try {
    const { token } = req.params;
    if (!pushService.isExpoPushToken(token)) return res.status(400).json({ error: 'Invalid Expo push token' });
    await PushDevice.deleteOne({ token, user: req.userId });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to remove push token' });
  }
});

module.exports = router;
