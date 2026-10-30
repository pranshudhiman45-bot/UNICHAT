const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { validAdminToken } = require('../services/adminSecurity');

function bearerToken(req) {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
}

const authenticate = async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const user = await User.findById(decoded.userId).select('+refreshSessions');
    if (!user || user.accountStatus === 'disabled' || !validAdminToken(user, decoded) || (decoded.ver || 0) !== (user.sessionVersion || 0) || (decoded.sid && !user.refreshSessions.some((session) => session.sessionId === decoded.sid))) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = user;
    req.userId = user._id.toString();
    req.sessionId = decoded.sid || null;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const token = bearerToken(req);
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.userId).select('+refreshSessions');
      if (user && user.accountStatus !== 'disabled' && validAdminToken(user, decoded) && (decoded.ver || 0) === (user.sessionVersion || 0) && (!decoded.sid || user.refreshSessions.some((session) => session.sessionId === decoded.sid))) {
        req.user = user;
        req.userId = user._id.toString();
        req.sessionId = decoded.sid || null;
      }
    }
    next();
  } catch {
    next();
  }
};

module.exports = { authenticate, optionalAuth };
