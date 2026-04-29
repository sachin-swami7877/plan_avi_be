const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-otp -otpExpiry +activeToken');

      if (!req.user) {
        return res.status(401).json({ message: 'User not found' });
      }

      // Single-device check: reject if token doesn't match the active one
      if (req.user.activeToken && req.user.activeToken !== token) {
        return res.status(401).json({ message: 'Session expired. You logged in from another device.', forceLogout: true });
      }

      // Strip activeToken from the user object so it's not exposed
      req.user.activeToken = undefined;

      // Block requests from blocked/inactive users — force logout on frontend
      if (req.user.status === 'blocked') {
        return res.status(403).json({ message: 'Your account has been blocked', blocked: true });
      }

      next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

const adminOnly = async (req, res, next) => {
  if (req.user && (req.user.role === 'superadmin' || req.user.role === 'admin' || req.user.role === 'manager' || req.user.isAdmin || req.user.isSubAdmin)) {
    next();
  } else {
    return res.status(403).json({ message: 'Not authorized as admin' });
  }
};

const fullAdminOnly = async (req, res, next) => {
  if (req.user && (req.user.role === 'superadmin' || req.user.role === 'admin' || req.user.isAdmin)) {
    next();
  } else {
    return res.status(403).json({ message: 'Not authorized as full admin' });
  }
};

const superAdminOnly = async (req, res, next) => {
  if (req.user && (req.user.role === 'superadmin' || req.user.isSuperAdmin)) {
    next();
  } else {
    return res.status(403).json({ message: 'Not authorized as super admin' });
  }
};

module.exports = { protect, adminOnly, fullAdminOnly, superAdminOnly };
