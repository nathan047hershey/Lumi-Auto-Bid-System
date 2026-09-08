const express = require('express');
const bcrypt = require('bcryptjs');
const { getOne, runQuery, getAll } = require('../config/database');
const { requireAuth, requireManager } = require('../middleware/auth');
const profileAutofillService = require('../services/profileAutofillService');

const router = express.Router();

// Apply requireManager middleware to all routes
router.use(requireAuth, requireManager);

// ==================== USER MANAGEMENT ====================

// GET /api/manager/users - List users created by current manager
router.get('/users', (req, res) => {
    try {
        const users = getAll(
            "SELECT id, username, role, created_at FROM users WHERE created_by = ? ORDER BY username",
            [req.user.id]
        );
        res.json(users);
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/manager/users - Create new user with role
router.post('/users', (req, res) => {
    try {
        const { username, password, role = 'user' } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        // Managers can only create 'user', 'caller', or 'manager' roles
        if (!['user', 'caller', 'manager', 'admin'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const existingUser = getOne('SELECT id FROM users WHERE username = ?', [username]);

        if (existingUser) {
            return res.status(409).json({ error: 'Username already exists' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);

        const result = runQuery(
            'INSERT INTO users (username, password_hash, role, created_by) VALUES (?, ?, ?, ?)',
            [username, passwordHash, role, req.user.id]
        );

        res.status(201).json({
            id: result.lastInsertRowid,
            username,
            role
        });
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/manager/users/:id - Delete user created by current manager
router.delete('/users/:id', (req, res) => {
    try {
        const { id } = req.params;

        // Ensure user was created by this manager
        const existingUser = getOne(
            'SELECT id FROM users WHERE id = ? AND created_by = ?',
            [parseInt(id), req.user.id]
        );

        if (!existingUser) {
            return res.status(404).json({ error: 'User not found or access denied' });
        }

        // Prevent self-delete
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        const result = runQuery('DELETE FROM users WHERE id = ?', [parseInt(id)]);

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== PROFILE MANAGEMENT ====================

// GET /api/manager/profiles - Get all profiles created by current manager
router.get('/profiles', (req, res) => {
    try {
        const profiles = getAll('SELECT * FROM candidate_profiles WHERE created_by = ? ORDER BY created_at DESC', [req.user.id]);
        res.json(profiles);
    } catch (error) {
        console.error('Get profiles error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/manager/profiles/autofill-defaults — copy shared answers to this manager's profiles
router.post('/profiles/autofill-defaults', (req, res) => {
    try {
        const result = profileAutofillService.applySharedAutofillToProfiles({
            answers: req.body || {},
            scope: 'manager',
            managerId: req.user.id
        });
        res.json({
            message: `Shared autofill defaults applied to ${result.updated} profile(s)`,
            updated: result.updated,
            keys: result.keys
        });
    } catch (error) {
        if (error && error.status === 400) return res.status(400).json({ error: error.message });
        console.error('Bulk autofill defaults error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/manager/profiles/:id - Get single profile (only if created by current manager)
router.get('/profiles/:id', (req, res) => {
    try {
        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ? AND created_by = ?', [req.params.id, req.user.id]);

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        res.json(profile);
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/manager/profiles - Create new profile
router.post('/profiles', (req, res) => {
    try {
        const {
            first_name,
            last_name,
            middle_name,
            birthdate,
            phone,
            email,
            linkedin_url,
            github_url,
            address,
            city,
            state,
            country,
            postal_code,
            salary_range,
            work_experience,
            education,
            resume_prompt,
            gender,
            work_authorization,
            requires_sponsorship,
            disability_status,
            veteran_status,
            race_ethnicity,
            website_url,
            portfolio_url,
            preferred_name,
            over_18,
            hispanic_latino,
            willing_to_relocate,
            willing_to_travel,
            earliest_start_date,
            notice_period,
            how_heard,
            years_of_experience,
            education_level,
            school,
            degree,
            discipline,
            security_clearance
        } = req.body;

        if (!first_name || !last_name) {
            return res.status(400).json({ error: 'First name and last name are required' });
        }

        const result = runQuery(
            `INSERT INTO candidate_profiles (
                first_name, last_name, middle_name, birthdate, phone, email,
                linkedin_url, github_url, address, city, state, country,
                postal_code, salary_range, work_experience, education,
                resume_prompt, gender, work_authorization, requires_sponsorship,
                disability_status, veteran_status, race_ethnicity,
                website_url, portfolio_url, preferred_name, over_18, hispanic_latino,
                willing_to_relocate, willing_to_travel, earliest_start_date, notice_period,
                how_heard, years_of_experience, education_level, school, degree, discipline,
                security_clearance, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [first_name, last_name, middle_name, birthdate, phone, email,
             linkedin_url, github_url, address, city, state, country,
             postal_code, salary_range, work_experience, education,
             resume_prompt, gender || null, work_authorization || null,
             requires_sponsorship || null, disability_status || null,
             veteran_status || null, race_ethnicity || null,
             website_url || null, portfolio_url || null, preferred_name || null,
             over_18 || null, hispanic_latino || null, willing_to_relocate || null,
             willing_to_travel || null, earliest_start_date || null, notice_period || null,
             how_heard || null, years_of_experience || null, education_level || null,
             school || null, degree || null, discipline || null,
             security_clearance || null, req.user.id]
        );

        res.status(201).json({
            id: result.lastInsertRowid,
            first_name,
            last_name,
            message: 'Profile created successfully'
        });
    } catch (error) {
        console.error('Create profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/manager/profiles/:id - Update profile (only if created by current manager)
router.put('/profiles/:id', (req, res) => {
    try {
        // Check if profile exists and belongs to current manager
        const existingProfile = getOne('SELECT id FROM candidate_profiles WHERE id = ? AND created_by = ?', [req.params.id, req.user.id]);

        if (!existingProfile) {
            return res.status(404).json({ error: 'Profile not found or access denied' });
        }

        const {
            first_name,
            last_name,
            middle_name,
            birthdate,
            phone,
            email,
            linkedin_url,
            github_url,
            address,
            city,
            state,
            country,
            postal_code,
            salary_range,
            work_experience,
            education,
            resume_prompt,
            gender,
            work_authorization,
            requires_sponsorship,
            disability_status,
            veteran_status,
            race_ethnicity,
            website_url,
            portfolio_url,
            preferred_name,
            over_18,
            hispanic_latino,
            willing_to_relocate,
            willing_to_travel,
            earliest_start_date,
            notice_period,
            how_heard,
            years_of_experience,
            education_level,
            school,
            degree,
            discipline,
            security_clearance
        } = req.body;

        runQuery(
            `UPDATE candidate_profiles SET
                first_name = COALESCE(?, first_name),
                last_name = COALESCE(?, last_name),
                middle_name = COALESCE(?, middle_name),
                birthdate = COALESCE(?, birthdate),
                phone = COALESCE(?, phone),
                email = COALESCE(?, email),
                linkedin_url = COALESCE(?, linkedin_url),
                github_url = COALESCE(?, github_url),
                address = COALESCE(?, address),
                city = COALESCE(?, city),
                state = COALESCE(?, state),
                country = COALESCE(?, country),
                postal_code = COALESCE(?, postal_code),
                salary_range = COALESCE(?, salary_range),
                work_experience = COALESCE(?, work_experience),
                education = COALESCE(?, education),
                resume_prompt = COALESCE(?, resume_prompt),
                gender = COALESCE(?, gender),
                work_authorization = COALESCE(?, work_authorization),
                requires_sponsorship = COALESCE(?, requires_sponsorship),
                disability_status = COALESCE(?, disability_status),
                veteran_status = COALESCE(?, veteran_status),
                race_ethnicity = COALESCE(?, race_ethnicity),
                website_url = COALESCE(?, website_url),
                portfolio_url = COALESCE(?, portfolio_url),
                preferred_name = COALESCE(?, preferred_name),
                over_18 = COALESCE(?, over_18),
                hispanic_latino = COALESCE(?, hispanic_latino),
                willing_to_relocate = COALESCE(?, willing_to_relocate),
                willing_to_travel = COALESCE(?, willing_to_travel),
                earliest_start_date = COALESCE(?, earliest_start_date),
                notice_period = COALESCE(?, notice_period),
                how_heard = COALESCE(?, how_heard),
                years_of_experience = COALESCE(?, years_of_experience),
                education_level = COALESCE(?, education_level),
                school = COALESCE(?, school),
                degree = COALESCE(?, degree),
                discipline = COALESCE(?, discipline),
                security_clearance = COALESCE(?, security_clearance),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND created_by = ?`,
            [first_name, last_name, middle_name, birthdate, phone, email,
             linkedin_url, github_url, address, city, state, country,
             postal_code, salary_range, work_experience, education,
             resume_prompt, gender || null, work_authorization || null,
             requires_sponsorship || null, disability_status || null,
             veteran_status || null, race_ethnicity || null,
             website_url || null, portfolio_url || null, preferred_name || null,
             over_18 || null, hispanic_latino || null, willing_to_relocate || null,
             willing_to_travel || null, earliest_start_date || null, notice_period || null,
             how_heard || null, years_of_experience || null, education_level || null,
             school || null, degree || null, discipline || null,
             security_clearance || null, req.params.id, req.user.id]
        );

        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/manager/profiles/:id - Delete profile (only if created by current manager)
router.delete('/profiles/:id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM candidate_profiles WHERE id = ? AND created_by = ?', [req.params.id, req.user.id]);

        if (result.changes === 0) {
            return res.status(404).json({ error: 'Profile not found or access denied' });
        }

        res.json({ message: 'Profile deleted successfully' });
    } catch (error) {
        console.error('Delete profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;