const cloudinary = require('cloudinary').v2;
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const localStorageEnabled = () => process.env.FILE_STORAGE === 'local' && process.env.NODE_ENV !== 'production';
const storageDirectory = () => path.resolve(process.env.LOCAL_UPLOAD_DIR || '../.local/uploads');
function localAssetPath(publicId) {
  const id = String(publicId).split('/').pop();
  if (!localStorageEnabled() || !/^[a-f0-9]{32}$/.test(id)) return null;
  return path.join(storageDirectory(), `${id}.bin`);
}

const MAX_FILE_SIZE_MB = Math.max(1, Number(process.env.MAX_FILE_SIZE_MB || 25));
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_ATTACHMENTS = Math.max(1, Number(process.env.MAX_ATTACHMENTS || 10));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const allowedMimeTypes = new Map([
  ['image/jpeg', 'image'],
  ['image/png', 'image'],
  ['image/gif', 'image'],
  ['image/webp', 'image'],
  ['video/mp4', 'video'],
  ['video/webm', 'video'],
  ['video/quicktime', 'video'],
  ['application/pdf', 'document'],
  ['application/msword', 'document'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document'],
  ['application/vnd.ms-excel', 'document'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document'],
  ['application/vnd.ms-powerpoint', 'document'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document'],
]);

function isConfigured() {
  return localStorageEnabled() || Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function getAttachmentType(mimeType) {
  return allowedMimeTypes.get(mimeType) || null;
}

function getResourceType(type) {
  if (type === 'image') return 'image';
  if (type === 'video') return 'video';
  return 'raw';
}

function hasValidFileSignature(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/gif') return buffer.subarray(0, 4).toString('ascii') === 'GIF8';
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'video/webm') return buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'application/msword' || mimeType === 'application/vnd.ms-excel' || mimeType === 'application/vnd.ms-powerpoint') {
    return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  }
  if (mimeType.includes('openxmlformats-officedocument')) return buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  return false;
}

async function uploadBuffer(buffer, options) {
  if (localStorageEnabled()) {
    const id = crypto.randomBytes(16).toString('hex');
    await fs.mkdir(storageDirectory(), { recursive: true, mode: 0o700 });
    const mimeType = [...allowedMimeTypes.keys()].find((type) => hasValidFileSignature(buffer, type)) || 'application/octet-stream';
    await fs.writeFile(path.join(storageDirectory(), `${id}.bin`), buffer, { mode: 0o600 });
    await fs.writeFile(path.join(storageDirectory(), `${id}.json`), JSON.stringify({ mimeType, delivery: options.type }), { mode: 0o600 });
    return { public_id: `${options.folder}/${id}`, secure_url: `${process.env.PUBLIC_API_URL || 'http://localhost:4000/api'}/files/local/${id}`, bytes: buffer.length };
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// Streams a file already on disk to storage. Memory use is bounded by the stream buffer, not the file size.
async function uploadFromPath(filePath, options) {
  if (localStorageEnabled()) {
    const id = crypto.randomBytes(16).toString('hex');
    await fs.mkdir(storageDirectory(), { recursive: true, mode: 0o700 });
    const handle = await fs.open(filePath, 'r');
    const head = Buffer.alloc(16);
    try { await handle.read(head, 0, 16, 0); } finally { await handle.close(); }
    const mimeType = [...allowedMimeTypes.keys()].find((type) => hasValidFileSignature(head, type)) || 'application/octet-stream';
    await fs.copyFile(filePath, path.join(storageDirectory(), `${id}.bin`));
    await fs.chmod(path.join(storageDirectory(), `${id}.bin`), 0o600);
    await fs.writeFile(path.join(storageDirectory(), `${id}.json`), JSON.stringify({ mimeType, delivery: options.type }), { mode: 0o600 });
    const { size } = await fs.stat(filePath);
    return { public_id: `${options.folder}/${id}`, secure_url: `${process.env.PUBLIC_API_URL || 'http://localhost:4000/api'}/files/local/${id}`, bytes: size };
  }
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ timeout: 120000, ...options }, (error, result) => (error ? reject(error) : resolve(result)));
    require('node:fs').createReadStream(filePath).on('error', reject).pipe(stream);
  });
}

// Reads just enough of a file to verify its signature.
async function readHead(filePath, length = 16) {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function destroyAsset(publicId, resourceType, deliveryType = 'upload') {
  if (localStorageEnabled()) {
    const assetPath = localAssetPath(publicId);
    if (assetPath) await Promise.all([fs.rm(assetPath, { force: true }), fs.rm(assetPath.replace(/\.bin$/, '.json'), { force: true })]);
    return;
  }
  if (!isConfigured() || !publicId) return;
  await cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType || 'raw',
    type: deliveryType,
    invalidate: true,
  });
}

function safeOriginalName(value) {
  return String(value || 'file').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().slice(0, 255) || 'file';
}

module.exports = {
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_MB,
  MAX_ATTACHMENTS,
  allowedMimeTypes,
  isConfigured,
  getAttachmentType,
  getResourceType,
  hasValidFileSignature,
  uploadBuffer,
  uploadFromPath,
  readHead,
  destroyAsset,
  safeOriginalName,
  localStorageEnabled,
  localAssetPath,
};
