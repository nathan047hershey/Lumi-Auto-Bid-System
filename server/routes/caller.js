const express = require('express');
const path = require('path');
const fs = require('fs');
const { getOne, getAll, runQuery } = require('../config/database');
const { requireAuth, requireCaller } = require('../middleware/auth');

const router = express.Router();
const resumesDir = path.join(__dirname, '../resumes');

// Apply requireCaller middleware to all routes
router.use(requireAuth, requireCaller);

// GET /caller/applications - Get applications assigned to the caller
router.get('/applications', requireAuth, requireCaller, (req, res) => {
    try {
        const callerId = req.user.id;

        const applications = getAll(`
            SELECT
                ja.*,
                cp.first_name,
                cp.last_name,
                cp.middle_name,
                cp.email,
                cp.phone,
                i.id as interview_id,
                i.scheduled_date,
                i.scheduled_time,
                i.timezone,
                i.interview_type,
                i.interviewer_name,
                i.location,
                i.meeting_link,
                i.notes as interview_notes,
                i.status as interview_status
            FROM caller_assignments ca
            JOIN job_applications ja ON ca.application_id = ja.id
            JOIN candidate_profiles cp ON ja.profile_id = cp.id
            LEFT JOIN interviews i ON ja.id = i.application_id
            WHERE ca.caller_id = ?
            ORDER BY 
                CASE 
                    WHEN i.scheduled_date IS NULL THEN 1
                    ELSE 0
                END,
                i.scheduled_date ASC,
                i.scheduled_time ASC,
                ja.created_at DESC
        `, [callerId]);

        res.json(applications);
    } catch (error) {
        console.error('Error fetching caller applications:', error);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// GET /caller/applications/:id - Get specific application details
router.get('/applications/:id', requireAuth, requireCaller, (req, res) => {
    try {
        const { id } = req.params;
        const callerId = req.user.id;

        // Check if application is assigned to this caller
        const assignment = getOne(`
            SELECT * FROM caller_assignments 
            WHERE caller_id = ? AND application_id = ?
        `, [callerId, id]);

        if (!assignment && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Application not assigned to you' });
        }

        const application = getOne(`
            SELECT
                ja.*,
                cp.*,
                i.id as interview_id,
                i.scheduled_date,
                i.scheduled_time,
                i.timezone,
                i.interview_type,
                i.interviewer_name,
                i.location,
                i.meeting_link,
                i.notes as interview_notes,
                i.status as interview_status
            FROM job_applications ja
            JOIN candidate_profiles cp ON ja.profile_id = cp.id
            LEFT JOIN interviews i ON ja.id = i.application_id
            WHERE ja.id = ?
        `, [id]);

        if (!application) {
            return res.status(404).json({ error: 'Application not found' });
        }

        res.json(application);
    } catch (error) {
        console.error('Error fetching application:', error);
        res.status(500).json({ error: 'Failed to fetch application' });
    }
});

// POST /caller/interviews - Create interview schedule
router.post('/interviews', requireAuth, requireCaller, (req, res) => {
    try {
        const {
            application_id,
            scheduled_date,
            scheduled_time,
            interview_type,
            interviewer_name,
            location,
            meeting_link,
            notes
        } = req.body;

        if (!application_id) {
            return res.status(400).json({ error: 'Application ID is required' });
        }

        // Check if application is assigned to this caller
        const assignment = getOne(`
            SELECT * FROM caller_assignments 
            WHERE caller_id = ? AND application_id = ?
        `, [req.user.id, application_id]);

        if (!assignment && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Application not assigned to you' });
        }

        const result = runQuery(`
            INSERT INTO interviews (
                application_id, scheduled_date, scheduled_time, interview_type,
                interviewer_name, location, meeting_link, notes, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
        `, [application_id, scheduled_date, scheduled_time, interview_type, 
            interviewer_name, location, meeting_link, notes]);

        res.json({
            message: 'Interview scheduled successfully',
            id: result.lastInsertRowid
        });
    } catch (error) {
        console.error('Error creating interview:', error);
        res.status(500).json({ error: 'Failed to create interview' });
    }
});

// PUT /caller/interviews/:id - Update interview schedule
router.put('/interviews/:id', requireAuth, requireCaller, (req, res) => {
    try {
        const { id } = req.params;
        const {
            scheduled_date,
            scheduled_time,
            interview_type,
            interviewer_name,
            location,
            meeting_link,
            notes,
            status
        } = req.body;

        // Check if interview exists and is assigned to this caller
        const interview = getOne(`
            SELECT i.*, ca.caller_id
            FROM interviews i
            JOIN caller_assignments ca ON i.application_id = ca.application_id
            WHERE i.id = ? AND ca.caller_id = ?
        `, [id, req.user.id]);

        if (!interview && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Interview not found or not assigned to you' });
        }

        runQuery(`
            UPDATE interviews
            SET scheduled_date = ?, scheduled_time = ?, interview_type = ?,
                interviewer_name = ?, location = ?, meeting_link = ?,
                notes = ?, status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [scheduled_date, scheduled_time, interview_type, interviewer_name,
            location, meeting_link, notes, status || 'scheduled', id]);

        res.json({ message: 'Interview updated successfully' });
    } catch (error) {
        console.error('Error updating interview:', error);
        res.status(500).json({ error: 'Failed to update interview' });
    }
});

// DELETE /caller/interviews/:id - Delete interview
router.delete('/interviews/:id', requireAuth, requireCaller, (req, res) => {
    try {
        const { id } = req.params;

        // Check if interview exists and is assigned to this caller
        const interview = getOne(`
            SELECT i.*, ca.caller_id
            FROM interviews i
            JOIN caller_assignments ca ON i.application_id = ca.application_id
            WHERE i.id = ? AND ca.caller_id = ?
        `, [id, req.user.id]);

        if (!interview && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Interview not found or not assigned to you' });
        }

        runQuery('DELETE FROM interviews WHERE id = ?', [id]);

        res.json({ message: 'Interview deleted successfully' });
    } catch (error) {
        console.error('Error deleting interview:', error);
        res.status(500).json({ error: 'Failed to delete interview' });
    }
});

// GET /caller/resumes/:filename - Download resume
router.get('/resumes/:filename', requireAuth, requireCaller, (req, res) => {
    try {
        const { filename } = req.params;
        const filepath = path.join(resumesDir, filename);

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ error: 'Resume not found' });
        }

        res.download(filepath, filename);
    } catch (error) {
        console.error('Download resume error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================
// Caller-entered profile info
// =============================================================
// One row per caller. All free-form text per product spec:
//   profile_info           – short bio / blurb
//   years_of_experience    – YOE (e.g. "5", "5+", "3-4")
//   main_tech_stack        – comma-separated or narrative
//   availability           – general availability
//   availability_this_week – current week's availability
//   location               – text location (e.g. "Austin, TX (remote)")
//   email                  – contact email (free-form)
//   whatsapp               – WhatsApp number / handle
//   telegram               – Telegram handle / id
//   resume_filename        – basename inside server/resumes/ (set by
//                            the upload route below)

// GET /caller/profile - Read the caller's saved profile inputs.
router.get('/profile', requireAuth, requireCaller, (req, res) => {
    try {
        const row = getOne(
            `SELECT * FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );
        res.json(row || {
            caller_id: req.user.id,
            profile_info: '',
            years_of_experience: '',
            main_tech_stack: '',
            availability: '',
            availability_this_week: '',
            location: '',
            email: '',
            whatsapp: '',
            telegram: '',
            resume_filename: null
        });
    } catch (error) {
        console.error('Get caller profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /caller/profile - Create or replace the caller's profile.
// All fields are optional free-form text. Whitespace is trimmed, then
// the row is upserted so the caller always has exactly one record.
router.post('/profile', requireAuth, requireCaller, (req, res) => {
    try {
        const ALLOWED = [
            'profile_info',
            'years_of_experience',
            'main_tech_stack',
            'availability',
            'availability_this_week',
            'location',
            'email',
            'whatsapp',
            'telegram'
        ];

        const incoming = req.body || {};
        // Build a clean payload so we never write unknown columns and
        // we always pass the same shape to the upsert.
        const clean = {};
        for (const k of ALLOWED) {
            if (k in incoming) {
                const v = incoming[k];
                clean[k] = v === null || v === undefined ? null : String(v).trim();
            }
        }

        const existing = getOne(
            `SELECT id, resume_filename FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );

        // Preserve any existing resume_filename if the client didn't
        // explicitly clear it via /caller/profile/resume (DELETE).
        const preservedResume = existing?.resume_filename ?? null;

        if (existing) {
            runQuery(
                `UPDATE caller_profile_inputs
                 SET profile_info = ?,
                     years_of_experience = ?,
                     main_tech_stack = ?,
                     availability = ?,
                     availability_this_week = ?,
                     location = ?,
                     email = ?,
                     whatsapp = ?,
                     telegram = ?,
                     resume_filename = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE caller_id = ?`,
                [
                    clean.profile_info ?? null,
                    clean.years_of_experience ?? null,
                    clean.main_tech_stack ?? null,
                    clean.availability ?? null,
                    clean.availability_this_week ?? null,
                    clean.location ?? null,
                    clean.email ?? null,
                    clean.whatsapp ?? null,
                    clean.telegram ?? null,
                    preservedResume,
                    req.user.id
                ]
            );
        } else {
            runQuery(
                `INSERT INTO caller_profile_inputs
                    (caller_id, profile_info, years_of_experience, main_tech_stack,
                     availability, availability_this_week, location,
                     email, whatsapp, telegram, resume_filename)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    req.user.id,
                    clean.profile_info ?? null,
                    clean.years_of_experience ?? null,
                    clean.main_tech_stack ?? null,
                    clean.availability ?? null,
                    clean.availability_this_week ?? null,
                    clean.location ?? null,
                    clean.email ?? null,
                    clean.whatsapp ?? null,
                    clean.telegram ?? null,
                    preservedResume
                ]
            );
        }

        const row = getOne(
            `SELECT * FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );
        res.status(existing ? 200 : 201).json(row);
    } catch (error) {
        console.error('Save caller profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================
// Caller profile resume (upload / download / delete)
// =============================================================
// Resume is stored on disk under server/resumes/ with a `caller_<id>_`
// prefix so it can never collide with a candidate's resume file. The
// server keeps the caller's previous file (overwritten on re-upload).
//
// Request body for upload is JSON: { filename: "my-resume.pdf",
// data_base64: "JVBERi0xLjQKJ..." } — no multipart dependency needed.

const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_RESUME_EXT = new Set(['.pdf', '.doc', '.docx', '.rtf', '.txt', '.md']);

function sanitizeResumeBasename(name) {
    if (typeof name !== 'string') return '';
    // Strip any directory components and any characters that could be
    // exploited for path traversal.
    const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
    return base.length > 200 ? base.slice(0, 200) : base;
}

function ensureCallerResumeRow(callerId) {
    const existing = getOne(
        `SELECT id FROM caller_profile_inputs WHERE caller_id = ?`,
        [callerId]
    );
    if (!existing) {
        runQuery(
            `INSERT INTO caller_profile_inputs (caller_id) VALUES (?)`,
            [callerId]
        );
    }
}

// POST /caller/profile/resume - Upload (or replace) the caller's resume.
router.post('/profile/resume', requireAuth, requireCaller, (req, res) => {
    try {
        const { filename, data_base64 } = req.body || {};
        if (!filename || !data_base64) {
            return res.status(400).json({ error: 'filename and data_base64 are required' });
        }

        const safeBase = sanitizeResumeBasename(filename);
        if (!safeBase) {
            return res.status(400).json({ error: 'invalid filename' });
        }
        const ext = (path.extname(safeBase) || '').toLowerCase();
        if (!ALLOWED_RESUME_EXT.has(ext)) {
            return res.status(400).json({
                error: `file type not allowed (${ext || 'no extension'}). Use one of: ${[...ALLOWED_RESUME_EXT].join(', ')}`
            });
        }

        // Strip the data-URL prefix if present ("data:application/pdf;base64,XXX").
        const cleaned = String(data_base64).replace(/^data:[^;]+;base64,/, '');
        let buffer;
        try {
            buffer = Buffer.from(cleaned, 'base64');
        } catch (e) {
            return res.status(400).json({ error: 'data_base64 is not valid base64' });
        }
        if (!buffer.length) {
            return res.status(400).json({ error: 'decoded file is empty' });
        }
        if (buffer.length > MAX_RESUME_BYTES) {
            return res.status(413).json({ error: `file too large (max ${MAX_RESUME_BYTES} bytes)` });
        }

        // Final on-disk filename is namespaced by the caller id so it
        // never collides with anything else.
        const onDisk = `caller_${req.user.id}_${Date.now()}_${safeBase}`;
        const fullPath = path.join(resumesDir, onDisk);

        // Make sure the resumes dir exists.
        if (!fs.existsSync(resumesDir)) {
            fs.mkdirSync(resumesDir, { recursive: true });
        }

        // Remove the caller's previous file (if any) before writing the
        // new one, to keep the resumes dir tidy.
        const prior = getOne(
            `SELECT resume_filename FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );
        if (prior?.resume_filename) {
            const priorPath = path.join(resumesDir, prior.resume_filename);
            if (fs.existsSync(priorPath) && prior.resume_filename !== onDisk) {
                try { fs.unlinkSync(priorPath); } catch (_) { /* non-fatal */ }
            }
        }

        fs.writeFileSync(fullPath, buffer);

        ensureCallerResumeRow(req.user.id);
        runQuery(
            `UPDATE caller_profile_inputs
             SET resume_filename = ?, updated_at = CURRENT_TIMESTAMP
             WHERE caller_id = ?`,
            [onDisk, req.user.id]
        );

        const row = getOne(
            `SELECT * FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );
        res.status(201).json(row);
    } catch (error) {
        console.error('Upload caller resume error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /caller/profile/resume - Download the caller's resume.
router.get('/profile/resume', requireAuth, requireCaller, (req, res) => {
    try {
        const row = getOne(
            `SELECT resume_filename FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );
        if (!row?.resume_filename) {
            return res.status(404).json({ error: 'No resume on file' });
        }
        const fullPath = path.join(resumesDir, row.resume_filename);
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'Resume file not found on disk' });
        }
        // Use the basename as the user-visible download name.
        res.download(fullPath, path.basename(row.resume_filename));
    } catch (error) {
        console.error('Download caller resume error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /caller/profile/resume - Remove the caller's resume.
router.delete('/profile/resume', requireAuth, requireCaller, (req, res) => {
    try {
        const row = getOne(
            `SELECT resume_filename FROM caller_profile_inputs WHERE caller_id = ?`,
            [req.user.id]
        );
        if (!row?.resume_filename) {
            return res.json({ deleted: false, reason: 'no resume on file' });
        }
        const fullPath = path.join(resumesDir, row.resume_filename);
        if (fs.existsSync(fullPath)) {
            try { fs.unlinkSync(fullPath); } catch (_) { /* non-fatal */ }
        }
        runQuery(
            `UPDATE caller_profile_inputs
             SET resume_filename = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE caller_id = ?`,
            [req.user.id]
        );
        res.json({ deleted: true });
    } catch (error) {
        console.error('Delete caller resume error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;

