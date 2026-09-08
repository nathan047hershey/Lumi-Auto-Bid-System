const express = require('express');
const bcrypt = require('bcryptjs');
const { getOne, runQuery } = require('../config/database');
const { generateToken, requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const user = getOne('SELECT * FROM users WHERE username = ?', [username]);

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const validPassword = bcrypt.compareSync(password, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user);

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/register (Admin only)
router.post('/register', requireAuth, requireAdmin, (req, res) => {
    try {
        const { username, password, role = 'user' } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        if (!['admin', 'user', 'caller', 'manager', 'developer'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const existingUser = getOne('SELECT id FROM users WHERE username = ?', [username]);

        if (existingUser) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);

        const result = runQuery('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, passwordHash, role]);

        res.status(201).json({
            id: result.lastInsertRowid,
            username,
            role
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/auth/me - Get current user info
router.get('/me', requireAuth, (req, res) => {
    res.json({
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
        additional_roles: req.user.additional_roles || []
    });
});

// POST /api/auth/change-password - Change user password
router.post('/change-password', requireAuth, (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters long' });
        }

        // Get current user from database
        const user = getOne('SELECT * FROM users WHERE id = ?', [req.user.id]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Verify current password
        const validPassword = bcrypt.compareSync(currentPassword, user.password_hash);

        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const newPasswordHash = bcrypt.hashSync(newPassword, 10);

        // Update password
        runQuery('UPDATE users SET password_hash = ? WHERE id = ?', [newPasswordHash, req.user.id]);

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/reset-password - Reset user password (admin only or self-service)
router.post('/reset-password', (req, res) => {
    try {
        const { username, newPassword } = req.body;

        if (!username || !newPassword) {
            return res.status(400).json({ error: 'Username and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters long' });
        }

        // Get user from database
        const user = getOne('SELECT * FROM users WHERE username = ?', [username]);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Hash new password
        const newPasswordHash = bcrypt.hashSync(newPassword, 10);

        // Update password
        runQuery('UPDATE users SET password_hash = ? WHERE id = ?', [newPasswordHash, user.id]);

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
