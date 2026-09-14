const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Authenticate JWT Token middleware
 * Verifies Authorization: Bearer <token> or ?token=
 * Checks if user exists and account status is active
 */
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

        // Support token in query parameter for direct file downloads
        if (!token && req.query && req.query.token) {
            token = req.query.token;
        }

        if (!token) {
            return res.status(401).json({ message: 'Access denied. No token provided.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Fetch user from DB to ensure account is active and permissions are current
        const user = await User.findById(decoded.userId).lean();
        if (!user || user.status === 'inactive') {
            return res.status(403).json({ message: 'Access denied. Account is inactive or user not found.' });
        }

        req.user = user;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Session expired. Please log in again.' });
        }
        return res.status(403).json({ message: 'Invalid or malformed token.' });
    }
};

/**
 * Require Admin role middleware
 */
const requireAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'Admin') {
        return res.status(403).json({ message: 'Access forbidden: Admin privileges required.' });
    }
    next();
};

module.exports = {
    authenticateToken,
    requireAdmin
};
