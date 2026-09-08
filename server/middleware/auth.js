const jwt = require('jsonwebtoken');
const { getOne, getAll } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not set in environment. Add it to server/.env');
}

// Verify JWT token
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // Get additional roles from database
        const additionalRoles = getOne(
            "SELECT role FROM user_roles WHERE user_id = ?",
            [decoded.id]
        );
        if (additionalRoles) {
            const roles = getAll(
                "SELECT role FROM user_roles WHERE user_id = ?",
                [decoded.id]
            );
            decoded.additional_roles = roles.map(r => r.role);
        }
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// Require admin role
const requireAdmin = (req, res, next) => {
    const isAdmin = req.user.role === 'admin' || req.user.additional_roles?.includes('admin');
    if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Require manager role
const requireManager = (req, res, next) => {
    const isManager = req.user.role === 'manager' || req.user.role === 'admin' ||
        req.user.additional_roles?.includes('manager') || req.user.additional_roles?.includes('admin');
    if (!isManager) {
        return res.status(403).json({ error: 'Manager access required' });
    }
    next();
};

// Require caller role
const requireCaller = (req, res, next) => {
    const isCaller = req.user.role === 'caller' || req.user.role === 'admin' ||
        req.user.additional_roles?.includes('caller') || req.user.additional_roles?.includes('admin');
    if (!isCaller) {
        return res.status(403).json({ error: 'Caller access required' });
    }
    next();
};

// Generate JWT token
const generateToken = (user) => {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
};

module.exports = { requireAuth, requireAdmin, requireManager, requireCaller, generateToken, JWT_SECRET };
