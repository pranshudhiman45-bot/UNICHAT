const express = require('express');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cloudinary = require('cloudinary').v2;
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
const StoredAttachment = require('../models/StoredAttachment');
const Message = require('../models/Message');
const { authenticate } = require('../middleware/auth');
const { getChannelContext, getDMContext, getThreadContext } = require('../middleware/authorization');
const {
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_MB,
  MAX_ATTACHMENTS,
  allowedMimeTypes,
  isConfigured,
  getAttachmentType,
  getResourceType,
  hasValidFileSignature,
  uploadFromPath,
  readHead,
  destroyAsset,
  safeOriginalName,
  localStorageEnabled,
  localAssetPath,
} = require('../services/fileStorage');
const { limiter } = require('../services/redis');
const uploadLimiter = limiter('file-upload', { windowMs: 10 * 60 * 1000, limit: Number(process.env.UPLOAD_LIMIT_PER_10_MIN || 60), keyGenerator: (req) => `u:${req.userId}`, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many uploads. Please wait a few minutes.' } });
const { ACCESS_TTL_SECONDS, verifyAccessSignature, createAccessUrl } = require('../services/attachmentAccess');

// Development-only public profile photos. Message files still require signed access.
router.get('/local/:assetId', async (req, res) => {
  try {
    const assetPath = localAssetPath(req.params.assetId);
    if (!assetPath) return res.sendStatus(404);
    const meta = JSON.parse(await require('node:fs/promises').readFile(assetPath.replace(/\.bin$/, '.json'), 'utf8'));
    if (meta.delivery !== 'upload' || !meta.mimeType.startsWith('image/')) return res.sendStatus(404);
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.type(meta.mimeType).sendFile(assetPath);
  } catch { res.sendStatus(404); }
});

// Uploads are spooled to disk, never held in memory, so concurrent large uploads cannot exhaust RAM.
// Limits: per-file size, file count, total request size, field/part counts, and concurrent uploads.
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'unichat-uploads');
const MAX_REQUEST_BYTES = MAX_FILE_SIZE * MAX_ATTACHMENTS + 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = Math.max(1, Number(process.env.MAX_CONCURRENT_UPLOADS || 8));
let activeUploads = 0;
require('node:fs').mkdirSync(UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')), // never the client's filename
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_ATTACHMENTS, fields: 10, parts: MAX_ATTACHMENTS + 10, fieldSize: 1024 },
  fileFilter: (req, file, cb) => {
    // The declared type is only a first filter; the real check is the file signature after receipt.
    if (!allowedMimeTypes.has(file.mimetype)) return cb(new Error(`File type ${file.mimetype} is not allowed`));
    // When the conversation fields arrive before the file (all current clients), authorize before
    // accepting a single byte. Older clients that send the file first are authorized after parsing.
    if (!req.body?.workspaceId) return cb(null, true);
    resolveContext(req).then((context) => {
      if (context.error) { const error = new Error(context.error); error.statusCode = context.status || 403; return cb(error); }
      req.uploadContext = context;
      return cb(null, true);
    }).catch(() => { const error = new Error('Invalid conversation'); error.statusCode = 400; cb(error); });
  },
});

function guardUpload(req, res, next) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return res.status(413).json({ error: `Upload is too large (limit ${MAX_FILE_SIZE_MB} MB per file, ${MAX_ATTACHMENTS} files)` });
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) { res.set('Retry-After', '5'); return res.status(429).json({ error: 'The server is busy processing other uploads. Try again shortly.' }); }
  activeUploads++;
  let released = false;
  const release = () => { if (released) return; released = true; activeUploads--; };
  // Always remove spooled temp files and release the slot, however the request ends.
  const cleanup = () => { release(); (req.files || []).forEach((file) => { fsp.rm(file.path, { force: true }).catch(() => undefined); }); };
  res.on('close', cleanup);
  next();
}

function runUpload(req, res, next) {
  upload.array('files', MAX_ATTACHMENTS)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `Each file must be ${MAX_FILE_SIZE_MB} MB or smaller` });
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_PART_COUNT') return res.status(400).json({ error: `You can attach up to ${MAX_ATTACHMENTS} files` });
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return res.status(400).json({ error: error.message || 'Invalid file upload' });
  });
}

