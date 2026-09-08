const express = require('express');
const path = require('path');
const fs = require('fs');
const { getAll, getOne, runQuery, txRunQuery, getDb, saveDatabase, reloadDatabaseFromDisk, LOCATION_FLAGS, detectLocationFlag } = require('../config/database');
const jobMatchService = require('../services/jobMatchService');
const profileAutofillService = require('../services/profileAutofillService');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { localPickerToUTCIso } = require('../utils/time');
const { buildStatsResponse } = require('../services/statsService');
const settingsService = require('../services/settingsService');
const { getLatestMilestonesForApplications, MILESTONE_KINDS, MILESTONE_KIND_LABELS, labelForKind, listMilestonesForRequest, listMilestonesForApplication, getOrCreateRequestForApplication, addMilestone: svcAddMilestone, completeMilestone: svcCompleteMilestone, uncompleteMilestone: svcUncompleteMilestone, deleteMilestone: svcDeleteMilestone, approveMilestone: svcApproveMilestone, unapproveMilestone: svcUnapproveMilestone, payMilestone: svcPayMilestone, unpayMilestone: svcUnpayMilestone, assignDeveloper, setApplicationFlags, summariseMilestones, getUserRoles } = require('../services/milestoneService');
const templateRenderer = require('../services/templateRenderer');
const mammoth = require('mammoth');
const router = express.Router();
const { RESUMES_DIR: resumesDir } = require('../config/paths');
const PROFILE_TECHSTACKS = Object.freeze(['python', 'java', 'dotnet', 'golang', 'nodejs', 'frontend']);
const PROFILE_TECHSTACK_LABELS = Object.freeze({ python: 'Python', java: 'Java', dotnet: 'C# / .NET', golang: 'Golang', nodejs: 'Node.js', frontend: 'Frontend' });
function normalizeTechstacks(input) { let raw; if (Array.isArray(input)) raw = input; else if (typeof input === 'string') raw = input.split(',').map((s) => s.trim()).filter(Boolean); else if (input == null) return []; else throw Object.assign(new Error('techstacks must be an array of strings'), { status: 400, code: 'invalid_techstacks' }); const out = []; const seen = new Set(); for (const v of raw) { if (typeof v !== 'string') throw Object.assign(new Error('techstacks must be an array of strings'), { status: 400, code: 'invalid_techstacks' }); const slug = v.trim().toLowerCase(); if (!slug) continue; if (!PROFILE_TECHSTACKS.includes(slug)) throw Object.assign(new Error(`techstack '${slug}' is not one of: ${PROFILE_TECHSTACKS.join(', ')}`), { status: 400, code: 'invalid_techstack_value' }); if (seen.has(slug)) continue; seen.add(slug); out.push(slug); } return out; }
function decorateProfileWithTechstacks(profile) { if (!profile) return profile; const rows = getAll('SELECT techstack FROM profile_techstacks WHERE profile_id = ?', [profile.id]); profile.techstacks = rows.map((r) => r.techstack); return profile; }
function decorateProfileWithTemplate(profile) { if (!profile) return profile; if (profile.preferred_template_kind == null) profile.preferred_template_kind = 'admin'; const tid = profile.preferred_template_id; if (tid == null) { profile.preferred_template_name = null; profile.preferred_template_is_default = null; profile.preferred_template_owner = null; return profile; } if (profile.preferred_template_kind === 'user') { const row = getOne(`SELECT t.name, t.is_default, u.username AS owner_username FROM user_resume_templates t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`, [tid]); if (row) { profile.preferred_template_name = row.name; profile.preferred_template_is_default = !!row.is_default; profile.preferred_template_owner = row.owner_username || null; } else { profile.preferred_template_name = `(template #${tid} not found)`; profile.preferred_template_is_default = null; profile.preferred_template_owner = null; } } else { const row = getOne('SELECT name, is_default FROM resume_templates WHERE id = ?', [tid]); profile.preferred_template_name = row ? row.name : `(template #${tid} not found)`; profile.preferred_template_is_default = row ? !!row.is_default : null; profile.preferred_template_owner = null; } return profile; }
function replaceProfileTechstacks(profileId, techstacks) { txRunQuery('DELETE FROM profile_techstacks WHERE profile_id = ?', [profileId]); for (const t of techstacks) txRunQuery('INSERT INTO profile_techstacks (profile_id, techstack) VALUES (?, ?)', [profileId, t]); }
function normalizeTemplateId(inputId, inputKind) { if (inputId === undefined || inputId === null) return { id: null, kind: 'admin' }; if (typeof inputId === 'string' && inputId.trim() === '') return { id: null, kind: 'admin' }; const n = typeof inputId === 'number' ? inputId : parseInt(inputId, 10); if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) throw Object.assign(new Error('preferred_template_id must be a positive integer or null'), { status: 400, code: 'invalid_template_id' }); const kind = (inputKind === 'user' || inputKind === 'admin') ? inputKind : 'admin'; const table = kind === 'user' ? 'user_resume_templates' : 'resume_templates'; const exists = getOne(`SELECT 1 FROM ${table} WHERE id = ?`, [n]); if (!exists) throw Object.assign(new Error(`preferred_template_id ${n} does not match any ${kind} template`), { status: 400, code: 'unknown_template_id' }); return { id: n, kind }; }
function normalizeLocationFlag(input) { if (input === undefined || input === null) return 'US'; if (typeof input === 'string' && input.trim() === '') return 'US'; const v = typeof input === 'string' ? input.trim() : String(input); if (!LOCATION_FLAGS.includes(v)) throw Object.assign(new Error(`location_flag must be one of ${LOCATION_FLAGS.join(', ')}`), { status: 400, code: 'invalid_location_flag' }); return v; }
router.use(requireAuth, requireAdmin);

