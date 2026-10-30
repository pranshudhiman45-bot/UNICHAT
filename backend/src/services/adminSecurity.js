const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');

function adminEmail() { return String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(); }
function adminTokenVersion() { return crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD_HASH || '').digest('hex').slice(0, 16); }
function validAdminToken(user, decoded) { return user?.role !== 'SUPER_ADMIN' || (isSuperAdmin(user) && decoded.av === adminTokenVersion()); }
function isSuperAdmin(user) { return Boolean(adminEmail() && user?.role === 'SUPER_ADMIN' && user.email === adminEmail() && user.accountStatus !== 'disabled'); }
function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Super admin access required' });
  return next();
}
async function compareAdminPassword(email, password) {
  const hash = process.env.ADMIN_PASSWORD_HASH || '';
  if (!adminEmail() || String(email).toLowerCase() !== adminEmail() || !/^\$2[aby]\$\d\d\$/.test(hash)) return false;
  return bcrypt.compare(password, hash);
}
async function audit(req, action, targets = {}) {
  try {
    await AuditLog.create({
      actorUserId: targets.actorUserId || req.userId || null,
      action,
      targetUserId: targets.userId || null,
      targetRequestId: targets.requestId || null,
      targetWorkspaceId: targets.workspaceId || null,
      ip: String(req.ip || '').slice(0, 80),
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
      metadata: targets.metadata || {},
    });
  } catch (error) { console.error('Audit logging failed:', error); }
}

module.exports = { adminEmail, adminTokenVersion, validAdminToken, isSuperAdmin, requireSuperAdmin, compareAdminPassword, audit };