async function resolveContext(req) {
  const { workspaceId, channelId, dmId, parentMessageId } = req.body;
  let normalizedParentMessageId = parentMessageId || null;
  if (!mongoose.isValidObjectId(workspaceId)) return { status: 400, error: 'workspaceId is required' };
  if ((channelId && dmId) || (!channelId && !dmId)) return { status: 400, error: 'Provide exactly one channelId or dmId' };

  const access = channelId
    ? await getChannelContext(channelId, req.userId, { requireMembership: true })
    : await getDMContext(dmId, req.userId);
  if (access.error) return access;
  if (String(access.workspace._id) !== String(workspaceId)) return { status: 400, error: 'workspaceId does not match conversation' };

  if (parentMessageId) {
    const threadAccess = await getThreadContext(parentMessageId, req.userId);
    if (threadAccess.error) return threadAccess;
    const parent = threadAccess.parent;
    const sameContext = channelId
      ? String(parent.channel) === String(channelId)
      : String(parent.dm) === String(dmId);
    if (!sameContext || String(parent.workspace) !== String(workspaceId)) return { status: 400, error: 'Parent message does not belong to this conversation' };
    normalizedParentMessageId = parent._id.toString();
  }

  return {
    workspace: access.workspace,
    channelId: channelId || null,
    dmId: dmId || null,
    parentMessageId: normalizedParentMessageId,
  };
}

function publicAttachment(record) {
  return {
    uploadId: record._id,
    type: record.type,
    url: record.url,
    publicId: record.publicId,
    name: record.originalName,
    size: record.size,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    format: record.format,
    resourceType: record.resourceType,
    accessMode: record.accessMode,
  };
}

function cloudinaryFolder(context) {
  const root = `unichat/workspace_${context.workspace._id}`;
  if (context.parentMessageId) return `${root}/threads/${context.parentMessageId}`;
  if (context.channelId) return `${root}/channels/${context.channelId}`;
  return `${root}/dms/${context.dmId}`;
}

// POST /api/files/upload - stage one or more files for a message.
router.post('/upload', authenticate, uploadLimiter, guardUpload, runUpload, async (req, res) => {
  const context = req.uploadContext || await resolveContext(req).catch(() => ({ status: 400, error: 'Invalid conversation' }));
  if (context.error) return res.status(context.status || 403).json({ error: context.error });
  if (!req.files?.length) return res.status(400).json({ error: 'No files provided' });
  if (!isConfigured()) return res.status(503).json({ error: 'File storage is not configured' });
  // Never trust the client's MIME type: verify the real file signature of every file before storing any of them.
  for (const file of req.files) {
    const head = await readHead(file.path).catch(() => Buffer.alloc(0));
    if (!hasValidFileSignature(head, file.mimetype)) return res.status(400).json({ error: 'File contents do not match the declared file type' });
  }

  const uploaded = [];
  let storageAttempted = false;
  try {
    for (const file of req.files) {
      const type = getAttachmentType(file.mimetype);
      if (!type) return res.status(400).json({ error: `File type ${file.mimetype} is not allowed` });
      const resourceType = getResourceType(type);
      const originalName = safeOriginalName(file.originalname);
      let result;
      try {
        storageAttempted = true;
        result = await uploadFromPath(file.path, {
          folder: cloudinaryFolder(context),
          resource_type: resourceType,
          use_filename: false,
          unique_filename: true,
          type: 'authenticated',
        });
        const record = await StoredAttachment.create({
          workspace: context.workspace._id,
        channel: context.channelId,
        dm: context.dmId,
        parentMessage: context.parentMessageId,
          uploadedBy: req.userId,
          publicId: result.public_id,
          url: result.secure_url,
          originalName,
          mimeType: file.mimetype,
          type,
          size: result.bytes || file.size,
          width: result.width,
          height: result.height,
          format: result.format,
          resourceType,
          accessMode: 'authenticated',
        });
        uploaded.push(record);
      } catch (error) {
        if (result?.public_id) await destroyAsset(result.public_id, resourceType, 'authenticated').catch(() => undefined);
        throw error;
      }
    }
    return res.status(201).json({ attachments: uploaded.map(publicAttachment), limits: { maxFileSizeMb: MAX_FILE_SIZE_MB, maxAttachments: MAX_ATTACHMENTS } });
  } catch (error) {
    await Promise.allSettled(uploaded.map((record) => destroyAsset(record.publicId, record.resourceType, 'authenticated')));
    if (uploaded.length) await StoredAttachment.updateMany({ _id: { $in: uploaded.map((record) => record._id) } }, { $set: { status: 'deleted' } });
    console.error('Upload error:', error);
    return res.status(storageAttempted ? 503 : 500).json({ error: storageAttempted ? 'File storage is temporarily unavailable' : 'Upload failed' });
  }
});