// GET /api/admin/users
router.get('/users', (req, res) => { try { const users = getAll("SELECT id, username, role, created_at FROM users ORDER BY username"); const allRoles = getAll("SELECT user_id, role FROM user_roles"); const usersWithRoles = users.map(user => { const userAdditionalRoles = allRoles.filter(r => r.user_id === user.id).map(r => r.role); return { ...user, additional_roles: userAdditionalRoles }; }); res.json(usersWithRoles); } catch (error) { console.error('Get users error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/users/:id/roles', (req, res) => { try { const { id } = req.params; const { role } = req.body; if (!role) return res.status(400).json({ error: 'Role is required' }); if (!['admin', 'user', 'caller', 'manager', 'developer'].includes(role)) return res.status(400).json({ error: 'Invalid role' }); const user = getOne('SELECT id FROM users WHERE id = ?', [parseInt(id)]); if (!user) return res.status(404).json({ error: 'User not found' }); const existingRole = getOne('SELECT id FROM user_roles WHERE user_id = ? AND role = ?', [parseInt(id), role]); if (existingRole) return res.status(409).json({ error: 'Role already assigned' }); runQuery('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', [parseInt(id), role]); res.json({ message: 'Role assigned successfully' }); } catch (error) { console.error('Assign role error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.delete('/users/:id/roles/:role', (req, res) => { try { const { id, role } = req.params; if (parseInt(id) === req.user.id && role === 'admin') return res.status(400).json({ error: 'Cannot remove your own admin role' }); const result = runQuery('DELETE FROM user_roles WHERE user_id = ? AND role = ?', [parseInt(id), role]); if (result.changes === 0) return res.status(404).json({ error: 'Role not found' }); res.json({ message: 'Role removed successfully' }); } catch (error) { console.error('Remove role error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.delete('/users/:id', (req, res) => { try { const { id } = req.params; if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' }); const result = runQuery('DELETE FROM users WHERE id = ?', [parseInt(id)]); if (result.changes === 0) return res.status(404).json({ error: 'User not found' }); res.json({ message: 'User deleted successfully' }); } catch (error) { console.error('Delete user error:', error); res.status(500).json({ error: 'Internal server error' }); } });
// GET /api/admin/profiles
router.get('/profiles', (req, res) => { try { const profiles = getAll('SELECT * FROM candidate_profiles ORDER BY created_at DESC'); const allTechstacks = getAll('SELECT profile_id, techstack FROM profile_techstacks'); const byId = new Map(); for (const t of allTechstacks) { if (!byId.has(t.profile_id)) byId.set(t.profile_id, []); byId.get(t.profile_id).push(t.techstack); } for (const p of profiles) { p.techstacks = byId.get(p.id) || []; decorateProfileWithTemplate(p); } res.json(profiles); } catch (error) { console.error('Get profiles error:', error); res.status(500).json({ error: 'Internal server error' }); } });
// POST /api/admin/profiles/autofill-defaults — copy shared answers to ALL profiles
router.post('/profiles/autofill-defaults', (req, res) => {
    try {
        const result = profileAutofillService.applySharedAutofillToProfiles({
            answers: req.body || {},
            scope: 'admin'
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
router.get('/profiles/:id', (req, res) => { try { const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [parseInt(req.params.id)]); if (!profile) return res.status(404).json({ error: 'Profile not found' }); decorateProfileWithTechstacks(profile); decorateProfileWithTemplate(profile); res.json(profile); } catch (error) { console.error('Get profile error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/profiles', (req, res) => { let techstacks = [], preferredTemplate = { id: null, kind: 'admin' }, locationFlag = 'US'; try { const { first_name, last_name, middle_name, birthdate, phone, email, linkedin_url, github_url, address, city, state, country, postal_code, salary_range, work_experience, education, resume_prompt, gender, work_authorization, requires_sponsorship, disability_status, veteran_status, race_ethnicity, website_url, portfolio_url, preferred_name, over_18, hispanic_latino, willing_to_relocate, willing_to_travel, earliest_start_date, notice_period, how_heard, years_of_experience, education_level, school, degree, discipline, security_clearance } = req.body; if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' }); techstacks = normalizeTechstacks(req.body?.techstacks); preferredTemplate = normalizeTemplateId(req.body?.preferred_template_id, req.body?.preferred_template_kind); locationFlag = normalizeLocationFlag(req.body?.location_flag); let result; const db = getDb(); db.run('BEGIN'); try { result = txRunQuery(`INSERT INTO candidate_profiles (first_name, last_name, middle_name, birthdate, phone, email, linkedin_url, github_url, address, city, state, country, postal_code, salary_range, work_experience, education, resume_prompt, gender, work_authorization, requires_sponsorship, disability_status, veteran_status, race_ethnicity, website_url, portfolio_url, preferred_name, over_18, hispanic_latino, willing_to_relocate, willing_to_travel, earliest_start_date, notice_period, how_heard, years_of_experience, education_level, school, degree, discipline, security_clearance, preferred_template_id, preferred_template_kind, location_flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [first_name, last_name, middle_name || null, birthdate || null, phone || null, email || null, linkedin_url || null, github_url || null, address || null, city || null, state || null, country || null, postal_code || null, salary_range || null, work_experience || null, education || null, resume_prompt || null, gender || null, work_authorization || null, requires_sponsorship || null, disability_status || null, veteran_status || null, race_ethnicity || null, website_url || null, portfolio_url || null, preferred_name || null, over_18 || null, hispanic_latino || null, willing_to_relocate || null, willing_to_travel || null, earliest_start_date || null, notice_period || null, how_heard || null, years_of_experience || null, education_level || null, school || null, degree || null, discipline || null, security_clearance || null, preferredTemplate.id, preferredTemplate.kind, locationFlag]); replaceProfileTechstacks(result.lastInsertRowid, techstacks); db.run('COMMIT'); saveDatabase(); } catch (txErr) { db.run('ROLLBACK'); throw txErr; } const newProfile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [result.lastInsertRowid]); decorateProfileWithTechstacks(newProfile); decorateProfileWithTemplate(newProfile); res.status(201).json(newProfile); } catch (error) { if (error && error.status === 400) return res.status(400).json({ error: error.message }); console.error('Create profile error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); } });
router.put('/profiles/:id', (req, res) => { let techstacks = [], preferredTemplate = { id: null, kind: 'admin' }, locationFlag = 'US'; try { const { id } = req.params; const { first_name, last_name, middle_name, birthdate, phone, email, linkedin_url, github_url, address, city, state, country, postal_code, salary_range, work_experience, education, resume_prompt, gender, work_authorization, requires_sponsorship, disability_status, veteran_status, race_ethnicity, website_url, portfolio_url, preferred_name, over_18, hispanic_latino, willing_to_relocate, willing_to_travel, earliest_start_date, notice_period, how_heard, years_of_experience, education_level, school, degree, discipline, security_clearance } = req.body; if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' }); const profileId = parseInt(id); techstacks = normalizeTechstacks(req.body?.techstacks); preferredTemplate = normalizeTemplateId(req.body?.preferred_template_id, req.body?.preferred_template_kind); locationFlag = normalizeLocationFlag(req.body?.location_flag); const db = getDb(); db.run('BEGIN'); try { const result = txRunQuery(`UPDATE candidate_profiles SET first_name = ?, last_name = ?, middle_name = ?, birthdate = ?, phone = ?, email = ?, linkedin_url = ?, github_url = ?, address = ?, city = ?, state = ?, country = ?, postal_code = ?, salary_range = ?, work_experience = ?, education = ?, resume_prompt = ?, gender = ?, work_authorization = ?, requires_sponsorship = ?, disability_status = ?, veteran_status = ?, race_ethnicity = ?, website_url = ?, portfolio_url = ?, preferred_name = ?, over_18 = ?, hispanic_latino = ?, willing_to_relocate = ?, willing_to_travel = ?, earliest_start_date = ?, notice_period = ?, how_heard = ?, years_of_experience = ?, education_level = ?, school = ?, degree = ?, discipline = ?, security_clearance = ?, preferred_template_id = ?, preferred_template_kind = ?, location_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [first_name, last_name, middle_name || null, birthdate || null, phone || null, email || null, linkedin_url || null, github_url || null, address || null, city || null, state || null, country || null, postal_code || null, salary_range || null, work_experience || null, education || null, resume_prompt || null, gender || null, work_authorization || null, requires_sponsorship || null, disability_status || null, veteran_status || null, race_ethnicity || null, website_url || null, portfolio_url || null, preferred_name || null, over_18 || null, hispanic_latino || null, willing_to_relocate || null, willing_to_travel || null, earliest_start_date || null, notice_period || null, how_heard || null, years_of_experience || null, education_level || null, school || null, degree || null, discipline || null, security_clearance || null, preferredTemplate.id, preferredTemplate.kind, locationFlag, profileId]); if (result.changes === 0) { db.run('ROLLBACK'); return res.status(404).json({ error: 'Profile not found' }); } replaceProfileTechstacks(profileId, techstacks); db.run('COMMIT'); saveDatabase(); } catch (txErr) { try { db.run('ROLLBACK'); } catch (_) {} throw txErr; } const updatedProfile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [profileId]); decorateProfileWithTechstacks(updatedProfile); decorateProfileWithTemplate(updatedProfile); res.json(updatedProfile); } catch (error) { if (error && error.status === 400) return res.status(400).json({ error: error.message }); console.error('Update profile error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.delete('/profiles/:id', (req, res) => { try { const result = runQuery('DELETE FROM candidate_profiles WHERE id = ?', [parseInt(req.params.id)]); if (result.changes === 0) return res.status(404).json({ error: 'Profile not found' }); res.json({ message: 'Profile deleted successfully' }); } catch (error) { console.error('Delete profile error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/profiles/:id/duplicate', (req, res) => { try { const profiles = getAll('SELECT * FROM candidate_profiles WHERE id = ?', [parseInt(req.params.id)]); if (profiles.length === 0) return res.status(404).json({ error: 'Profile not found' }); const original = profiles[0]; const result = runQuery(`INSERT INTO candidate_profiles (first_name, last_name, middle_name, birthdate, phone, email, linkedin_url, github_url, address, city, state, country, postal_code, salary_range, work_experience, education, resume_prompt, gender, work_authorization, requires_sponsorship, disability_status, veteran_status, race_ethnicity, website_url, portfolio_url, preferred_name, over_18, hispanic_latino, willing_to_relocate, willing_to_travel, earliest_start_date, notice_period, how_heard, years_of_experience, education_level, school, degree, discipline, security_clearance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [original.first_name, original.last_name, original.middle_name, original.birthdate, original.phone, original.email, original.linkedin_url, original.github_url, original.address, original.city, original.state, original.country, original.postal_code, original.salary_range, original.work_experience, original.education, original.resume_prompt, original.gender, original.work_authorization, original.requires_sponsorship, original.disability_status, original.veteran_status, original.race_ethnicity, original.website_url, original.portfolio_url, original.preferred_name, original.over_18, original.hispanic_latino, original.willing_to_relocate, original.willing_to_travel, original.earliest_start_date, original.notice_period, original.how_heard, original.years_of_experience, original.education_level, original.school, original.degree, original.discipline, original.security_clearance]); const stacks = getAll('SELECT techstack FROM profile_techstacks WHERE profile_id = ? ORDER BY techstack', [parseInt(req.params.id)]).map(r => r.techstack); if (stacks.length) { for (const t of stacks) runQuery('INSERT INTO profile_techstacks (profile_id, techstack) VALUES (?, ?)', [result.lastInsertRowid, t]); } res.status(201).json({ id: result.lastInsertRowid, message: 'Profile duplicated successfully' }); } catch (error) { console.error('Duplicate profile error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.get('/assignments', (req, res) => {
    try {
        const assignments = getAll(`
            SELECT a.id, a.user_id, a.profile_id, a.is_default, a.assigned_at,
                   u.username, p.first_name || ' ' || p.last_name as profile_name
            FROM user_profile_assignments a
            JOIN users u ON a.user_id = u.id
            JOIN candidate_profiles p ON a.profile_id = p.id
            ORDER BY u.username ASC, a.is_default DESC, a.assigned_at ASC
        `);
        res.json(assignments.map((a) => ({ ...a, is_default: !!a.is_default })));
    } catch (error) {
        console.error('Get assignments error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
router.post('/assignments', (req, res) => {
    try {
        const { user_id, profile_id } = req.body;
        if (!user_id || !profile_id) return res.status(400).json({ error: 'User ID and Profile ID are required' });
        const uid = parseInt(user_id, 10);
        const pid = parseInt(profile_id, 10);
        const user = getOne('SELECT id FROM users WHERE id = ?', [uid]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const profile = getOne('SELECT id FROM candidate_profiles WHERE id = ?', [pid]);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });
        const existingAssignment = getOne(
            'SELECT id FROM user_profile_assignments WHERE user_id = ? AND profile_id = ?',
            [uid, pid]
        );
        if (existingAssignment) return res.status(409).json({ error: 'Assignment already exists' });
        // First profile assigned to a user becomes their default.
        const existingCount = getOne(
            'SELECT COUNT(*) AS c FROM user_profile_assignments WHERE user_id = ?',
            [uid]
        );
        const isDefault = (existingCount?.c || 0) === 0 ? 1 : 0;
        const result = runQuery(
            'INSERT INTO user_profile_assignments (user_id, profile_id, is_default) VALUES (?, ?, ?)',
            [uid, pid, isDefault]
        );
        res.status(201).json({
            id: result.lastInsertRowid,
            user_id: uid,
            profile_id: pid,
            is_default: !!isDefault
        });
    } catch (error) {
        console.error('Create assignment error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
router.put('/assignments/:id/default', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const assignment = getOne('SELECT * FROM user_profile_assignments WHERE id = ?', [id]);
        if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
        runQuery('UPDATE user_profile_assignments SET is_default = 0 WHERE user_id = ?', [assignment.user_id]);
        runQuery('UPDATE user_profile_assignments SET is_default = 1 WHERE id = ?', [id]);
        res.json({ message: 'Default profile updated', id, user_id: assignment.user_id, profile_id: assignment.profile_id });
    } catch (error) {
        console.error('Set default assignment error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
router.delete('/assignments/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const existing = getOne('SELECT * FROM user_profile_assignments WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ error: 'Assignment not found' });
        runQuery('DELETE FROM user_profile_assignments WHERE id = ?', [id]);
        // If we removed the default, promote the oldest remaining assignment.
        if (existing.is_default) {
            const next = getOne(
                `SELECT id FROM user_profile_assignments
                 WHERE user_id = ?
                 ORDER BY assigned_at ASC, id ASC
                 LIMIT 1`,
                [existing.user_id]
            );
            if (next) {
                runQuery('UPDATE user_profile_assignments SET is_default = 1 WHERE id = ?', [next.id]);
            }
        }
        res.json({ message: 'Assignment removed successfully' });
    } catch (error) {
        console.error('Delete assignment error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== ANALYTICS / STATS ====================
router.get('/stats', (req, res) => { try { let userIds = []; if (req.query.userIds !== undefined) { const raw = Array.isArray(req.query.userIds) ? req.query.userIds : [req.query.userIds]; for (const part of raw) { for (const v of String(part).split(',')) { const n = Number(v.trim()); if (Number.isFinite(n)) userIds.push(n); } } userIds = Array.from(new Set(userIds)); } const allowedPeriods = new Set(['workday', '24h', '7d', '30d', 'custom']); const periodKey = allowedPeriods.has(req.query.period) ? req.query.period : '24h'; const from = typeof req.query.from === 'string' ? req.query.from : undefined; const to = typeof req.query.to === 'string' ? req.query.to : undefined; const payload = buildStatsResponse(req, 'admin', { userIds, periodKey, from, to }); res.json(payload); } catch (error) { console.error('Get admin stats error:', error); const errMsg = error instanceof Error ? error.message : String(error); res.status(500).json({ error: 'Internal server error: ' + errMsg }); } });
// ==================== SETTINGS ====================
router.get('/settings', (req, res) => {
    try {
        res.json(settingsService.buildPublicSettingsPayload());
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

// POST /api/admin/settings/test — verifies cloud or local LLM
// Body optional: { target: 'cloud' | 'local' }  (default cloud)
router.post('/settings/test', async (req, res) => {
    try {
        const target = String(req.body?.target || 'cloud').toLowerCase();
        const axios = require('axios');
        let cfg;
        if (target === 'local') {
            cfg = settingsService.getLocalLlmConfig();
            if (!cfg.enabled) {
                return res.status(400).json({
                    ok: false,
                    error: 'Local LLM is not enabled. Turn it on in Settings first.'
                });
            }
        } else {
            const settings = settingsService.getSettings();
            cfg = settingsService.getProviderConfig(settings.ai_provider);
        }
        const response = await axios.post(cfg.apiUrl, {
            model: cfg.model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 5
        }, {
            headers: {
                'Authorization': 'Bearer ' + cfg.apiKey,
                'Content-Type': 'application/json'
            },
            timeout: cfg.timeoutMs || 30000,
            validateStatus: () => true
        });
        if (response.status >= 200 && response.status < 300) {
            res.json({
                ok: true,
                provider: cfg.provider,
                model: cfg.model,
                key_source: cfg.keySource || null,
                minimax_key_slot: cfg.minimax_key_slot || null,
                groq_key_slot: cfg.groq_key_slot || null,
                message: 'API key works'
            });
        } else {
            const body = response.data;
            const msg = (body && (body.error?.message || body.message || body.error)) || JSON.stringify(body);
            res.status(response.status >= 400 ? response.status : 502).json({
                ok: false,
                provider: cfg.provider,
                model: cfg.model,
                key_source: cfg.keySource || null,
                error: typeof msg === 'string' ? msg : JSON.stringify(msg),
                status: response.status
            });
        }
    } catch (error) {
        console.error('Settings test error:', error);
        const msg = error instanceof Error ? error.message : String(error);
        res.status(500).json({ ok: false, error: msg });
    }
});

router.put('/settings', (req, res) => {
    try {
        const {
            ai_provider,
            minimax_key_slot,
            minimax_api_key_1,
            minimax_api_key_2,
            groq_key_slot,
            groq_api_keys,
            groq_keys_replace,
            groq_remove_slot,
            deepseek_api_key,
            local_llm_enabled,
            local_llm_base_url,
            local_llm_model,
            local_llm_api_key
        } = req.body || {};
        const hasCloud = !!(ai_provider || minimax_key_slot != null
            || minimax_api_key_1 !== undefined || minimax_api_key_2 !== undefined
            || groq_key_slot != null || groq_api_keys !== undefined || groq_remove_slot != null
            || deepseek_api_key !== undefined);
        const hasLocal = local_llm_enabled !== undefined
            || local_llm_base_url !== undefined
            || local_llm_model !== undefined
            || local_llm_api_key !== undefined;
        if (!hasCloud && !hasLocal) {
            return res.status(400).json({ error: 'No settings fields provided' });
        }
        settingsService.updateSettings({
            ai_provider: ai_provider || undefined,
            minimax_key_slot,
            minimax_api_key_1,
            minimax_api_key_2,
            groq_key_slot,
            groq_api_keys,
            groq_keys_replace,
            groq_remove_slot,
            deepseek_api_key,
            local_llm_enabled,
            local_llm_base_url,
            local_llm_model,
            local_llm_api_key,
            updated_by: req.user.id
        });
        res.json(settingsService.buildPublicSettingsPayload());
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(400).json({ error: error.message || 'Failed to update settings' });
    }
});

// ==================== AUTO-APPLY CRON CONTROL ====================
router.post('/auto-apply/trigger', async (req, res) => { try { const result = await jobMatchService.triggerTickNow(); const status = jobMatchService.getStatus(); res.json({ ok: true, ...result, status }); } catch (err) { console.error('Trigger auto-apply error:', err); res.status(500).json({ error: err.message || 'Failed to trigger auto-apply' }); } });
router.get('/auto-apply/status', (req, res) => { res.json({ ok: true, status: jobMatchService.getStatus() }); });
router.get('/auto-apply/queue', async (req, res) => { const resumeQueue = require('../services/resumeQueueService'); try { await resumeQueue.refreshQueueStats(); } catch (_) {} res.json({ ok: true, queue: resumeQueue.getStatus() }); });
router.get('/job-links/queue', async (req, res) => { const jobDetailFetch = require('../services/jobDetailFetchService'); try { await jobDetailFetch.refreshQueueDepth(); } catch (_) {} res.json({ ok: true, queue: jobDetailFetch.getStatus() }); });
router.get('/auto-apply/config', (req, res) => { const status = jobMatchService.getStatus(); res.json({ ok: true, config: { intervalMs: status.intervalMs, maxJobsPerTick: status.maxJobsPerTick, maxProfilesPerJob: status.maxProfilesPerJob, staleGeneratingMs: status.staleGeneratingMs, runOnBoot: status.runOnBoot, maxPerProfilePerDay: status.maxPerProfilePerDay, maxTotalPerDay: status.maxTotalPerDay }, defaults: status.defaults, bounds: status.bounds }); });
router.put('/auto-apply/config', (req, res) => { try { const next = jobMatchService.updateConfig(req.body || {}); res.json({ ok: true, config: next }); } catch (err) { console.error('Update auto-apply config error:', err); res.status(500).json({ error: err.message || 'Failed to update auto-apply config' }); } });
// ==================== RESUME DOWNLOAD ====================
router.get('/resumes/:filename', requireAuth, requireAdmin, (req, res) => { try { const { filename } = req.params; const filepath = path.join(resumesDir, filename); if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Resume not found' }); res.download(filepath, filename); } catch (error) { console.error('Download resume error:', error); res.status(500).json({ error: 'Internal server error' }); } });

// ==================== RESUME TEMPLATES ====================
const templateService = require('../services/templateService');
router.get('/resume-templates', (req, res) => { try { templateService.ensureDefaultTemplate(); res.json({ templates: templateService.listTemplates() }); } catch (err) { console.error('List resume templates error:', err); res.status(500).json({ error: 'Failed to list resume templates' }); } });
router.get('/user-templates', (req, res) => { try { const rows = getAll(`SELECT t.id, t.user_id, t.name, t.description, t.kind, t.is_default, t.is_editable, t.last_used_at, t.created_at, t.updated_at, u.username AS owner_username FROM user_resume_templates t LEFT JOIN users u ON u.id = t.user_id ORDER BY u.username ASC, t.is_default DESC, t.updated_at DESC`); res.json({ templates: rows.map((r) => ({ id: r.id, user_id: r.user_id, owner_username: r.owner_username || null, name: r.name, description: r.description, kind: r.kind, is_default: !!r.is_default, is_editable: !!r.is_editable, last_used_at: r.last_used_at, created_at: r.created_at, updated_at: r.updated_at })) }); } catch (err) { console.error('List user templates error:', err); res.status(500).json({ error: 'Failed to list user templates' }); } });
router.get('/resume-templates/:id', (req, res) => { try { templateService.ensureDefaultTemplate(); const tpl = templateService.getTemplate(req.params.id); if (!tpl) return res.status(404).json({ error: 'Template not found' }); res.json({ template: tpl }); } catch (err) { console.error('Get resume template error:', err); res.status(500).json({ error: 'Failed to load resume template' }); } });
router.post('/resume-templates', (req, res) => { try { templateService.ensureDefaultTemplate(); const { name, description, filename, file_base64 } = req.body || {}; if (!file_base64) return res.status(400).json({ error: 'file_base64 is required' }); const safeName = (filename || 'template.docx').toString(); if (!/\.docx$/i.test(safeName)) return res.status(400).json({ error: 'Only .docx templates are supported' }); const cleanB64 = String(file_base64).replace(/^data:[^;]+;base64,/, ''); const buffer = Buffer.from(cleanB64, 'base64'); if (!buffer || buffer.length < 100) return res.status(400).json({ error: 'Template file is empty or invalid' }); if (buffer[0] !== 0x50 || buffer[1] !== 0x4B) return res.status(400).json({ error: 'Template is not a valid DOCX file' }); const tpl = templateService.uploadTemplate({ name, description, filename: safeName, buffer, uploadedBy: req.user.id }); res.json({ template: tpl }); } catch (err) { console.error('Upload resume template error:', err); res.status(400).json({ error: err.message || 'Failed to upload resume template' }); } });
router.delete('/resume-templates/:id', (req, res) => { try { templateService.ensureDefaultTemplate(); const ok = templateService.deleteTemplate(req.params.id); if (!ok) return res.status(404).json({ error: 'Template not found' }); res.json({ success: true }); } catch (err) { console.error('Delete resume template error:', err); res.status(400).json({ error: err.message || 'Failed to delete resume template' }); } });
router.get('/resume-templates/:id/download', (req, res) => { try { templateService.ensureDefaultTemplate(); const tpl = templateService.getTemplate(req.params.id); if (!tpl) return res.status(404).json({ error: 'Template not found' }); if (tpl.is_default) return res.status(400).json({ error: 'The built-in default template has no downloadable file' }); const fp = templateService.templateFilePath(req.params.id); if (!fp) return res.status(404).json({ error: 'Template file not found on disk' }); res.download(fp, tpl.filename); } catch (err) { console.error('Download resume template error:', err); res.status(500).json({ error: 'Failed to download template' }); } });

router.post('/resume-templates/:id/re-extract', async (req, res) => {
    try {
        templateService.ensureDefaultTemplate();
        const tpl = await templateService.reExtractTemplate(req.params.id);
        res.json({ template: tpl });
    } catch (err) {
        console.error('Re-extract resume template error:', err);
        res.status(400).json({ error: err.message || 'Failed to re-extract template' });
    }
});

router.post('/resume-templates/:id/apply', async (req, res) => {
    try {
        templateService.ensureDefaultTemplate();
        const tpl = await templateService.extractTemplateCandidate(req.params.id);
        const cols = templateService.profileColumnsFromExtracted(tpl.extracted_data);
        if (!cols || !cols.first_name || !cols.last_name) {
            return res.status(400).json({ error: 'Could not extract enough profile data (first and last name required)' });
        }
        const { profile_id: bodyProfileId } = req.body || {};
        const targetId = bodyProfileId ? parseInt(bodyProfileId, 10) : (tpl.candidate_profile_id ? parseInt(tpl.candidate_profile_id, 10) : null);
        let created = false;
        let profileId;
        if (targetId) {
            const existing = getOne('SELECT id FROM candidate_profiles WHERE id = ?', [targetId]);
            if (!existing) return res.status(404).json({ error: 'Profile not found' });
            runQuery(
                `UPDATE candidate_profiles SET first_name = ?, last_name = ?, middle_name = ?, email = ?, phone = ?,
                 linkedin_url = ?, github_url = ?, city = ?, state = ?, country = ?,
                 work_experience = ?, education = ?, resume_prompt = ?,
                 preferred_template_id = ?, preferred_template_kind = 'admin', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [cols.first_name, cols.last_name, cols.middle_name, cols.email, cols.phone,
                    cols.linkedin_url, cols.github_url, cols.city, cols.state, cols.country,
                    cols.work_experience, cols.education, cols.resume_prompt,
                    parseInt(req.params.id, 10), targetId]
            );
            profileId = targetId;
        } else {
            const result = runQuery(
                `INSERT INTO candidate_profiles (first_name, last_name, middle_name, email, phone, linkedin_url, github_url,
                 city, state, country, work_experience, education, resume_prompt, preferred_template_id, preferred_template_kind, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?)`,
                [cols.first_name, cols.last_name, cols.middle_name, cols.email, cols.phone,
                    cols.linkedin_url, cols.github_url, cols.city, cols.state, cols.country,
                    cols.work_experience, cols.education, cols.resume_prompt,
                    parseInt(req.params.id, 10), req.user.id]
            );
            profileId = result.lastInsertRowid;
            created = true;
        }
        runQuery('UPDATE resume_templates SET candidate_profile_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [profileId, parseInt(req.params.id, 10)]);
        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [profileId]);
        res.json({ created, profile, template: templateService.getTemplate(req.params.id) });
    } catch (err) {
        console.error('Apply resume template error:', err);
        res.status(400).json({ error: err.message || 'Failed to apply template' });
    }
});

router.post('/resume-templates/:id/preview-html', async (req, res) => {
    try {
        templateService.ensureDefaultTemplate();
        const tpl = templateService.getTemplate(req.params.id);
        if (!tpl) return res.status(404).json({ error: 'Template not found' });
        const styleSpec = tpl.style_spec || templateService.DEFAULT_STYLE_SPEC;
        const font = templateService.normaliseFontName(styleSpec?.fonts?.body) || 'Arial';
        let bodyHtml;
        const fp = templateService.templateFilePath(req.params.id);
        if (fp && fs.existsSync(fp)) {
            const buffer = fs.readFileSync(fp);
            const converted = await mammoth.convertToHtml({ buffer });
            bodyHtml = converted.value;
        } else {
            bodyHtml = templateRenderer.buildMockResumeHtml(styleSpec, font);
        }
        const css = templateRenderer.buildPdfCss(styleSpec, font);
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>${bodyHtml}</body></html>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (err) {
        console.error('Preview template HTML error:', err);
        res.status(500).json({ error: err.message || 'Failed to preview template' });
    }
});

router.post('/resume-templates/:id/preview', async (req, res) => {
    let browser;
    try {
        templateService.ensureDefaultTemplate();
        const tpl = templateService.getTemplate(req.params.id);
        if (!tpl) return res.status(404).json({ error: 'Template not found' });
        const styleSpec = tpl.style_spec || templateService.DEFAULT_STYLE_SPEC;
        const font = templateService.normaliseFontName(styleSpec?.fonts?.body) || 'Arial';
        const resumeHtml = templateRenderer.buildMockResumeHtml(styleSpec, font);
        const templateCss = templateRenderer.buildPdfCss(styleSpec, font);
        const printHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:A4;margin:12mm}html,body{margin:0;padding:0}${templateCss}</style></head><body>${resumeHtml}</body></html>`;
        const executablePath = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH ||
            (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' :
                (fs.existsSync('/snap/bin/chromium') ? '/snap/bin/chromium' : undefined));
        const puppeteer = await import('puppeteer-core');
        browser = await puppeteer.default.launch({ executablePath, headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
        const page = await browser.newPage();
        await page.setContent(printHtml, { waitUntil: 'load', timeout: 30000 });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
        await browser.close();
        browser = null;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="template-preview-${req.params.id}.pdf"`);
        res.end(pdfBuffer);
    } catch (err) {
        if (browser) try { await browser.close(); } catch (_) {}
        console.error('Preview template PDF error:', err);
        res.status(500).json({ error: err.message || 'Failed to generate preview PDF' });
    }
});


// ==================== APPLICATIONS ====================
router.get('/applications', (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 20), 100);
        const offset = (page - 1) * limit;
        const { status, company, role, date_from, date_to, assigned_user, profile_id, user_id, search, content, jd, url, link } = req.query;

        const whereClauses = ['1=1'];
        const params = [];

        if (status && status !== 'all') {
            whereClauses.push('a.status = ?');
            params.push(status);
        }
        if (profile_id) {
            whereClauses.push('a.profile_id = ?');
            params.push(parseInt(profile_id));
        }
        if (user_id) {
            whereClauses.push(`EXISTS (
                SELECT 1 FROM user_profile_assignments upa
                WHERE upa.profile_id = a.profile_id AND upa.user_id = ?
            )`);
            params.push(parseInt(user_id));
        }
        const contentTerm = (content || search) && String(content || search).trim()
            ? '%' + String(content || search).toLowerCase().trim() + '%'
            : null;
        if (contentTerm) {
            whereClauses.push(`(
                LOWER(a.company_name) LIKE ? OR
                LOWER(a.job_role) LIKE ? OR
                LOWER(COALESCE(a.job_description, '')) LIKE ? OR
                LOWER(COALESCE(a.core_skills, '')) LIKE ? OR
                LOWER(COALESCE(a.job_url, '')) LIKE ?
            )`);
            params.push(contentTerm, contentTerm, contentTerm, contentTerm, contentTerm);
        }
        const jdTerm = jd && String(jd).trim()
            ? '%' + String(jd).toLowerCase().trim() + '%'
            : null;
        if (jdTerm) {
            whereClauses.push(`LOWER(COALESCE(a.job_description, '')) LIKE ?`);
            params.push(jdTerm);
        }
        const urlRaw = url || link;
        const urlTerm = urlRaw && String(urlRaw).trim()
            ? '%' + String(urlRaw).toLowerCase().trim() + '%'
            : null;
        if (urlTerm) {
            whereClauses.push(`LOWER(COALESCE(a.job_url, '')) LIKE ?`);
            params.push(urlTerm);
        }
        if (company && String(company).trim()) {
            whereClauses.push('LOWER(a.company_name) LIKE ?');
            params.push('%' + String(company).toLowerCase().trim() + '%');
        }
        if (role && String(role).trim()) {
            whereClauses.push('LOWER(a.job_role) LIKE ?');
            params.push('%' + String(role).toLowerCase().trim() + '%');
        }
        if (date_from) {
            whereClauses.push('DATE(a.created_at) >= DATE(?)');
            params.push(String(date_from).trim());
        }
        if (date_to) {
            whereClauses.push('DATE(a.created_at) <= DATE(?)');
            params.push(String(date_to).trim());
        }
        if (assigned_user && assigned_user !== 'all') {
            whereClauses.push(`EXISTS (
                SELECT 1 FROM user_profile_assignments upa
                JOIN users u ON upa.user_id = u.id
                WHERE upa.profile_id = a.profile_id AND u.username = ?
            )`);
            params.push(String(assigned_user).trim());
        }

        const whereSQL = whereClauses.join(' AND ');
        const countRow = getOne(`SELECT COUNT(*) as total FROM job_applications a WHERE ${whereSQL}`, params);
        const total = countRow?.total || 0;

        const applications = getAll(`
            SELECT a.*,
                p.first_name,
                p.last_name,
                (SELECT GROUP_CONCAT(DISTINCT u2.username)
                 FROM user_profile_assignments upa2
                 JOIN users u2 ON upa2.user_id = u2.id
                 WHERE upa2.profile_id = a.profile_id) AS assigned_users,
                ir.id AS interview_request_id,
                ir.status AS interview_request_status,
                ir.scheduled_date AS request_scheduled_date,
                ir.scheduled_time AS request_scheduled_time,
                ir.timezone AS request_timezone,
                ir.interview_type AS request_interview_type,
                ir.interviewer_name AS request_interviewer_name,
                ir.location AS request_location,
                ir.meeting_link AS request_meeting_link,
                ir.recruiter_reply AS interview_request_reply,
                (SELECT i.id FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS interview_id,
                (SELECT i.scheduled_date FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS scheduled_date,
                (SELECT i.scheduled_time FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS scheduled_time,
                (SELECT i.timezone FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS timezone,
                (SELECT i.interview_type FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS interview_type,
                (SELECT i.interviewer_name FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS interviewer_name,
                (SELECT i.location FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS location,
                (SELECT i.meeting_link FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS meeting_link,
                (SELECT i.notes FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS interview_notes,
                (SELECT i.status FROM interviews i WHERE i.application_id = a.id ORDER BY i.created_at DESC LIMIT 1) AS interview_status,
                (SELECT ca.caller_id FROM caller_assignments ca WHERE ca.application_id = a.id ORDER BY ca.assigned_at DESC LIMIT 1) AS caller_id,
                (SELECT u3.username FROM caller_assignments ca JOIN users u3 ON u3.id = ca.caller_id WHERE ca.application_id = a.id ORDER BY ca.assigned_at DESC LIMIT 1) AS caller_username
            FROM job_applications a
            LEFT JOIN candidate_profiles p ON p.id = a.profile_id
            LEFT JOIN interview_requests ir ON ir.application_id = a.id
            WHERE ${whereSQL}
            ORDER BY a.created_at DESC, a.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const latestByAppId = getLatestMilestonesForApplications(applications.map((a) => a.id));
        for (const app of applications) {
            const m = latestByAppId.get(app.id) || null;
            app.latest_milestone = m
                ? {
                    id: m.id,
                    kind: m.kind,
                    label: m.label,
                    scheduled_at: m.scheduled_at,
                    completed_at: m.completed_at,
                    notes: m.notes
                }
                : null;
            app.state = app.state || 'in_progress';
        }

        res.json({
            data: applications,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Get applications error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.patch('/applications/:id', (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'applied', 'interview', 'rejected'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        runQuery('UPDATE job_applications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, parseInt(req.params.id)]);
        res.json({ message: 'Status updated' });
    } catch (error) { console.error('Update application status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/applications/:id/state', (req, res) => {
    try {
        const { state, reject_reason } = req.body;
        const validStates = ['completed', 'cancelled', 'rejected', 'in_progress'];
        if (!validStates.includes(state)) return res.status(400).json({ error: 'Invalid state' });
        runQuery('UPDATE job_applications SET state = ?, reject_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [state, reject_reason || null, parseInt(req.params.id)]);
        res.json({ message: 'State updated' });
    } catch (error) { console.error('Update application state error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/applications/:id/flags', (req, res) => {
    try {
        const { success, failed, cancelled } = req.body;
        const profile = setApplicationFlags(parseInt(req.params.id), {
            success: !!success,
            failed: !!failed,
            cancelled: !!cancelled,
            setBy: req.user.id
        });
        if (!profile) return res.status(404).json({ error: 'Application not found' });
        res.json({ message: 'Flags updated', application: profile });
    } catch (error) { console.error('Update application flags error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/applications/:id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM job_applications WHERE id = ?', [parseInt(req.params.id)]);
        if (result.changes === 0) return res.status(404).json({ error: 'Application not found' });
        res.json({ message: 'Application deleted' });
    } catch (error) { console.error('Delete application error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== INTERVIEWS ====================
router.post('/interviews', (req, res) => {
    try {
        const { application_id, scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes } = req.body;
        if (!application_id) return res.status(400).json({ error: 'application_id is required' });
        const result = runQuery('INSERT INTO interviews (application_id, scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [application_id, scheduled_date || null, scheduled_time || null, timezone || 'America/New_York', interview_type || null, interviewer_name || null, location || null, meeting_link || null, notes || null]);
        res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) { console.error('Create interview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/interviews/:id', (req, res) => {
    try {
        const { scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes, status } = req.body;
        runQuery('UPDATE interviews SET scheduled_date = ?, scheduled_time = ?, timezone = ?, interview_type = ?, interviewer_name = ?, location = ?, meeting_link = ?, notes = ?, status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP WHERE id = ?', [scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes, status, parseInt(req.params.id)]);
        res.json({ message: 'Interview updated' });
    } catch (error) { console.error('Update interview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/interviews/:id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM interviews WHERE id = ?', [parseInt(req.params.id)]);
        if (result.changes === 0) return res.status(404).json({ error: 'Interview not found' });
        res.json({ message: 'Interview deleted' });
    } catch (error) { console.error('Delete interview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== INTERVIEW REQUESTS ====================
router.get('/interview-requests', (req, res) => {
    try {
        const { status, developer_id, page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);
        let whereClauses = ['1=1'];
        let params = [];
        if (status && status !== 'all') { whereClauses.push('ir.status = ?'); params.push(status); }
        if (developer_id && developer_id !== 'all') { whereClauses.push('ir.assigned_developer_id = ?'); params.push(parseInt(developer_id)); }
        const whereSQL = whereClauses.join(' AND ');
        const requests = getAll(`SELECT ir.*, a.company_name, a.job_role, a.profile_id, p.first_name || ' ' || p.last_name as candidate_name, u.username as created_by_username, d.username as developer_username FROM interview_requests ir JOIN job_applications a ON ir.application_id = a.id LEFT JOIN candidate_profiles p ON a.profile_id = p.id LEFT JOIN users u ON ir.created_by = u.id LEFT JOIN users d ON ir.assigned_developer_id = d.id WHERE ${whereSQL} ORDER BY ir.created_at DESC LIMIT ? OFFSET ?`, [...params, Math.min(parseInt(limit), 100), offset]);
        res.json(requests);
    } catch (error) { console.error('Get interview requests error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/interview-requests/summary', (req, res) => {
    try {
        const rows = getAll('SELECT status, COUNT(*) as count FROM interview_requests GROUP BY status');
        const summary = { requested: 0, scheduled: 0, completed: 0, cancelled: 0, total: 0 };
        for (const row of rows) { summary[row.status] = row.count; summary.total += row.count; }
        res.json(summary);
    } catch (error) { console.error('Get interview requests summary error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/interview-requests/:id/status', (req, res) => {
    try {
        const { status, notes } = req.body;
        const validStatuses = ['requested', 'scheduled', 'completed', 'cancelled'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        runQuery('UPDATE interview_requests SET status = ?, recruiter_reply = ?, recruiter_reply_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, notes || null, parseInt(req.params.id)]);
        res.json({ message: 'Status updated' });
    } catch (error) { console.error('Update interview request status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/interview-requests/:id', (req, res) => {
    try {
        const { status, recruiter_reply, interview_type, scheduled_date, scheduled_time, timezone, interviewer_name, location, meeting_link, user_notes, reply_channel } = req.body;
        runQuery('UPDATE interview_requests SET status = COALESCE(?, status), recruiter_reply = ?, interview_type = ?, scheduled_date = ?, scheduled_time = ?, timezone = ?, interviewer_name = ?, location = ?, meeting_link = ?, user_notes = ?, reply_channel = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, recruiter_reply, interview_type, scheduled_date, scheduled_time, timezone, interviewer_name, location, meeting_link, user_notes, reply_channel, parseInt(req.params.id)]);
        res.json({ message: 'Interview request updated' });
    } catch (error) { console.error('Update interview request error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/interview-requests/:id/assign-developer', (req, res) => {
    try {
        const { developer_id } = req.body;
        const requestId = parseInt(req.params.id);
        const updated = assignDeveloper(requestId, developer_id ? parseInt(developer_id) : null);
        if (!updated) return res.status(404).json({ error: 'Interview request not found' });
        res.json({ message: 'Developer assigned', request: updated });
    } catch (error) { console.error('Assign developer error:', error); res.status(400).json({ error: error.message || 'Internal server error' }); }
});

// ==================== MILESTONES ====================
router.get('/milestones/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const app = getOne('SELECT id FROM job_applications WHERE id = ?', [applicationId]);
        if (!app) return res.status(404).json({ error: 'Application not found' });
        const request = getOne('SELECT * FROM interview_requests WHERE application_id = ?', [applicationId]);
        const milestones = listMilestonesForApplication(applicationId);
        res.json({
            milestones,
            summary: summariseMilestones(milestones),
            request: request || null,
            kinds: MILESTONE_KINDS,
            kind_labels: MILESTONE_KIND_LABELS
        });
    } catch (error) { console.error('Get milestones error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/milestones/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const app = getOne('SELECT id FROM job_applications WHERE id = ?', [applicationId]);
        if (!app) return res.status(404).json({ error: 'Application not found' });
        const request = getOrCreateRequestForApplication(applicationId, req.user.id);
        const { kind, label, scheduled_at, memo } = req.body || {};
        if (!kind) return res.status(400).json({ error: 'kind is required' });
        const created = svcAddMilestone({
            requestId: request.id,
            kind,
            label,
            scheduledAt: scheduled_at || null,
            memo: memo || null,
            addedBy: req.user.id
        });
        try {
            const bidCourseService = require('../services/bidCourseService');
            bidCourseService.recordInterviewMilestone({
                applicationId,
                kind: created.kind,
                milestoneId: created.id,
                label: created.label
            });
        } catch (courseErr) {
            console.warn('[bid-course] admin interview milestone log failed:', courseErr.message);
        }
        res.status(201).json({
            milestone: { ...created, kind_label: labelForKind(created.kind) },
            request_id: request.id
        });
    } catch (error) { console.error('Create milestone error:', error); res.status(400).json({ error: error.message || 'Internal server error' }); }
});

router.patch('/milestones/:milestoneId', (req, res) => {
    try {
        const milestoneId = parseInt(req.params.milestoneId);
        const ms = getOne('SELECT * FROM interview_milestones WHERE id = ?', [milestoneId]);
        if (!ms) return res.status(404).json({ error: 'Milestone not found' });
        const { kind, label, scheduled_at, memo } = req.body || {};
        runQuery(
            `UPDATE interview_milestones SET kind = COALESCE(?, kind), label = COALESCE(?, label),
             scheduled_at = COALESCE(?, scheduled_at), memo = COALESCE(?, memo), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [kind || null, label || null, scheduled_at || null, memo !== undefined ? memo : null, milestoneId]
        );
        const updated = getOne('SELECT * FROM interview_milestones WHERE id = ?', [milestoneId]);
        res.json({ ...updated, kind_label: labelForKind(updated.kind) });
    } catch (error) { console.error('Update milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/complete', (req, res) => {
    try {
        const milestoneId = parseInt(req.params.milestoneId);
        const { actual_at, memo, duration_minutes } = req.body || {};
        const updated = svcCompleteMilestone(milestoneId, req.user.id, { actualAt: actual_at, memo, durationMinutes: duration_minutes });
        if (!updated) return res.status(404).json({ error: 'Milestone not found' });
        res.json({ milestone: { ...updated, kind_label: labelForKind(updated.kind) } });
    } catch (error) { console.error('Complete milestone error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/uncomplete', (req, res) => {
    try {
        const updated = svcUncompleteMilestone(parseInt(req.params.milestoneId));
        if (!updated) return res.status(404).json({ error: 'Milestone not found' });
        res.json({ milestone: { ...updated, kind_label: labelForKind(updated.kind) } });
    } catch (error) { console.error('Uncomplete milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/approve', (req, res) => {
    try {
        const updated = svcApproveMilestone(parseInt(req.params.milestoneId), req.user.id);
        res.json({ milestone: { ...updated, kind_label: labelForKind(updated.kind) } });
    } catch (error) { console.error('Approve milestone error:', error); res.status(400).json({ error: error.message || 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/unapprove', (req, res) => {
    try {
        const updated = svcUnapproveMilestone(parseInt(req.params.milestoneId));
        if (!updated) return res.status(404).json({ error: 'Milestone not found' });
        res.json({ milestone: { ...updated, kind_label: labelForKind(updated.kind) } });
    } catch (error) { console.error('Unapprove milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/pay', (req, res) => {
    try {
        const updated = svcPayMilestone(parseInt(req.params.milestoneId), req.user.id);
        res.json({ milestone: { ...updated, kind_label: labelForKind(updated.kind) } });
    } catch (error) { console.error('Pay milestone error:', error); res.status(400).json({ error: error.message || 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/unpay', (req, res) => {
    try {
        const updated = svcUnpayMilestone(parseInt(req.params.milestoneId));
        if (!updated) return res.status(404).json({ error: 'Milestone not found' });
        res.json({ milestone: { ...updated, kind_label: labelForKind(updated.kind) } });
    } catch (error) { console.error('Unpay milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/milestones/:milestoneId', (req, res) => {
    try {
        const ok = svcDeleteMilestone(parseInt(req.params.milestoneId));
        if (!ok) return res.status(404).json({ error: 'Milestone not found' });
        res.json({ message: 'Milestone deleted' });
    } catch (error) { console.error('Delete milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== DEVELOPERS ====================
router.get('/developers', (req, res) => {
    try {
        res.json(getAll("SELECT u.id, u.username, u.technical_skills, u.availability, u.developer_resume, u.contact_email, u.contact_whatsapp, u.contact_phone, u.contact_telegram, u.created_at FROM users u WHERE u.role IN ('developer', 'user') ORDER BY u.username ASC"));
    } catch (error) { console.error('Get developers error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/developers/profiles', (req, res) => {
    try {
        const { q } = req.query;
        let sql = "SELECT u.id, u.username, u.technical_skills, u.availability, u.contact_email, u.contact_telegram FROM users u WHERE u.role IN ('developer', 'user')";
        let params = [];
        if (q) { sql += ' AND (u.username LIKE ? OR u.technical_skills LIKE ?)'; params.push('%'+q+'%', '%'+q+'%'); }
        sql += ' ORDER BY u.username ASC LIMIT 50';
        res.json(getAll(sql, params));
    } catch (error) { console.error('Get developer profiles error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/developers/:id/profile', (req, res) => {
    try {
        const { technical_skills, availability, contact_email, contact_whatsapp, contact_phone, contact_telegram } = req.body;
        if (contact_email && !contact_telegram) return res.status(400).json({ error: 'contact_telegram is required when contact_email is provided' });
        runQuery("UPDATE users SET technical_skills = ?, availability = ?, contact_email = ?, contact_whatsapp = ?, contact_phone = ?, contact_telegram = ? WHERE id = ? AND role IN ('developer', 'user')", [technical_skills || null, availability || null, contact_email || null, contact_whatsapp || null, contact_phone || null, contact_telegram || null, parseInt(req.params.id)]);
        res.json({ message: 'Developer profile updated' });
    } catch (error) { console.error('Update developer profile error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/developers/:id/profile/resume', (req, res) => {
    try {
        const { filename, content } = req.body;
        if (!filename || !content) return res.status(400).json({ error: 'filename and content are required' });
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filepath = path.join(resumesDir, 'developer_'+req.params.id+'_'+safeName);
        const buffer = Buffer.from(content, 'base64');
        fs.writeFileSync(filepath, buffer);
        runQuery('UPDATE users SET developer_resume = ? WHERE id = ?', [filepath, parseInt(req.params.id)]);
        res.json({ message: 'Resume uploaded', path: filepath });
    } catch (error) { console.error('Upload developer resume error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== CALLERS ====================
router.get('/callers', (req, res) => {
    try {
        res.json(getAll(`
            SELECT DISTINCT u.id, u.username, u.created_at
            FROM users u
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            WHERE u.role IN ('caller', 'developer')
               OR ur.role IN ('caller', 'developer')
            ORDER BY u.username ASC
        `));
    } catch (error) { console.error('Get callers error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/caller-assignments', (req, res) => {
    try {
        const { application_id, caller_id } = req.body;
        if (!application_id || !caller_id) return res.status(400).json({ error: 'application_id and caller_id are required' });
        const existing = getOne('SELECT id FROM caller_assignments WHERE application_id = ? AND caller_id = ?', [parseInt(application_id), parseInt(caller_id)]);
        if (existing) return res.status(409).json({ error: 'Assignment already exists' });
        const result = runQuery('INSERT INTO caller_assignments (application_id, caller_id) VALUES (?, ?)', [parseInt(application_id), parseInt(caller_id)]);
        res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) { console.error('Create caller assignment error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/caller-assignments/:caller_id/:application_id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM caller_assignments WHERE caller_id = ? AND application_id = ?', [parseInt(req.params.caller_id), parseInt(req.params.application_id)]);
        if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
        res.json({ message: 'Assignment removed' });
    } catch (error) { console.error('Delete caller assignment error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/caller-assignments/:application_id', (req, res) => {
    try {
        res.json(getAll('SELECT ca.*, u.username as caller_username FROM caller_assignments ca JOIN users u ON ca.caller_id = u.id WHERE ca.application_id = ?', [parseInt(req.params.application_id)]));
    } catch (error) { console.error('Get caller assignments error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/system/reload-database — pick up database.sqlite changes
// from disk (e.g. after `npm run seed` while the dev server is running).
router.post('/system/reload-database', (req, res) => {
    try {
        const counts = reloadDatabaseFromDisk();
        res.json({
            message: 'Database reloaded from disk',
            counts: {
                job_links: counts.job_links,
                users: getOne('SELECT COUNT(*) AS n FROM users')?.n || 0,
                applications: getOne('SELECT COUNT(*) AS n FROM job_applications')?.n || 0
            }
        });
    } catch (error) {
        console.error('Reload database error:', error);
        res.status(500).json({ error: error.message || 'Failed to reload database' });
    }
});

// ==================== BID COURSES (Auto Bidder monitor) ====================
router.post('/bid-courses/repair', (req, res) => {
    try {
        const bidCourseService = require('../services/bidCourseService');
        const summary = bidCourseService.repairAllCourses({
            limit: parseInt(req.body?.limit, 10) || 500
        });
        res.json({ ok: true, summary });
    } catch (err) {
        console.error('Admin bid courses repair error:', err);
        res.status(500).json({ error: err.message || 'Failed to repair bid courses' });
    }
});

/** POST /api/admin/bid-courses/clear — wipe Auto Bidder history (all courses). */
router.post('/bid-courses/clear', (req, res) => {
    try {
        const bidCourseService = require('../services/bidCourseService');
        const summary = bidCourseService.clearHistory({ all: true });
        res.json({ ok: true, summary });
    } catch (err) {
        console.error('Admin bid courses clear error:', err);
        res.status(500).json({ error: err.message || 'Failed to clear bid courses' });
    }
});

router.get('/bid-courses', (req, res) => {
    try {
        const bidCourseService = require('../services/bidCourseService');
        const profileId = parseInt(req.query.profile_id, 10);
        let courses = bidCourseService.listCoursesAll({
            profileId: Number.isInteger(profileId) && profileId > 0 ? profileId : undefined,
            limit: parseInt(req.query.limit, 10) || 100
        });
        const ranked = [...courses].sort((a, b) => {
            const attn = (c) => {
                const t = String(c.last_event_type || '');
                if (/captcha_cleared|captcha_assist/i.test(t)) return false;
                return /needs_manual|needs_captcha|captcha_abandoned|login_wall|no_form|ai_failed|blocked_ats|open_failed|fill_failed/i.test(t);
            };
            const am = attn(a);
            const bm = attn(b);
            if (am !== bm) return am ? -1 : 1;
            return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
        });
        res.json({ courses: ranked });
    } catch (err) {
        console.error('Admin bid courses error:', err);
        res.status(500).json({ error: 'Failed to list bid courses' });
    }
});

router.get('/bid-courses/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const lite = String(req.query.lite || '') === '1';
        const bidCourseService = require('../services/bidCourseService');
        const artifacts = require('../services/bidderArtifactService');
        const course = getOne(`SELECT * FROM bid_courses WHERE id = ?`, [id]);
        if (!course) return res.status(404).json({ error: 'Course not found' });
        const app = getOne(`SELECT * FROM job_applications WHERE id = ?`, [course.application_id]);
        const events = bidCourseService.listEvents(course.id);
        const uniqueShots = bidCourseService.listExistingScreenshots(course.id, course.application_id);
        const diskShots = artifacts.listScreenshots(course.application_id);
        res.json({
            course: bidCourseService.getCourseByApplicationId(course.application_id),
            application: app
                ? {
                    id: app.id,
                    profile_id: app.profile_id,
                    company_name: app.company_name,
                    job_role: app.job_role,
                    job_url: app.job_url,
                    job_description: lite ? null : app.job_description,
                    resume_filename: app.resume_filename,
                    draft_html: lite ? null : app.draft_html,
                    generation_status: app.generation_status,
                    status: app.status,
                    download_url: app.resume_filename
                        ? `/resumes/${encodeURIComponent(app.resume_filename)}`
                        : null
                }
                : null,
            events: lite ? events.slice(-40) : events,
            screenshots: uniqueShots.map((s) => ({
                id: s.id,
                stage: s.stage,
                created_at: s.created_at,
                filename: s.filename || path.basename(s.file_path),
                url: `/admin/bid-courses/${course.id}/screenshots/${encodeURIComponent(s.filename || path.basename(s.file_path))}`
            })),
            disk_screenshots: diskShots.map((s) => ({
                stage: s.stage,
                filename: s.filename,
                url: `/admin/bid-courses/${course.id}/screenshots/${encodeURIComponent(s.filename)}`
            })),
            artifact_root: artifacts.resolveRoot(),
            field_attempts: lite
                ? []
                : (() => {
                try {
                    const brain = require('../services/bidderBrainService');
                    return brain.listFieldAttempts(course.application_id);
                } catch {
                    return [];
                }
            })(),
            engine_version: (() => {
                try {
                    return require('../services/bidderBrainService').ENGINE_VERSION;
                } catch {
                    return null;
                }
            })(),
            lite: !!lite
        });
    } catch (err) {
        console.error('Admin bid course detail error:', err);
        res.status(500).json({ error: err.message || 'Failed to load course' });
    }
});

router.get('/bid-courses/:id/screenshots/:filename', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const artifacts = require('../services/bidderArtifactService');
        const course = getOne(`SELECT * FROM bid_courses WHERE id = ?`, [id]);
        if (!course) return res.status(404).json({ error: 'Course not found' });
        const fp = artifacts.readScreenshotFile(course.application_id, req.params.filename);
        if (!fp) return res.status(404).json({ error: 'Screenshot not found' });
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.sendFile(fp);
    } catch (err) {
        res.status(500).json({ error: 'Failed to serve screenshot' });
    }
});

// ==================== ANALYZE (all users) ====================
router.get('/analyze', (req, res) => {
    try {
        const sinceDays = parseInt(req.query.since_days, 10) || 30;
        const { buildBidSnapshot } = require('../services/bidAnalyzeService');
        const { getUsageSummary } = require('../services/aiUsageService');
        const { buildBidInsights } = require('../services/bidInsightsService');
        const bids = buildBidSnapshot({
            allUsers: true,
            limit: Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 150))
        });
        const usage = getUsageSummary({ sinceDays });
        const insights = buildBidInsights({ allUsers: true });
        res.json({ bids, usage, insights });
    } catch (error) {
        console.error('Admin analyze load error:', error);
        res.status(500).json({ error: error.message || 'Failed to load analyze data' });
    }
});

router.post('/analyze/run', async (req, res) => {
    try {
        const { runBidAnalysis } = require('../services/bidAnalyzeService');
        const result = await runBidAnalysis({
            userId: req.user.id,
            allUsers: true
        });
        res.json(result);
    } catch (error) {
        const status = error.status || 500;
        console.error('Admin analyze run error:', error.message || error);
        res.status(status).json({
            error: error.message || 'Failed to run analysis',
            retry_after_sec: error.retryAfterSec || undefined
        });
    }
});

module.exports = router;