// Current-membership authorization for one stored attachment. Re-evaluated on every access so
// removed members and deleted messages lose access immediately.
async function canAccessAttachment(record, userId) {
  if (!record || record.accessMode !== 'authenticated' || record.status === 'deleted') return false;
  if (record.status === 'staged') return String(record.uploadedBy) === String(userId);
  const references = await Message.find({ workspace: record.workspace, isDeleted: false, 'attachments.uploadId': record._id }).select('channel dm workspace');
  for (const message of references) {
    const access = message.channel ? await getChannelContext(message.channel, userId, { light: true }) : await getDMContext(message.dm, userId, { light: true });
    if (!access.error && String(access.workspace._id) === String(record.workspace)) return true;
  }
  return false;
}

// POST /api/files/urls - exchange attachment ids for fresh short-lived URLs (authorized per id).
router.post('/urls', authenticate, async (req, res) => {
  const ids = Array.isArray(req.body?.uploadIds) ? [...new Set(req.body.uploadIds.map(String))] : null;
  if (!ids || !ids.length || ids.length > 50 || ids.some((id) => !mongoose.isValidObjectId(id))) return res.status(400).json({ error: 'Provide 1-50 valid uploadIds' });
  const records = await StoredAttachment.find({ _id: { $in: ids } });
  const urls = {};
  for (const record of records) {
    if (await canAccessAttachment(record, req.userId)) urls[String(record._id)] = { url: createAccessUrl(record._id, req.userId, req), expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000 };
  }
  res.json({ urls });
});

// GET /api/files/access/:uploadId - short-lived capability URL, re-authorized against current membership.
router.get('/access/:uploadId', async (req, res) => {
  try {
    const { user: userId, expires, signature } = req.query;
    if (!mongoose.isValidObjectId(req.params.uploadId) || !mongoose.isValidObjectId(userId)
      || !verifyAccessSignature(req.params.uploadId, userId, expires, signature)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const activeUser = await require('../models/User').exists({ _id: userId, accountStatus: 'active' });
    if (!activeUser) return res.status(404).json({ error: 'File not found' });
    const record = await StoredAttachment.findById(req.params.uploadId);
    if (!record || record.accessMode !== 'authenticated' || record.status === 'deleted') {
      return res.status(404).json({ error: 'File not found' });
    }
    if (!await canAccessAttachment(record, userId)) return res.status(404).json({ error: 'File not found' });

    if (localStorageEnabled()) {
      const assetPath = localAssetPath(record.publicId);
      if (!assetPath) return res.sendStatus(404);
      res.set('Cache-Control', 'private, no-store');
      res.set('Cross-Origin-Resource-Policy', 'cross-origin');
      res.type(record.mimeType);
      if (record.type === 'document') res.attachment(record.originalName);
      return res.sendFile(assetPath);
    }
    const expiresAt = Math.min(Number(expires), Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS);
    const url = cloudinary.utils.private_download_url(record.publicId, record.format || undefined, {
      resource_type: record.resourceType,
      type: 'authenticated',
      expires_at: expiresAt,
    });
    res.set('Cache-Control', 'private, no-store');
    return res.redirect(302, url);
  } catch (error) {
    console.error('Attachment access error:', error);
    return res.status(404).json({ error: 'File not found' });
  }
});

// DELETE /api/files/:uploadId - cancel an upload that has not been attached.
router.delete('/:uploadId', authenticate, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.uploadId)) return res.status(404).json({ error: 'Upload not found' });
  const record = await StoredAttachment.findOne({ _id: req.params.uploadId, uploadedBy: req.userId });
  if (!record || record.status === 'deleted') return res.status(404).json({ error: 'Upload not found' });
  if (record.status === 'attached') return res.status(409).json({ error: 'Attached files are removed with their message' });
  try {
    await destroyAsset(record.publicId, record.resourceType, record.accessMode === 'authenticated' ? 'authenticated' : 'upload');
    record.status = 'deleted';
    await record.save();
    return res.json({ success: true });
  } catch (error) {
    console.error('Attachment deletion error:', error);
    return res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;
