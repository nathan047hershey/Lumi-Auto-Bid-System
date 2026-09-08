const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getAll, getOne, runQuery } = require('../config/database');
const {
    MILESTONE_KINDS,
    MILESTONE_KIND_LABELS,
    labelForKind,
    listMilestonesForApplication,
    listMilestonesForRequest,
    addMilestone: svcAddMilestone,
    canCompleteMilestone,
    canAddMilestone,
    summariseMilestones,
    getUserRoles,
    getOrCreateRequestForApplication,
    deleteMilestone: svcDeleteMilestone,
    // Used by the legacy GET /applications list endpoint to decorate
    // each row with the latest milestone (without an N+1).
    getLatestMilestonesForApplications
} = require('../services/milestoneService');
const { localPickerToUTCIso } = require('../utils/time');
const { requireAuth } = require('../middleware/auth');
const { generateResume, generateCoverLetter, sanitizeForFilename, extractCompanyName } = require('../services/resumeService');
const { generateValidatedDraft, finalizeDraftToDocx, resolveStyleSpecForGeneration } = require('../services/resumePipeline');
const { getCurrentWorkdayEST, toSqlDateTime } = require('../utils/time');
const { buildStatsResponse } = require('../services/statsService');
const { getProviderConfig } = require('../services/settingsService');
// Hoisted to module scope so every handler below (generate-resume,
// regenerate-resume, resume-pdf, and the /resume-templates reads) uses
// the same require() result. Previously this import lived at the
// bottom of the file, which worked only because CommonJS hoists
// module-resolution but was brittle under editors/refactors.
const templateService = require('../services/templateService');
// Same rationale as templateService above: shared by /resume-pdf and
// any future renderer entrypoint. Lives next to it for symmetry.
const templateRenderer = require('../services/templateRenderer');
// Per-user, drag-drop built resume templates (template-builder UI).
// CRUD lives under /api/user/user-templates below.
const userTemplateService = require('../services/userTemplateService');
const outlookMail = require('../services/outlookMailService');
const mailForward = require('../services/mailForwardService');

const router = express.Router();

// Resumes live on DATA_ROOT (<repo>/database/resumes by default)
const { RESUMES_DIR: resumesDir } = require('../config/paths');
if (!fs.existsSync(resumesDir)) {
    fs.mkdirSync(resumesDir, { recursive: true });
}

// Apply auth middleware to all user routes
router.use(requireAuth);

function userIsAdmin(req) {
    return req.user?.role === 'admin'
        || (Array.isArray(req.user?.additional_roles) && req.user.additional_roles.includes('admin'));
}

function getAssignedProfile(profileId, userId) {
    return getOne(`
      SELECT p.*
      FROM candidate_profiles p
      JOIN user_profile_assignments a ON p.id = a.profile_id
      WHERE p.id = ? AND a.user_id = ?
    `, [parseInt(profileId, 10), userId]);
}

/** Admins may use any profile; regular users only assigned profiles. */
function getAccessibleProfile(profileId, req) {
    const pid = parseInt(profileId, 10);
    if (!pid) return null;
    if (userIsAdmin(req)) {
        return getOne('SELECT * FROM candidate_profiles WHERE id = ?', [pid]);
    }
    return getAssignedProfile(pid, req.user.id);
}

/** Admins may access any application; users only apps on assigned profiles. */
function getAccessibleApplication(applicationId, req) {
    const id = parseInt(applicationId, 10);
    if (!id) return null;
    if (userIsAdmin(req)) {
        return getOne('SELECT * FROM job_applications WHERE id = ?', [id]);
    }
    return getOne(`
      SELECT a.*
      FROM job_applications a
      JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
      WHERE a.id = ? AND ua.user_id = ?
    `, [id, req.user.id]);
}

// ==================== ASSIGNED PROFILES ====================

// GET /api/user/profiles - Get user's assigned profiles (default first)
router.get('/profiles', (req, res) => {
    try {
        const isAdmin = userIsAdmin(req);
        const profiles = isAdmin
            ? getAll(`
      SELECT p.*, 0 AS is_default
      FROM candidate_profiles p
      ORDER BY p.id ASC
    `)
            : getAll(`
      SELECT p.*, a.is_default AS is_default
      FROM candidate_profiles p
      JOIN user_profile_assignments a ON p.id = a.profile_id
      WHERE a.user_id = ?
      ORDER BY a.is_default DESC, a.assigned_at ASC, p.id ASC
    `, [req.user.id]);

        const allTech = isAdmin
            ? getAll('SELECT profile_id, techstack FROM profile_techstacks')
            : getAll(
                `SELECT profile_id, techstack FROM profile_techstacks
             WHERE profile_id IN (
               SELECT profile_id FROM user_profile_assignments WHERE user_id = ?
             )`,
                [req.user.id]
            );
        const byId = new Map();
        for (const row of allTech) {
            if (!byId.has(row.profile_id)) byId.set(row.profile_id, []);
            byId.get(row.profile_id).push(row.techstack);
        }

        res.json(profiles.map((p) => ({
            ...p,
            is_default: !!p.is_default,
            techstacks: byId.get(p.id) || []
        })));
    } catch (error) {
        console.error('Get assigned profiles error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/user/profiles/:id/default — mark one assigned profile as default
router.put('/profiles/:id/default', (req, res) => {
    try {
        const profileId = parseInt(req.params.id, 10);
        const assignment = getOne(
            'SELECT id FROM user_profile_assignments WHERE user_id = ? AND profile_id = ?',
            [req.user.id, profileId]
        );
        if (!assignment) return res.status(404).json({ error: 'Profile not assigned to you' });
        runQuery('UPDATE user_profile_assignments SET is_default = 0 WHERE user_id = ?', [req.user.id]);
        runQuery('UPDATE user_profile_assignments SET is_default = 1 WHERE id = ?', [assignment.id]);
        res.json({ message: 'Default profile updated', profile_id: profileId });
    } catch (error) {
        console.error('Set default profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/profiles/:id - Get single assigned profile
router.get('/profiles/:id', (req, res) => {
    try {
        const profileId = parseInt(req.params.id, 10);
        const isAdmin = userIsAdmin(req);
        // JOIN the right template table based on
        // preferred_template_kind so the user-facing generator can
        // show the assigned template's display name whether the
        // admin picked an admin-uploaded DOCX or a teammate's
        // drag-drop template. The owner_username surfaces so the
        // user knows whose drag-drop template is being applied.
        const profile = getOne(`
      SELECT p.*,
             COALESCE(p.preferred_template_kind, 'admin') AS preferred_template_kind,
             CASE WHEN COALESCE(p.preferred_template_kind, 'admin') = 'user'
                  THEN ut.name
                  ELSE at.name
             END AS preferred_template_name,
             CASE WHEN COALESCE(p.preferred_template_kind, 'admin') = 'user'
                  THEN ut.is_default
                  ELSE at.is_default
             END AS preferred_template_is_default,
             CASE WHEN COALESCE(p.preferred_template_kind, 'admin') = 'user'
                  THEN u.username
                  ELSE NULL
             END AS preferred_template_owner
      FROM candidate_profiles p
      ${isAdmin ? '' : 'JOIN user_profile_assignments a ON p.id = a.profile_id'}
      LEFT JOIN resume_templates at        ON at.id = p.preferred_template_id
                                          AND COALESCE(p.preferred_template_kind, 'admin') = 'admin'
      LEFT JOIN user_resume_templates ut   ON ut.id = p.preferred_template_id
                                          AND COALESCE(p.preferred_template_kind, 'admin') = 'user'
      LEFT JOIN users u                    ON u.id = ut.user_id
      WHERE p.id = ? ${isAdmin ? '' : 'AND a.user_id = ?'}
    `, isAdmin ? [profileId] : [profileId, req.user.id]);

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found or not assigned to you' });
        }

        const techRows = getAll(
            'SELECT techstack FROM profile_techstacks WHERE profile_id = ?',
            [profile.id]
        );
        profile.techstacks = techRows.map((r) => r.techstack);
        profile.is_default = isAdmin ? false : !!getOne(
            'SELECT is_default FROM user_profile_assignments WHERE user_id = ? AND profile_id = ?',
            [req.user.id, profile.id]
        )?.is_default;

        res.json(profile);
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== RESUME GENERATION ====================

// POST /api/user/extract-company - Extract company name from a job description via AI
router.post('/extract-company', async (req, res) => {
    try {
        const { job_description } = req.body;
        if (!job_description || !job_description.trim()) {
            return res.status(400).json({ error: 'Job description is required' });
        }
        const companyName = await extractCompanyName(job_description);
        res.json({ company_name: companyName });
    } catch (error) {
        console.error('Extract company error:', error);
        res.status(500).json({ error: error.message || 'Failed to extract company name' });
    }
});

// GET /api/user/jobs/by-url?url=… - Look up an application that has the given
// `job_url` and return its stored metadata so the resume-generation form can
// be auto-filled. Matched in three stages (try each in order):
//
//   1. exact match against `job_applications.job_url`
//   2. normalised match (strip fragment + trailing slash)
//   3. same-host + last path-segment match (catches small URL variants)
//
// The user must own (be assigned to) the profile the application belongs to
// — same access policy as every other /user route.
//
// Response:
//   {
//     found: true,
//     job_url, company_name, job_role, core_skills, job_description,
//     // Lifecycle — drives the lookup-result badges in the UI
//     status,                // 'pending' | 'applied' | 'rejected' | 'interview'
//     state,                 // 'in_progress' | 'completed' | 'cancelled' | 'rejected'
//     reject_reason,         // populated when status='rejected' or state='rejected'
//     applier_id,            // user_id who clicked "Apply"
//     applier_username,      // resolved username for the applier_id (nullable)
//     // Ownership
//     assigned_users,        // [usernames] of the profile owner(s)
//     owned_by_current_user, // true when the caller is one of the assigned users
//   }
//   { found: false, job_url }
router.get('/jobs/by-url', (req, res) => {
    try {
        const rawUrl = (req.query.url || '').toString().trim();
        if (!rawUrl) {
            return res.status(400).json({ error: 'url query parameter is required' });
        }

        // The lookup is GLOBAL across the entire `job_applications` table —
        // any user can see whether someone (themselves OR another user)
        // already applied to this URL. We still return ownership metadata
        // so the caller can show "applied by Bwalya" / "applied by Len" etc.
        const SELECT = `
            SELECT
                a.id,
                a.company_name,
                a.job_role,
                a.core_skills,
                a.job_description,
                a.job_url,
                a.status,
                a.state,
                a.reject_reason,
                a.applier_id,
                applier.username AS applier_username,
                p.id   AS profile_id,
                p.first_name,
                p.last_name,
                -- Comma-separated list of every user the profile is assigned
                -- to (the "owner" of the application). Empty when no-one is
                -- assigned yet.
                (
                    SELECT GROUP_CONCAT(DISTINCT u2.username)
                    FROM user_profile_assignments upa2
                    JOIN users u2 ON upa2.user_id = u2.id
                    WHERE upa2.profile_id = a.profile_id
                ) AS assigned_users
            FROM job_applications a
            JOIN candidate_profiles p ON p.id = a.profile_id
            LEFT JOIN users applier ON a.applier_id = applier.id`;

        let match = null;

        // 1. Exact match
        match = getOne(
            `${SELECT}
             WHERE a.job_url = ?
             ORDER BY a.updated_at DESC
             LIMIT 1`,
            [rawUrl]
        );

        // 2. Normalised match: strip fragment + trailing slashes
        if (!match) {
            const normalised = rawUrl.replace(/#.*$/, '').replace(/\/+$/, '');
            if (normalised !== rawUrl) {
                match = getOne(
                    `${SELECT}
                     WHERE a.job_url = ?
                     ORDER BY a.updated_at DESC
                     LIMIT 1`,
                    [normalised]
                );
            }
        }

        // 3. Same-origin + last path-segment fuzzy match
        if (!match) {
            try {
                const u = new URL(rawUrl);
                const tail = (u.pathname || '').split('/').filter(Boolean).pop() || '';
                // `like` requires both the host and a non-trivial tail (>=8 chars)
                // so we don't grab a wrong job from a shared short slug.
                if (tail && tail.length >= 8) {
                    match = getOne(
                        `${SELECT}
                         WHERE a.job_url LIKE '%' || ? || '%'
                           AND a.job_url LIKE '%' || ? || '%'
                         ORDER BY a.updated_at DESC
                         LIMIT 1`,
                        [u.hostname, tail]
                    );
                }
            } catch (_) {
                // Invalid URL — just give up and return found:false below.
            }
        }

        if (!match) {
            return res.json({ found: false, job_url: rawUrl });
        }

        // `owned_by_current_user` lets the UI badge the row "Yours" vs
        // "Applied by …" without leaking ownership to anyone who shouldn't
        // see it.
        const assignedUsernames = (match.assigned_users || '').split(',').map((s) => s.trim()).filter(Boolean);
        const me = getOne(`SELECT username FROM users WHERE id = ?`, [req.user.id]);
        const ownedByCurrentUser = !!(me && assignedUsernames.includes(me.username));

        res.json({
            found: true,
            application_id: match.id,
            profile_id: match.profile_id,
            profile_name: `${match.first_name || ''} ${match.last_name || ''}`.trim(),
            status: match.status,
            // Lifecycle metadata used by the lookup-result badges
            state: match.state || 'in_progress',
            reject_reason: match.reject_reason || '',
            applier_id: match.applier_id || null,
            applier_username: match.applier_username || null,
            job_url: match.job_url,
            company_name: match.company_name || '',
            job_role: match.job_role || '',
            core_skills: match.core_skills || '',
            job_description: match.job_description || '',
            // New global-lookup metadata
            assigned_users: assignedUsernames,
            owned_by_current_user: ownedByCurrentUser
        });
    } catch (error) {
        console.error('Lookup job by URL error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/user/generate-resume - Generate resume with AI
router.post('/generate-resume', async (req, res) => {
    try {
        const {
            profile_id,
            job_description,
            company_name: providedCompany,
            job_role: providedRole,
            core_skills: providedSkills,
            job_url: providedUrl,
            template_id: providedTemplateId,
            font_family: providedFont
        } = req.body;

        if (!profile_id || !job_description) {
            return res.status(400).json({ error: 'Profile ID and job description are required' });
        }

        // Verify user has access to this profile (admins: any profile)
        const profile = getAccessibleProfile(profile_id, req);

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found or not assigned to you' });
        }

        // Resolve the template + font. Whitelist-check the font so the
        // spec/font stay safe (defence in depth — the frontend picker
        // only sends known fonts, but a custom client shouldn't be able
        // to slip in a font we can't render).
        const { withUsageContext } = require('../services/aiUsageService');
        const draftResult = await withUsageContext(
            { userId: req.user.id, profileId: parseInt(profile_id, 10), kind: 'cv' },
            () => generateValidatedDraft(
                profile,
                job_description,
                providedCompany,
                req,
                req.body,
                null,
                { autoFinalize: true, resumesDir }
            )
        );

        const {
            resumeHtml,
            companyName: detectedCompany,
            template_id: returnedTemplateId,
            font_family: returnedFont,
            font: draftFont,
            preview_css: previewCss,
            styleSpec: draftStyleSpec,
            provider_used: providerUsed,
            fallback_used: fallbackUsed,
            validation,
            validation_attempts: validationAttempts,
            quality_report: qualityReport,
            quality_attempts: qualityAttempts,
            generation_ms: generationMs,
            generation_seconds: generationSeconds,
            generation_status: draftStatus,
            is_finalized: isFinalized,
            resume_filename: resumeFilename,
            resume_pdf_filename: resumePdfFilename,
            llm_ms: llmMs,
            polish_ms: polishMs,
            prompt_chars: promptChars,
            output_chars: outputChars
        } = draftResult;

        const resolvedFont = returnedFont || draftFont || 'Arial';
        let previewCssOut = previewCss || '';
        if (!previewCssOut && draftStyleSpec) {
            try {
                previewCssOut = templateRenderer.buildPdfCss(draftStyleSpec, resolvedFont) || '';
            } catch (_) { /* ignore */ }
        }

        // Prefer user-provided company; fall back to AI-detected
        const finalCompany = (providedCompany && providedCompany.trim()) ? providedCompany.trim() : detectedCompany;

        const genStatus = draftStatus;
        const genError = validation.pass ? null : validation.issues.join('; ');

        const result = runQuery(`
      INSERT INTO job_applications (
        profile_id, company_name, job_role, core_skills, job_description, job_url,
        resume_filename, applier_id, status, template_id, font_family,
        draft_html, generation_status, generation_error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `, [
            parseInt(profile_id),
            finalCompany,
            (providedRole || '').trim(),
            (providedSkills || '').trim(),
            job_description,
            (providedUrl || '').trim(),
            resumeFilename || null,
            req.user.id,
            returnedTemplateId || null,
            resolvedFont,
            resumeHtml,
            genStatus,
            genError
        ]);

        const applicationId = result.lastInsertRowid;
        try {
            const bidCourseService = require('../services/bidCourseService');
            bidCourseService.recordGenerateDone({
                applicationId,
                profileId: parseInt(profile_id, 10),
                userId: req.user.id,
                jobUrl: (providedUrl || '').trim(),
                companyName: finalCompany,
                jobRole: (providedRole || '').trim(),
                templateId: returnedTemplateId,
                fontFamily: resolvedFont,
                cvProvider: providerUsed || null
            });
        } catch (courseErr) {
            console.warn('[bid-course] generate_done log failed:', courseErr.message);
        }

        res.json({
            application_id: applicationId,
            company_name: finalCompany,
            job_role: (providedRole || '').trim(),
            core_skills: (providedSkills || '').trim(),
            job_url: (providedUrl || '').trim(),
            resume_filename: resumeFilename || null,
            resume_pdf_filename: resumePdfFilename || null,
            resume_content: resumeHtml,
            resume_html: resumeHtml,
            reasoning: '',
            status: 'pending',
            template_id: returnedTemplateId || null,
            font_family: resolvedFont,
            preview_css: previewCssOut,
            provider_used: providerUsed || null,
            fallback_used: !!fallbackUsed,
            generation_status: genStatus,
            generation_ms: generationMs ?? null,
            generation_seconds: generationSeconds ?? null,
            llm_ms: llmMs ?? null,
            polish_ms: polishMs ?? null,
            prompt_chars: promptChars ?? null,
            output_chars: outputChars ?? null,
            validation,
            validation_attempts: validationAttempts,
            quality_report: qualityReport || null,
            quality_attempts: qualityAttempts ?? null,
            is_draft: !isFinalized,
            is_finalized: isFinalized
        });
    } catch (error) {
        console.error('Generate resume error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate resume' });
    }
});

// POST /api/user/regenerate-resume - Regenerate resume for an existing application (update only)
router.post('/regenerate-resume', async (req, res) => {
    try {
        const {
            application_id,
            resume_filename,
            job_description,
            template_id: providedTemplateId,
            font_family: providedFont
        } = req.body;

        if (!job_description) {
            return res.status(400).json({ error: 'Job description is required' });
        }
        if (!application_id && !resume_filename) {
            return res.status(400).json({ error: 'Application ID or resume filename is required' });
        }

        // Look up the application by id, falling back to the most recent
        // matching resume_filename for the current user (admins: any app).
        let existing = null;
        const isAdmin = userIsAdmin(req);
        if (application_id) {
            existing = isAdmin
                ? getOne('SELECT a.* FROM job_applications a WHERE a.id = ?', [parseInt(application_id, 10)])
                : getOne(`
        SELECT a.* FROM job_applications a
        JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
        WHERE a.id = ? AND ua.user_id = ?
      `, [parseInt(application_id, 10), req.user.id]);
        }
        if (!existing && resume_filename) {
            existing = isAdmin
                ? getOne(`
        SELECT a.* FROM job_applications a
        WHERE a.resume_filename = ?
        ORDER BY a.id DESC LIMIT 1
      `, [resume_filename])
                : getOne(`
        SELECT a.* FROM job_applications a
        JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
        WHERE a.resume_filename = ? AND ua.user_id = ?
        ORDER BY a.id DESC LIMIT 1
      `, [resume_filename, req.user.id]);
        }

        if (!existing) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        // Only allow regeneration when status is pending
        if (existing.status !== 'pending') {
            return res.status(400).json({ error: `Cannot regenerate a resume for an application with status "${existing.status}"` });
        }

        // Load the profile
        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [existing.profile_id]);
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const regenBody = {
            ...req.body,
            core_skills: req.body.core_skills ?? existing.core_skills
        };

        const { withUsageContext } = require('../services/aiUsageService');
        const draftResult = await withUsageContext(
            { userId: req.user.id, profileId: existing.profile_id, kind: 'cv' },
            () => generateValidatedDraft(
                profile,
                job_description,
                existing.company_name,
                req,
                regenBody,
                existing,
                { autoFinalize: true, resumesDir }
            )
        );

        const {
            resumeHtml,
            companyName: detectedCompany,
            template_id: returnedTemplateId,
            font_family: returnedFont,
            font: draftFont,
            preview_css: previewCss,
            styleSpec: draftStyleSpec,
            validation,
            validation_attempts: validationAttempts,
            quality_report: qualityReport,
            quality_attempts: qualityAttempts,
            generation_ms: generationMs,
            generation_seconds: generationSeconds,
            generation_status: genStatus,
            is_finalized: isFinalized,
            resume_filename: resumeFilename,
            resume_pdf_filename: resumePdfFilename,
            llm_ms: llmMs,
            polish_ms: polishMs,
            prompt_chars: promptChars,
            output_chars: outputChars
        } = draftResult;

        const resolvedFont = returnedFont || draftFont || existing.font_family || 'Arial';
        let previewCssOut = previewCss || '';
        if (!previewCssOut && draftStyleSpec) {
            try {
                previewCssOut = templateRenderer.buildPdfCss(draftStyleSpec, resolvedFont) || '';
            } catch (_) { /* ignore */ }
        }

        const finalCompany = (existing.company_name && existing.company_name !== 'Unknown' && existing.company_name.trim())
            ? existing.company_name
            : detectedCompany;

        const genError = validation.pass ? null : validation.issues.join('; ');

        // Remove the previous resume file if replaced or cleared
        if (existing.resume_filename && existing.resume_filename !== resumeFilename) {
            const oldPath = path.join(resumesDir, existing.resume_filename);
            try {
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            } catch (cleanupErr) {
                console.warn('Failed to remove old resume file:', cleanupErr.message);
            }
            const { docxFilenameToPdfFilename } = require('../services/resumePdfService');
            const oldPdf = docxFilenameToPdfFilename(existing.resume_filename);
            if (oldPdf) {
                const oldPdfPath = path.join(resumesDir, oldPdf);
                try {
                    if (fs.existsSync(oldPdfPath)) fs.unlinkSync(oldPdfPath);
                } catch (_) { /* noop */ }
            }
        }

        runQuery(`
      UPDATE job_applications
      SET resume_filename = ?,
          draft_html = ?,
          updated_at = CURRENT_TIMESTAMP,
          template_id = COALESCE(?, template_id),
          font_family = COALESCE(?, font_family),
          generation_status = ?,
          generation_error = ?
      WHERE id = ?
    `, [
            resumeFilename || null,
            resumeHtml,
            returnedTemplateId || null,
            resolvedFont || null,
            genStatus,
            genError,
            existing.id
        ]);

        try {
            const bidCourseService = require('../services/bidCourseService');
            bidCourseService.recordGenerateDone({
                applicationId: existing.id,
                profileId: existing.profile_id,
                userId: req.user.id,
                jobUrl: existing.job_url,
                companyName: finalCompany,
                jobRole: existing.job_role,
                templateId: returnedTemplateId || existing.template_id,
                fontFamily: resolvedFont,
                cvProvider: null
            });
        } catch (courseErr) {
            console.warn('[bid-course] regenerate generate_done log failed:', courseErr.message);
        }

        res.json({
            application_id: existing.id,
            company_name: finalCompany,
            job_role: existing.job_role || '',
            core_skills: regenBody.core_skills || existing.core_skills || '',
            job_url: existing.job_url || '',
            resume_filename: resumeFilename || null,
            resume_pdf_filename: resumePdfFilename || null,
            resume_content: resumeHtml,
            resume_html: resumeHtml,
            status: existing.status,
            template_id: returnedTemplateId || existing.template_id || null,
            font_family: resolvedFont,
            preview_css: previewCssOut,
            generation_status: genStatus,
            generation_ms: generationMs ?? null,
            generation_seconds: generationSeconds ?? null,
            llm_ms: llmMs ?? null,
            polish_ms: polishMs ?? null,
            prompt_chars: promptChars ?? null,
            output_chars: outputChars ?? null,
            validation,
            validation_attempts: validationAttempts,
            quality_report: qualityReport || null,
            quality_attempts: qualityAttempts ?? null,
            is_draft: !isFinalized,
            is_finalized: isFinalized
        });
    } catch (error) {
        console.error('Regenerate resume error:', error);
        res.status(500).json({ error: error.message || 'Failed to regenerate resume' });
    }
});

// GET /api/user/cv-quality/applications — recent apps that have draft HTML
router.get('/cv-quality/applications', (req, res) => {
    try {
        const isAdmin = req.user.role === 'admin';
        const rows = isAdmin
            ? getAll(`
                SELECT a.id, a.profile_id, a.company_name, a.job_role, a.status, a.created_at, a.updated_at
                FROM job_applications a
                WHERE a.draft_html IS NOT NULL AND TRIM(a.draft_html) != ''
                ORDER BY COALESCE(a.updated_at, a.created_at) DESC
                LIMIT 40
            `)
            : getAll(`
                SELECT a.id, a.profile_id, a.company_name, a.job_role, a.status, a.created_at, a.updated_at
                FROM job_applications a
                JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
                WHERE ua.user_id = ?
                  AND a.draft_html IS NOT NULL AND TRIM(a.draft_html) != ''
                ORDER BY COALESCE(a.updated_at, a.created_at) DESC
                LIMIT 40
            `, [req.user.id]);
        res.json({ applications: rows || [] });
    } catch (error) {
        console.error('cv-quality list error:', error);
        res.status(500).json({ error: error.message || 'Failed to list applications' });
    }
});

// GET /api/user/cv-quality/:applicationId — run 4-pass audit on stored draft
router.get('/cv-quality/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId, 10);
        if (!applicationId) {
            return res.status(400).json({ error: 'Invalid application id' });
        }
        const isAdmin = req.user.role === 'admin';
        const app = isAdmin
            ? getOne('SELECT * FROM job_applications WHERE id = ?', [applicationId])
            : getOne(`
                SELECT a.* FROM job_applications a
                JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
                WHERE a.id = ? AND ua.user_id = ?
            `, [applicationId, req.user.id]);
        if (!app) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }
        if (!app.draft_html || !String(app.draft_html).trim()) {
            return res.status(400).json({ error: 'No draft CV HTML on this application' });
        }
        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [app.profile_id]) || {};
        const { buildResumeQualityReport } = require('../services/resumeQualityReportService');
        const quality_report = buildResumeQualityReport(app.draft_html, {
            profile,
            jobDescription: app.job_description || '',
            coreSkills: app.core_skills || ''
        });
        res.json({
            application_id: app.id,
            profile_id: app.profile_id,
            company_name: app.company_name,
            job_role: app.job_role,
            status: app.status,
            quality_report
        });
    } catch (error) {
        console.error('cv-quality report error:', error);
        res.status(500).json({ error: error.message || 'Quality check failed' });
    }
});

// POST /api/user/check-resume-quality — 4-pass audit on existing HTML (no remake)
router.post('/check-resume-quality', async (req, res) => {
    try {
        const { resume_html, profile_id, job_description, core_skills } = req.body || {};
        if (!resume_html || !String(resume_html).trim()) {
            return res.status(400).json({ error: 'resume_html is required' });
        }
        let profile = {};
        if (profile_id) {
            const row = getOne(`
                SELECT p.* FROM candidate_profiles p
                JOIN user_profile_assignments ua ON p.id = ua.profile_id
                WHERE p.id = ? AND ua.user_id = ?
            `, [parseInt(profile_id, 10), req.user.id]);
            if (row) profile = row;
            else if (req.user.role === 'admin') {
                profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [parseInt(profile_id, 10)]) || {};
            }
        }
        const { buildResumeQualityReport } = require('../services/resumeQualityReportService');
        const quality_report = buildResumeQualityReport(resume_html, {
            profile,
            jobDescription: job_description || '',
            coreSkills: core_skills || ''
        });
        res.json({ quality_report });
    } catch (error) {
        console.error('check-resume-quality error:', error);
        res.status(500).json({ error: error.message || 'Quality check failed' });
    }
});

// POST /api/user/finalize-resume - Build DOCX from a validated draft
router.post('/finalize-resume', async (req, res) => {
    try {
        const { application_id } = req.body;
        if (!application_id) {
            return res.status(400).json({ error: 'Application ID is required' });
        }

        const existing = getOne(`
      SELECT a.* FROM job_applications a
      JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
      WHERE a.id = ? AND ua.user_id = ?
    `, [parseInt(application_id), req.user.id]);

        if (!existing) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        if (existing.status !== 'pending') {
            return res.status(400).json({ error: `Cannot finalize a resume for an application with status "${existing.status}"` });
        }

        const draftHtml = existing.draft_html;
        if (!draftHtml || !draftHtml.trim()) {
            return res.status(400).json({ error: 'No draft resume found for this application. Generate a draft first.' });
        }

        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [existing.profile_id]);
        if (!profile) {
            return res.status(404).json({ error: 'Profile not found' });
        }

        const { validateResumeHtml } = require('../services/resumeValidationService');
        const validation = validateResumeHtml(draftHtml, {
            profile,
            jobDescription: existing.job_description,
            companyName: existing.company_name,
            coreSkills: existing.core_skills
        });

        if (!validation.pass) {
            return res.status(422).json({
                error: 'Draft resume did not pass quality checks. Regenerate the draft or fix the issues below.',
                validation,
                generation_status: 'failed'
            });
        }

        const { font, styleSpec, effectiveTemplateId } = resolveStyleSpecForGeneration(
            req,
            profile,
            { font_family: existing.font_family, template_id: existing.template_id },
            existing
        );

        const finalCompany = (existing.company_name && existing.company_name.trim())
            ? existing.company_name.trim()
            : 'Unknown';

        const { filename, font_family: returnedFont, template_id: returnedTemplateId } = await finalizeDraftToDocx({
            profile,
            draftHtml,
            companyName: finalCompany,
            styleSpec,
            font,
            templateId: effectiveTemplateId,
            resumesDir
        });

        if (existing.resume_filename && existing.resume_filename !== filename) {
            const oldPath = path.join(resumesDir, existing.resume_filename);
            try {
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            } catch (cleanupErr) {
                console.warn('Failed to remove old resume file:', cleanupErr.message);
            }
        }

        runQuery(`
      UPDATE job_applications
      SET resume_filename = ?,
          generation_status = 'ready',
          generation_error = NULL,
          updated_at = CURRENT_TIMESTAMP,
          template_id = COALESCE(?, template_id),
          font_family = COALESCE(?, font_family)
      WHERE id = ?
    `, [filename, returnedTemplateId || null, returnedFont || null, existing.id]);

        res.json({
            application_id: existing.id,
            company_name: finalCompany,
            job_role: existing.job_role || '',
            core_skills: existing.core_skills || '',
            job_url: existing.job_url || '',
            resume_filename: filename,
            resume_content: draftHtml,
            resume_html: draftHtml,
            status: existing.status,
            template_id: returnedTemplateId || existing.template_id || null,
            font_family: returnedFont || existing.font_family || 'Arial',
            generation_status: 'ready',
            validation,
            is_draft: false,
            is_finalized: true
        });
    } catch (error) {
        console.error('Finalize resume error:', error);
        res.status(500).json({ error: error.message || 'Failed to finalize resume' });
    }
});

// POST /api/user/generate-cover-letter - Generate cover letter with AI
router.post('/generate-cover-letter', async (req, res) => {
    try {
        const { profile_id, job_description, resume_html, company_name: providedCompany } = req.body;

        if (!profile_id || !job_description) {
            return res.status(400).json({ error: 'Profile ID and job description are required' });
        }

        const profile = getAccessibleProfile(profile_id, req);

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found or not assigned to you' });
        }

        // Generate cover letter (passes providedCompany through so filename includes it)
        const result = await generateCoverLetter(profile, job_description, resume_html || '', providedCompany);

        // Save DOCX file
        const fname = result.filename;
        const fpath = path.join(resumesDir, fname);
        fs.writeFileSync(fpath, result.coverLetterDocx);

        res.json({
            cover_letter_text: result.coverLetterText,
            cover_letter_filename: fname,
            company_name: result.companyName
        });
    } catch (error) {
        console.error('Generate cover letter error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate cover letter' });
    }
});

// ==================== JOB APPLICATIONS ====================

// GET /api/user/applications/:profileId - Get applications for a profile (paginated)
router.get('/applications/:profileId', (req, res) => {
    try {
        const { profileId } = req.params;

        // Verify user has access to this profile (admins may view any)
        const hasAccess = userIsAdmin(req)
            || getOne(`
      SELECT 1 as access FROM user_profile_assignments
      WHERE profile_id = ? AND user_id = ?
    `, [parseInt(profileId), req.user.id]);

        if (!hasAccess) {
            return res.status(403).json({ error: 'Access denied to this profile' });
        }

        // Pagination params: ?page=1&limit=20&status=&company=&role=&start_date=&end_date=
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
        const offset = (page - 1) * limit;

        // Optional server-side filters (case-insensitive contains for text fields)
        const filters = [];
        const filterParams = [parseInt(profileId)];
        const applyFilter = (column, value) => {
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                filters.push(`LOWER(a.${column}) LIKE ?`);
                filterParams.push('%' + String(value).toLowerCase().trim() + '%');
            }
        };
        applyFilter('company_name', req.query.company);
        applyFilter('job_role', req.query.role);
        if (req.query.content && String(req.query.content).trim()) {
            const term = '%' + String(req.query.content).toLowerCase().trim() + '%';
            filters.push(`(
                LOWER(a.company_name) LIKE ? OR
                LOWER(a.job_role) LIKE ? OR
                LOWER(COALESCE(a.job_description, '')) LIKE ? OR
                LOWER(COALESCE(a.core_skills, '')) LIKE ? OR
                LOWER(COALESCE(a.job_url, '')) LIKE ?
            )`);
            filterParams.push(term, term, term, term, term);
        }
        if (req.query.jd && String(req.query.jd).trim()) {
            const term = '%' + String(req.query.jd).toLowerCase().trim() + '%';
            filters.push(`LOWER(COALESCE(a.job_description, '')) LIKE ?`);
            filterParams.push(term);
        }
        const urlRaw = req.query.url || req.query.link;
        if (urlRaw && String(urlRaw).trim()) {
            const term = '%' + String(urlRaw).toLowerCase().trim() + '%';
            filters.push(`LOWER(COALESCE(a.job_url, '')) LIKE ?`);
            filterParams.push(term);
        }
        if (req.query.status && req.query.status !== 'all') {
            filters.push('a.status = ?');
            filterParams.push(String(req.query.status).trim());
        }
        if (req.query.start_date) {
            filters.push('DATE(a.created_at) >= DATE(?)');
            filterParams.push(String(req.query.start_date).trim());
        }
        if (req.query.end_date) {
            filters.push('DATE(a.created_at) <= DATE(?)');
            filterParams.push(String(req.query.end_date).trim());
        }
        const whereExtra = filters.length ? ' AND ' + filters.join(' AND ') : '';

        // Total count for pagination metadata
        const countRow = getOne(
            `SELECT COUNT(*) as total
             FROM job_applications a
             WHERE a.profile_id = ?${whereExtra}`,
            filterParams
        );
        const total = countRow?.total || 0;

        // Fetch the requested page
        const applications = getAll(`
      SELECT a.*,
        (SELECT GROUP_CONCAT(DISTINCT u.username)
         FROM user_profile_assignments upa
         JOIN users u ON upa.user_id = u.id
         WHERE upa.profile_id = a.profile_id) as assigned_users
      FROM job_applications a
      WHERE a.profile_id = ?${whereExtra}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?
    `, [...filterParams, limit, offset]);

        // Decorate each row with the *latest* milestone (used by the
        // table's "current status" pill) and the admin-managed `state`
        // column so the user table can show "Completed", "Cancelled",
        // "Rejected" badges without an N+1 query.
        const latestByAppId = getLatestMilestonesForApplications(
            applications.map((a) => a.id)
        );
        for (const app of applications) {
            const m = latestByAppId.get(app.id) || null;
            app.latest_milestone = m
                ? {
                    id: m.id,
                    kind: m.kind,
                    label: m.label,
                    scheduled_at: m.scheduled_at,
                    completed_at: m.completed_at,
                    notes: m.notes,
                    recruiter_message: m.recruiter_message,
                    reply_message: m.reply_message,
                    interview_link: m.interview_link,
                    ai_interview_detail: m.ai_interview_detail
                }
                : null;
            // Default the admin-owned state at read-time for legacy rows
            // that pre-date the migration.
            app.state = app.state || 'in_progress';
        }

        res.json({
            applications,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasNext: page * limit < total,
                hasPrev: page > 1
            }
        });
    } catch (error) {
        console.error('Get applications error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/applications/by-filename/:filename - Look up an application by its resume filename
router.get('/applications/by-filename/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const application = getOne(`
      SELECT a.* FROM job_applications a
      JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
      WHERE a.resume_filename = ? AND ua.user_id = ?
      ORDER BY a.id DESC LIMIT 1
    `, [filename, req.user.id]);

        if (!application) {
            return res.status(404).json({ error: 'Application not found for that resume filename' });
        }
        res.json(application);
    } catch (error) {
        console.error('Lookup by filename error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// GET /api/user/stats - Get user's application statistics across time periods
router.get('/stats', (req, res) => {
    try {
        const payload = buildStatsResponse(req, 'user');
        res.json(payload);
    } catch (error) {
        console.error('Get user stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/user/applications/:id - Update application status
// Users can move a row through the lifecycle `pending → applied →
// interview` and they can also flag a job as `rejected` from the
// resume generator's Reject action — that lets the user say "this
// job isn't valid for me" without an admin round-trip. The reject
// reason is stamped on `reject_reason` so the audit trail captures
// why the user dropped the application.
//
// The *terminal* state column (`state` — completed / cancelled /
// rejected) remains admin-only. The user-side `status = 'rejected'`
// is purely informational; admins can still re-open the row by
// flipping `state` back to `in_progress`.
router.patch('/applications/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { status, reject_reason } = req.body;

        // Accept `rejected` so the resume generator's Reject action
        // works — the user explicitly wants to mark the application
        // as not valid without admin help.
        const ALLOWED = ['pending', 'applied', 'interview', 'rejected'];
        if (!status || !ALLOWED.includes(status)) {
            return res.status(400).json({
                error:
                    'Valid status is required (pending, applied, interview, rejected). ' +
                    'Terminal state transitions are admin-only.'
            });
        }

        // Verify user has access to this application's profile
        const application = getOne(`
      SELECT a.* FROM job_applications a
      JOIN user_profile_assignments ua ON a.profile_id = ua.profile_id
      WHERE a.id = ? AND ua.user_id = ?
    `, [parseInt(id), req.user.id]);

        if (!application) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        // Refuse changes once the admin has locked the row to a
        // terminal state.
        if (application.state && application.state !== 'in_progress') {
            return res.status(409).json({
                error: `Application is ${application.state}; only an admin can change it from this state.`
            });
        }

        // Build dynamic update based on status and supplied fields
        const updates = ['status = ?', 'updated_at = CURRENT_TIMESTAMP'];
        const params = [status];

        if (status === 'applied') {
            // Stamp the current user as the one who applied this job
            updates.push('applier_id = ?');
            params.push(req.user.id);
        }
        if (status === 'rejected') {
            // Save the user's reject reason alongside `status`. We
            // store it on the same column the admin's `state =
            // 'rejected'` flow writes to so the "Unavailable" badge
            // tooltip on the lookup result picks it up uniformly.
            updates.push('reject_reason = ?');
            params.push((reject_reason || '').trim() || null);
            // Rejecting clears `applier_id` so subsequent admin /
            // re-apply flows don't credit a previous user.
            updates.push('applier_id = NULL');
        }

        params.push(parseInt(id));

        runQuery(`
      UPDATE job_applications
      SET ${updates.join(', ')}
      WHERE id = ?
    `, params);

        const updated = getOne('SELECT * FROM job_applications WHERE id = ?', [parseInt(id)]);
        try {
            const bidCourseService = require('../services/bidCourseService');
            if (status === 'applied') {
                bidCourseService.recordMarkApplied({
                    applicationId: parseInt(id, 10),
                    userId: req.user.id
                });
            } else if (status === 'rejected') {
                bidCourseService.recordRejected({
                    applicationId: parseInt(id, 10),
                    userId: req.user.id,
                    reason: reject_reason
                });
            } else if (status === 'interview') {
                bidCourseService.recordInterviewMilestone({
                    applicationId: parseInt(id, 10),
                    kind: 'status_interview',
                    label: 'Status set to interview'
                });
            }
        } catch (courseErr) {
            console.warn('[bid-course] status update log failed:', courseErr.message);
        }
        res.json(updated);
    } catch (error) {
        console.error('Update application error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ==================== INTERVIEW REQUESTS (user side) ====================
//
// The interview-request lifecycle lets the user track the moment a
// recruiter gets back to them, record what was said, and capture the
// interview details (date/time/type/etc.) when the recruiter sends an
// invite.
//
// Lifecycle:
//   requested → scheduled → completed
//                      ↘ cancelled
//
// Each application has at most ONE interview_requests row (UNIQUE on
// application_id). All endpoints verify the requesting user has access
// to the application via user_profile_assignments.

// GET /api/user/interview-requests - List this user's interview-requests
router.get('/interview-requests', (req, res) => {
    try {
        const rows = getAll(`
            SELECT
                ir.*,
                a.company_name,
                a.job_role,
                a.job_url,
                a.job_description,
                a.resume_filename AS application_resume_filename,
                a.core_skills,
                a.status AS application_status,
                p.first_name,
                p.last_name,
                p.first_name || ' ' || p.last_name AS profile_name,
                (SELECT GROUP_CONCAT(DISTINCT u2.username)
                 FROM user_profile_assignments upa2
                 JOIN users u2 ON upa2.user_id = u2.id
                 WHERE upa2.profile_id = a.profile_id) AS assigned_users
            FROM interview_requests ir
            JOIN job_applications a ON a.id = ir.application_id
            JOIN candidate_profiles p ON p.id = a.profile_id
            JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
            WHERE ua.user_id = ?
            ORDER BY ir.updated_at DESC
        `, [req.user.id]);
        res.json(rows);
    } catch (error) {
        console.error('List interview-requests error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/developer/assigned-requests - List interview requests
// assigned to the current developer (assigned_developer_id = me). This
// is the developer-side counterpart of /api/user/interview-requests —
// it doesn't filter on the user_profile_assignments join because the
// developer may not be assigned to the underlying profile; they're
// only assigned to the interview_request itself.
//
// Returns rows in the same shape as the admin /interview-requests list
// so the developer-side UI can reuse the admin components (status
// badge, milestone accordion, etc.).
router.get('/developer/assigned-requests', (req, res) => {
    try {
        const rows = getAll(`
            SELECT
                ir.*,
                a.company_name,
                a.job_role,
                a.job_url,
                a.job_description,
                a.resume_filename AS application_resume_filename,
                a.core_skills,
                a.success_flag AS application_success_flag,
                a.failed_flag AS application_failed_flag,
                a.cancelled_flag AS application_cancelled_flag,
                a.status AS application_status,
                p.first_name,
                p.last_name,
                p.first_name || ' ' || p.last_name AS profile_name,
                (SELECT GROUP_CONCAT(DISTINCT u2.username)
                 FROM user_profile_assignments upa2
                 JOIN users u2 ON upa2.user_id = u2.id
                 WHERE upa2.profile_id = a.profile_id) AS assigned_users,
                -- Who assigned this interview to me (admin who set
                -- assigned_developer_id). Surface as a separate column
                -- so the UI can show "assigned by X".
                assigner.username AS assigned_by_username,
                -- Latest milestone kind + scheduled time so the
                -- developer dashboard can filter by interview type
                -- and date WITHOUT round-tripping for milestones on
                -- every row. Mirrors getLatestMilestone() but inline
                -- here so we keep the assigned-requests list to a
                -- single query.
                (SELECT kind FROM interview_milestones
                 WHERE interview_request_id = ir.id
                 ORDER BY position DESC, id DESC LIMIT 1)
                    AS latest_milestone_kind,
                (SELECT scheduled_at FROM interview_milestones
                 WHERE interview_request_id = ir.id
                 ORDER BY position DESC, id DESC LIMIT 1)
                    AS latest_milestone_scheduled_at,
                (SELECT completed_at FROM interview_milestones
                 WHERE interview_request_id = ir.id
                 ORDER BY position DESC, id DESC LIMIT 1)
                    AS latest_milestone_completed_at
            FROM interview_requests ir
            JOIN job_applications a ON a.id = ir.application_id
            JOIN candidate_profiles p ON p.id = a.profile_id
            LEFT JOIN users assigner ON assigner.id = (
                SELECT flags_set_by FROM job_applications WHERE id = a.id
            )
            WHERE ir.assigned_developer_id = ?
            ORDER BY
                CASE WHEN ir.status IN ('requested', 'scheduled') THEN 0 ELSE 1 END,
                ir.updated_at DESC
        `, [req.user.id]);

        // Auto-compute the "expired" flag per row. A row is expired
        // when its latest milestone is NOT completed AND its scheduled
        // time is in the past. The DB stores `scheduled_at` verbatim
        // (the picker value, no timezone conversion), so to compare
        // against "now" we treat both as the SAME wall-clock frame:
        // the server's local time. This keeps the comparison stable
        // regardless of how the value was originally entered.
        const nowMs = Date.now();
        const decorated = rows.map((r) => {
            let isExpired = false;
            const sched = r.latest_milestone_scheduled_at;
            const completed = r.latest_milestone_completed_at;
            if (sched && !completed) {
                const schedMs = new Date(sched).getTime();
                if (!Number.isNaN(schedMs) && schedMs < nowMs) {
                    isExpired = true;
                }
            }
            return { ...r, latest_milestone_expired: isExpired };
        });

        res.json(decorated);
    } catch (error) {
        console.error('List assigned dev requests error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/developer/assigned-requests/summary - Lightweight
// counts so the developer dashboard can show KPI tiles without
// pulling the full row set. Counts grouped by status.
router.get('/developer/assigned-requests/summary', (req, res) => {
    try {
        const counts = getOne(
            `SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN ir.status = 'requested' THEN 1 ELSE 0 END) AS requested,
                SUM(CASE WHEN ir.status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
                SUM(CASE WHEN ir.status = 'completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN ir.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
             FROM interview_requests ir
             WHERE ir.assigned_developer_id = ?`,
            [req.user.id]
        ) || {};
        res.json({
            total: Number(counts.total || 0),
            requested: Number(counts.requested || 0),
            scheduled: Number(counts.scheduled || 0),
            completed: Number(counts.completed || 0),
            cancelled: Number(counts.cancelled || 0)
        });
    } catch (error) {
        console.error('Dev summary error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/developer/profile - The developer's own profile.
// Returns the editable fields: technical_skills, availability,
// developer_resume (filename), contact_email, contact_whatsapp,
// contact_phone, contact_telegram. The developer is the only person
// who can read/write this — admins get their own dashboard view of
// the same data via a separate endpoint.
router.get('/developer/profile', (req, res) => {
    try {
        const u = getOne(
            `SELECT id, username, role,
                    technical_skills, availability, developer_resume,
                    contact_email, contact_whatsapp, contact_phone, contact_telegram
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        if (!u) return res.status(404).json({ error: 'User not found' });
        res.json(u);
    } catch (error) {
        console.error('Get dev profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/user/developer/profile - Update the developer's profile.
// Email + Telegram are mandatory when the developer fills out the
// form for the first time; the rest (whatsapp, phone, technical
// skills, availability) are optional. Resume filename is set via the
// dedicated upload endpoint below so multipart boundaries stay out
// of this JSON path.
router.put('/developer/profile', (req, res) => {
    try {
        const body = req.body || {};
        // Coerce missing/empty strings to NULL so the DB doesn't
        // store empty strings alongside real values.
        const trimOrNull = (v) => {
            if (v === null || v === undefined) return null;
            const t = String(v).trim();
            return t === '' ? null : t;
        };
        const email = trimOrNull(body.contact_email);
        const telegram = trimOrNull(body.contact_telegram);
        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }
        if (!telegram) {
            return res.status(400).json({ error: 'Telegram handle is required' });
        }
        runQuery(
            `UPDATE users SET
                technical_skills = ?,
                availability = ?,
                contact_email = ?,
                contact_whatsapp = ?,
                contact_phone = ?,
                contact_telegram = ?
             WHERE id = ?`,
            [
                trimOrNull(body.technical_skills),
                trimOrNull(body.availability),
                email,
                trimOrNull(body.contact_whatsapp),
                trimOrNull(body.contact_phone),
                telegram,
                req.user.id
            ]
        );
        const updated = getOne(
            `SELECT id, username, role,
                    technical_skills, availability, developer_resume,
                    contact_email, contact_whatsapp, contact_phone, contact_telegram
             FROM users WHERE id = ?`,
            [req.user.id]
        );
        res.json(updated);
    } catch (error) {
        console.error('Update dev profile error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/user/developer/profile/resume - Upload the developer's
// resume (markdown/text). The original filename is preserved on
// `users.developer_resume` so the dashboard can serve it via the
// existing /resumes/<file> static route the same way user-resumes
// are served. Old files are removed when a new one replaces them.
router.post('/developer/profile/resume', (req, res) => {
    try {
        const body = req.body || {};
        const filename = (body.filename || '').trim();
        const content = body.content || '';
        if (!filename) {
            return res.status(400).json({ error: 'filename is required' });
        }
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: 'content is required' });
        }
        // Sanitize the filename so a malicious value can't escape
        // the resumes/ directory. We only allow the basename + a
        // single trailing .md (or similar) extension.
        const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (!safe || safe.startsWith('.') || safe.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        // Stamp the filename with the user id + timestamp so
        // concurrent developers never overwrite each other's files.
        const finalName = `dev_${req.user.id}_${Date.now()}_${safe}`;
        const { RESUMES_DIR: resumesDir } = require('../config/paths');
        if (!fs.existsSync(resumesDir)) fs.mkdirSync(resumesDir, { recursive: true });
        fs.writeFileSync(path.join(resumesDir, finalName), content, 'utf8');

        // Remove the old resume file (if any) so we don't leak
        // abandoned uploads on disk.
        const prev = getOne(`SELECT developer_resume FROM users WHERE id = ?`, [req.user.id]);
        if (prev && prev.developer_resume && prev.developer_resume !== finalName) {
            const oldPath = path.join(resumesDir, prev.developer_resume);
            if (fs.existsSync(oldPath)) {
                try { fs.unlinkSync(oldPath); } catch (_) { /* ignore */ }
            }
        }
        runQuery(`UPDATE users SET developer_resume = ? WHERE id = ?`, [finalName, req.user.id]);
        res.json({ filename: finalName });
    } catch (error) {
        console.error('Upload dev resume error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/interview-requests/:applicationId - Single record for an app
router.get('/interview-requests/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const application = getOne(`
            SELECT a.* FROM job_applications a
            JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
            WHERE a.id = ? AND ua.user_id = ?
        `, [applicationId, req.user.id]);
        if (!application) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        const row = getOne(`SELECT * FROM interview_requests WHERE application_id = ?`, [applicationId]);
        res.json(row || null);
    } catch (error) {
        console.error('Get interview-request error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/user/interview-requests - Create or replace the request for an app.
//
// Body:
//   application_id    : number  (required)
//   recruiter_reply   : string  (optional)
//   status            : 'requested' | 'scheduled' | 'completed' | 'cancelled'
//                                (optional; default 'requested' if not provided,
//                                 required if interview fields are supplied)
//   interview_type / scheduled_date / scheduled_time / timezone /
//   interviewer_name / location / meeting_link / user_notes :
//                      optional. When supplied alongside status='scheduled'
//                      they're stored on the request row.
//
// Status transition rules enforced server-side:
//   - First write must be 'requested' or 'scheduled'
//   - 'requested' can advance to 'scheduled', 'completed', or 'cancelled'
//   - 'scheduled' can advance to 'completed' or 'cancelled' (no going back)
//   - 'completed' / 'cancelled' are terminal
router.post('/interview-requests', (req, res) => {
    try {
        const {
            application_id: appIdRaw,
            status,
            recruiter_reply,
            interview_type,
            scheduled_date,
            scheduled_time,
            timezone,
            interviewer_name,
            location,
            meeting_link,
            user_notes,
            requested_time,
            expire_time,
            // `reply_channel` was removed from the API contract; the
            // channel is now encoded as a milestone kind when the reply
            // lands. We accept (and silently ignore) the field so old
            // clients don't break, but nothing is persisted here.
            reply_channel
        } = req.body || {};

        const application_id = parseInt(appIdRaw);
        if (!application_id) {
            return res.status(400).json({ error: 'application_id is required' });
        }

        // Channel is fully derived from the milestone kind now; the
        // legacy `cleanReplyChannel` variable is intentionally a no-op
        // shim so the rest of the function continues to work.
        const cleanReplyChannel = null;

        // Verify user has access to the application
        const application = getOne(`
            SELECT a.* FROM job_applications a
            JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
            WHERE a.id = ? AND ua.user_id = ?
        `, [application_id, req.user.id]);
        if (!application) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        // Sanity-check the request lifecycle timestamps. Both are optional,
        // but when both are supplied expire_time must be strictly later
        // than requested_time — otherwise the request has already expired
        // the moment it was filed.
        const toIsoOrNull = (v) => {
            if (v === undefined || v === null || v === '') return null;
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? null : d.toISOString();
        };
        const requestedIso = toIsoOrNull(requested_time);
        const expireIso    = toIsoOrNull(expire_time);
        if (requested_time && requestedIso === null) {
            return res.status(400).json({ error: 'requested_time is not a valid datetime' });
        }
        if (expire_time && expireIso === null) {
            return res.status(400).json({ error: 'expire_time is not a valid datetime' });
        }
        if (requestedIso && expireIso && new Date(expireIso) <= new Date(requestedIso)) {
            return res.status(400).json({
                error: 'expire_time must be later than requested_time'
            });
        }

        const existing = getOne(
            `SELECT * FROM interview_requests WHERE application_id = ?`,
            [application_id]
        );

        const allowed = ['requested', 'scheduled', 'completed', 'cancelled'];

        let nextStatus = (status || 'requested').toString().toLowerCase();
        if (!allowed.includes(nextStatus)) {
            return res.status(400).json({
                error: `status must be one of: ${allowed.join(', ')}`
            });
        }

        // When moving to 'scheduled' from the user UI, interview detail
        // columns are expected to be supplied. Make scheduled_date + time
        // required so the admin side has a complete record.
        if (nextStatus === 'scheduled' && (!scheduled_date || !scheduled_time)) {
            return res.status(400).json({
                error: 'scheduled_date and scheduled_time are required when status is "scheduled"'
            });
        }

        if (!existing) {
            // First write — must be 'requested' or 'scheduled'
            if (!['requested', 'scheduled'].includes(nextStatus)) {
                return res.status(400).json({
                    error: 'The first interview-request row must be "requested" or "scheduled"'
                });
            }

            // Default requested_time to "now" when this is the first row
            // and the client didn't supply an explicit value.
            const initialRequestedIso = requestedIso || new Date().toISOString();

            runQuery(`
                INSERT INTO interview_requests (
                    application_id, status, recruiter_reply, recruiter_reply_at,
                    interview_type, scheduled_date, scheduled_time, timezone,
                    interviewer_name, location, meeting_link, user_notes,
                    reply_channel,
                    requested_time, expire_time,
                    created_by
                ) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                application_id,
                nextStatus,
                recruiter_reply || null,
                interview_type || null,
                scheduled_date || null,
                scheduled_time || null,
                timezone || null,
                interviewer_name || null,
                location || null,
                meeting_link || null,
                user_notes || null,
                cleanReplyChannel,
                initialRequestedIso,
                expireIso,
                req.user.id
            ]);
        } else {
            // Transition rules
            const transitions = {
                requested: ['scheduled', 'completed', 'cancelled'],
                scheduled: ['completed', 'cancelled'],
                completed: [],
                cancelled: []
            };
            if (nextStatus !== existing.status &&
                !transitions[existing.status].includes(nextStatus)) {
                return res.status(400).json({
                    error: `Cannot transition interview-request from "${existing.status}" to "${nextStatus}"`
                });
            }

            // `recruiter_reply_clear` lets the frontend explicitly clear
            // a previously-saved reply (we can't distinguish "" from
            // "field omitted" in JSON without a sentinel).
            const recruiterReplyClear = req.body?.recruiter_reply_clear === true;
            const newReplyValue = recruiterReplyClear
                ? null
                : (recruiter_reply === undefined || recruiter_reply === null || recruiter_reply === ''
                    ? null
                    : String(recruiter_reply).trim() || null);

            runQuery(`
                UPDATE interview_requests
                SET status = ?,
                    recruiter_reply = ?,
                    recruiter_reply_at = CASE
                        WHEN ? IS NOT NULL AND ? <> '' THEN CURRENT_TIMESTAMP
                        WHEN ? THEN NULL
                        ELSE recruiter_reply_at
                    END,
                    interview_type = COALESCE(?, interview_type),
                    scheduled_date = COALESCE(?, scheduled_date),
                    scheduled_time = COALESCE(?, scheduled_time),
                    timezone = COALESCE(?, timezone),
                    interviewer_name = COALESCE(?, interviewer_name),
                    location = COALESCE(?, location),
                    meeting_link = COALESCE(?, meeting_link),
                    user_notes = COALESCE(?, user_notes),
                    reply_channel = COALESCE(?, reply_channel),
                    requested_time = COALESCE(?, requested_time),
                    expire_time = COALESCE(?, expire_time),
                    updated_at = CURRENT_TIMESTAMP
                WHERE application_id = ?
            `, [
                nextStatus,
                newReplyValue,
                // recruiter_reply_at CASE params: (1) the new value, (2) the
                // "non-empty" sentinel, (3) the clear flag.
                newReplyValue,
                newReplyValue,
                recruiterReplyClear ? 1 : 0,
                interview_type || null,
                scheduled_date || null,
                scheduled_time || null,
                timezone || null,
                interviewer_name || null,
                location || null,
                meeting_link || null,
                user_notes || null,
                cleanReplyChannel,
                requestedIso,
                expireIso,
                application_id
            ]);
        }

        // Mirror a copy of the recruiter reply on job_applications for
        // simple visibility (e.g. in the admin applications listing) and
        // keep the application status in sync with the interview-request
        // status. We only bump it forward (never backwards).
        if (recruiter_reply) {
            runQuery(
                `UPDATE job_applications
                 SET recruiter_reply = ?, recruiter_reply_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [recruiter_reply, application_id]
            );
        }
        if (nextStatus === 'scheduled' || (nextStatus === 'completed' && existing?.status !== 'completed')) {
            runQuery(
                `UPDATE job_applications SET status = 'interview' WHERE id = ?`,
                [application_id]
            );
        } else if (nextStatus === 'cancelled' && application.status === 'interview' && !existing) {
            runQuery(
                `UPDATE job_applications SET status = 'pending' WHERE id = ?`,
                [application_id]
            );
        }

        const row = getOne(
            `SELECT * FROM interview_requests WHERE application_id = ?`,
            [application_id]
        );

        // Note: the legacy "syncReplyMilestone" + "appendLifecycleMilestone"
        // helpers were retired in the 2026-07 milestone rewrite — the new
        // flow doesn't auto-append synthetic milestones, so this is a no-op.
        // The recruiter reply still lives on the request row for legacy
        // UIs to display.

        res.status(existing ? 200 : 201).json(row);
    } catch (error) {
        console.error('Upsert interview-request error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PATCH /api/user/interview-requests/:applicationId/status - Convenience
// status-only transition (used by the UI status pill).
//
// The user can move the request to any of the 4 statuses, including
// re-opening `completed` or `cancelled` (so a user can correct a typo
// after the fact). The status pill only offers the natural transitions,
// but the API accepts any of the four values.
router.patch('/interview-requests/:applicationId/status', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const { status } = req.body || {};
        if (!status) {
            return res.status(400).json({ error: 'status is required' });
        }

        const application = getOne(`
            SELECT a.* FROM job_applications a
            JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
            WHERE a.id = ? AND ua.user_id = ?
        `, [applicationId, req.user.id]);
        if (!application) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        const existing = getOne(
            `SELECT * FROM interview_requests WHERE application_id = ?`,
            [applicationId]
        );
        if (!existing) {
            return res.status(404).json({
                error: 'No interview-request exists for this application yet. Use POST /interview-requests first.'
            });
        }

        const allowed = ['requested', 'scheduled', 'completed', 'cancelled'];
        if (!allowed.includes(status)) {
            return res.status(400).json({
                error: `status must be one of: ${allowed.join(', ')}`
            });
        }

        runQuery(
            `UPDATE interview_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE application_id = ?`,
            [status, applicationId]
        );

        if (status === 'scheduled' || status === 'completed') {
            runQuery(
                `UPDATE job_applications SET status = 'interview' WHERE id = ?`,
                [applicationId]
            );
        }

        // Note: legacy "appendLifecycleMilestone" helper retired in the
        // 2026-07 milestone rewrite — status transitions are tracked on
        // the interview_requests row directly. Admins record final
        // outcomes via the success/failed flags on the application.

        const row = getOne(
            `SELECT * FROM interview_requests WHERE application_id = ?`,
            [applicationId]
        );
        res.json(row);
    } catch (error) {
        console.error('Update interview-request status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================
// Milestone workflow (rewritten 2026-07)
// =============================================================
// The new workflow:
//
//   - The first milestone a user adds auto-creates the interview_request
//     row (status='requested'). That's what surfaces the application in
//     the admin Interview Requests dashboard.
//   - Subsequent milestones can only be added once the previous one is
//     marked completed. The completion flag is restricted to admin and
//     the developer assigned to the application — regular users can
//     only add new milestones.
//   - The user's picker returns timestamps as GMT-4 wall-clock strings
//     (yyyy-MM-ddTHH:mm); we convert to UTC ISO via
//     localPickerToUTCIso before storing.

function getRequestForApplication(applicationId, userId) {
    // Confirms the application is reachable for the caller AND fetches
    // the interview-request row. Access is granted when ANY of:
    //   - the caller owns the application via user_profile_assignments
    //     (the regular user / caller path)
    //   - the caller is the developer assigned to the application's
    //     interview_request (the developer-dashboard path)
    //   - the caller is an admin (handled separately via getUserRoles)
    // Returns null when none of the above match.
    const application = getOne(`
        SELECT a.* FROM job_applications a
        LEFT JOIN user_profile_assignments ua
            ON ua.profile_id = a.profile_id AND ua.user_id = ?
        LEFT JOIN interview_requests ir
            ON ir.application_id = a.id
        WHERE a.id = ?
          AND (ua.user_id IS NOT NULL OR ir.assigned_developer_id = ?)
    `, [userId, applicationId, userId]);
    if (!application) return null;
    const request = getOne(
        `SELECT * FROM interview_requests WHERE application_id = ?`,
        [applicationId]
    );
    return { application, request };
}

// Validate / sanitise the user's milestone add payload. We accept either
// ISO timestamps or GMT-4 picker strings for `scheduled_at`; both end
// up in the DB as ISO-8601 UTC. Legacy field names (`notes`,
// `recruiter_message`, etc.) are aliased to their new columns so older
// clients still work — the new canonical name is `memo` (a free-form
// detail blob capturing meeting link, recruiter message, etc.).
//
// Each text detail field is trimmed; an empty / whitespace-only value
// becomes NULL so the column genuinely reflects "no detail captured"
// rather than an empty string. The four per-milestone detail fields
// (`recruiter_message`, `reply_message`, `interview_link`,
// `ai_interview_detail`) are forwarded to the service layer so the
// user-side Add-Milestone form can persist the full detail block in
// a single round-trip — previously they were silently dropped, which
// is why the modal showed empty after the user saved an interview
// link / recruiter message.
function cleanMilestoneAddInput(body) {
    const out = {};
    if ('kind' in body) {
        const k = String(body.kind || '').trim();
        out.kind = MILESTONE_KINDS.includes(k) ? k : 'other';
    } else {
        out.kind = 'other';
    }
    if ('label' in body && body.label != null) {
        out.label = String(body.label).trim() || null;
    }
    // Memo accepts either the new `memo` field or the legacy `notes`
    // (the 2026-07 rewrite renamed the column to `memo`).
    const memoRaw = ('memo' in body) ? body.memo : body.notes;
    if (memoRaw != null) {
        out.memo = String(memoRaw).trim() || null;
    }
    if ('scheduled_at' in body) {
        const v = body.scheduled_at;
        if (v === null || v === undefined || v === '') {
            out.scheduled_at = null;
        } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
            // Picker string. The user wants the picked value stored
            // verbatim — `localPickerToUTCIso` now just pads seconds
            // and returns the string as-is, no UTC conversion.
            const iso = localPickerToUTCIso(v);
            out.scheduled_at = iso || null;
        } else {
            // Anything else — save verbatim, no timezone interpretation.
            out.scheduled_at = String(v);
        }
    } else {
        out.scheduled_at = null;
    }
    // Per-milestone detail fields. The client-side MilestoneList
    // sends these in the same payload as `kind` / `label` /
    // `scheduled_at` / `memo` so the user can capture full context
    // (recruiter DMs, link paste, AI screener notes) in one shot.
    // Each one is sanitised here so an empty string never overwrites
    // an existing value with garbage.
    const detailString = (v) => {
        if (v == null) return null;
        const t = String(v).trim();
        return t ? t : null;
    };
    if ('recruiter_message' in body) {
        out.recruiter_message = detailString(body.recruiter_message);
    }
    if ('reply_message' in body) {
        out.reply_message = detailString(body.reply_message);
    }
    if ('interview_link' in body) {
        out.interview_link = detailString(body.interview_link);
    }
    if ('ai_interview_detail' in body) {
        out.ai_interview_detail = detailString(body.ai_interview_detail);
    }
    return out;
}

// GET /api/user/milestones/:applicationId - List milestones + summary.
// Returns { milestones: [...], summary: {total, completed, current}, request }
router.get('/milestones/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const ctx = getRequestForApplication(applicationId, req.user.id);
        if (!ctx) return res.status(404).json({ error: 'Application not found or access denied' });

        const milestones = listMilestonesForApplication(applicationId);
        const summary = summariseMilestones(milestones);
        res.json({
            milestones,
            summary,
            request: ctx.request || null,
            kinds: MILESTONE_KINDS,
            kind_labels: MILESTONE_KIND_LABELS
        });
    } catch (error) {
        console.error('List milestones error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/user/milestones/:applicationId - Add a milestone.
// Auto-creates the parent interview_request on the first add. Subsequent
// adds require the previous milestone to be completed (enforced by the
// `userCanCompleteMilestone` check on the latest non-completed row).
router.post('/milestones/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const ctx = getRequestForApplication(applicationId, req.user.id);
        if (!ctx) return res.status(404).json({ error: 'Application not found or access denied' });

        // Get-or-create the parent request (this is what surfaces the
        // app to admin as an Interview Request on the FIRST milestone).
        const request = ctx.request || getOrCreateRequestForApplication(applicationId, req.user.id);

        const existingMilestones = listMilestonesForRequest(request.id);
        const lastUncompleted = existingMilestones.find((m) => !m.completed_at);
        if (lastUncompleted) {
            return res.status(400).json({
                error: 'Previous milestone must be completed before adding a new one.',
                blocking_milestone_id: lastUncompleted.id
            });
        }

        const clean = cleanMilestoneAddInput(req.body || {});
        const created = svcAddMilestone({
            requestId: request.id,
            kind: clean.kind,
            label: clean.label,
            scheduledAt: clean.scheduled_at,
            memo: clean.memo,
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
            console.warn('[bid-course] interview milestone log failed:', courseErr.message);
        }

        const decorated = {
            ...created,
            kind_label: labelForKind(created.kind),
            scheduled_at_display: created.scheduled_at ? new Date(created.scheduled_at).toISOString() : '',
            completed_at_display: ''
        };

        res.status(201).json({
            milestone: decorated,
            request_id: request.id,
            summary: summariseMilestones([...existingMilestones, decorated])
        });
    } catch (error) {
        console.error('Add milestone error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// POST /api/user/milestones/:applicationId/complete - Mark current milestone done.
// Permission rules:
//   - admin                  : can complete ANY milestone kind
//   - assigned developer     : can complete only the kinds in
//                              DEVELOPER_COMPLETABLE_KINDS
//   - regular user / caller  : cannot complete anything
router.post('/milestones/:applicationId/complete', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);
        const ctx = getRequestForApplication(applicationId, req.user.id);
        if (!ctx) return res.status(404).json({ error: 'Application not found or access denied' });
        if (!ctx.request) return res.status(400).json({ error: 'No milestones exist yet' });

        // Find the latest non-completed milestone — that's what we'll
        // mark done. The permission check below uses its kind to decide
        // whether the developer is allowed to complete it.
        const milestones = listMilestonesForRequest(ctx.request.id);
        const current = milestones.find((m) => !m.completed_at);
        if (!current) {
            return res.status(400).json({ error: 'No in-progress milestone to complete.' });
        }

        const roles = getUserRoles(req.user.id);
        const permission = canCompleteMilestone({
            userId: req.user.id,
            userRoles: roles,
            requestId: ctx.request.id,
            milestoneKind: current.kind
        });
        if (!permission.allowed) {
            // Surface a helpful, kind-aware message so the UI can show
            // "this step is admin-only" rather than a generic 403.
            const label = labelForKind(current.kind);
            if (permission.reason === 'kind-not-developer-completable') {
                return res.status(403).json({
                    error: `"${label}" can only be marked complete by an admin.`,
                    kind: current.kind,
                    code: 'KIND_NOT_DEVELOPER_COMPLETABLE'
                });
            }
            return res.status(403).json({
                error: 'Only admin or the assigned developer can mark a milestone complete.',
                code: 'NOT_AUTHORIZED'
            });
        }

        const { completeMilestone } = require('../services/milestoneService');
        // Allow the caller to pass an actual interview timestamp and
        // optional memo so the developer can log "what happened"
        // without leaving the dashboard. Picker value is stored
        // verbatim — no timezone conversion — so what the user picked
        // is exactly what lands in the row. A missing `actual_at`
        // falls back to "now" server-side.
        const body = req.body || {};
        let actualAtValue = null;
        if (body.actual_at) {
            if (typeof body.actual_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(body.actual_at)) {
                actualAtValue = localPickerToUTCIso(body.actual_at) || String(body.actual_at);
            } else {
                actualAtValue = String(body.actual_at);
            }
        }
        const updated = completeMilestone(current.id, req.user.id, {
            actualAt: actualAtValue,
            memo: body.memo,
            durationMinutes: body.duration_minutes
        });
        res.json({
            milestone: {
                ...updated,
                kind_label: labelForKind(updated.kind),
                completed_at_display: updated.completed_at ? new Date(updated.completed_at).toISOString() : ''
            },
            summary: summariseMilestones(
                milestones.map((m) => (m.id === updated.id ? updated : m))
            )
        });
    } catch (error) {
        console.error('Complete milestone error:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

// PATCH /api/user/milestones/:id - update fields on a milestone.
// Users can update kind/label/memo/scheduled_at on a milestone they own,
// but NOT completed_at (only admin/dev can complete).
router.patch('/milestones/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const ms = getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [id]);
        if (!ms) return res.status(404).json({ error: 'Milestone not found' });

        const owns = getOne(`
            SELECT 1 FROM interview_milestones m
            JOIN interview_requests ir ON ir.id = m.interview_request_id
            JOIN job_applications a ON a.id = ir.application_id
            LEFT JOIN user_profile_assignments ua
                ON ua.profile_id = a.profile_id AND ua.user_id = ?
            WHERE m.id = ?
              AND (ua.user_id IS NOT NULL OR ir.assigned_developer_id = ?)
        `, [req.user.id, id, req.user.id]);
        if (!owns) return res.status(404).json({ error: 'Milestone not found or access denied' });

        const clean = cleanMilestoneAddInput(req.body || {});
        const writableFields = [
            'kind',
            'label',
            'memo',
            'scheduled_at',
            // Per-milestone detail fields. Users can backfill these on
            // an existing milestone (e.g. they paste the meeting link
            // after the milestone was first added) without having to
            // delete + re-add the step.
            'recruiter_message',
            'reply_message',
            'interview_link',
            'ai_interview_detail'
        ];
        const sets = [];
        const params = [];
        for (const k of writableFields) {
            if (k in clean) {
                sets.push(`${k} = ?`);
                params.push(clean[k] ?? null);
            }
        }
        if (!sets.length) return res.json(ms);
        sets.push('updated_at = CURRENT_TIMESTAMP');
        params.push(id);
        runQuery(`UPDATE interview_milestones SET ${sets.join(', ')} WHERE id = ?`, params);
        runQuery(
            `UPDATE interview_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [ms.interview_request_id]
        );
        const updated = getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [id]);
        res.json({
            ...updated,
            kind_label: labelForKind(updated.kind)
        });
    } catch (error) {
        console.error('Update milestone error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/user/milestones/:id - Remove a milestone the user owns.
router.delete('/milestones/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const ms = getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [id]);
        if (!ms) return res.status(404).json({ error: 'Milestone not found' });

        const owns = getOne(`
            SELECT 1 FROM interview_milestones m
            JOIN interview_requests ir ON ir.id = m.interview_request_id
            JOIN job_applications a ON a.id = ir.application_id
            LEFT JOIN user_profile_assignments ua
                ON ua.profile_id = a.profile_id AND ua.user_id = ?
            WHERE m.id = ?
              AND (ua.user_id IS NOT NULL OR ir.assigned_developer_id = ?)
        `, [req.user.id, id, req.user.id]);
        if (!owns) return res.status(404).json({ error: 'Milestone not found or access denied' });

        const ok = svcDeleteMilestone(id);
        if (!ok) return res.status(404).json({ error: 'Milestone not found' });
        res.json({ message: 'Milestone deleted' });
    } catch (error) {
        console.error('Delete milestone error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =========================================================================
// Backward-compatible aliases — old `/interview-milestones/*` paths
// =========================================================================
// The 2026-07 milestone rewrite moved routes from
// `/user/interview-milestones/:applicationId` to `/user/milestones/:applicationId`.
// The canonical client (`/api/index.js`) now uses the new path; these
// aliases exist only for any browser tab / extension / cached client that
// still hits the old URL. Each alias simply re-binds the path and
// delegates to the new handler in-place so the response shape stays
// consistent. Marked deprecated — safe to delete once no traffic remains.

// GET legacy /api/user/interview-milestones/:applicationId
//     → forwards to /api/user/milestones/:applicationId
router.get('/interview-milestones/:applicationId', (req, res) => {
    req.url = `/milestones/${req.params.applicationId}`;
    router.handle(req, res);
});

// POST legacy /api/user/interview-milestones/:applicationId
router.post('/interview-milestones/:applicationId', (req, res) => {
    req.url = `/milestones/${req.params.applicationId}`;
    router.handle(req, res);
});

// PATCH legacy /api/user/interview-milestones/:id
router.patch('/interview-milestones/:id', (req, res) => {
    req.url = `/milestones/${req.params.id}`;
    router.handle(req, res);
});

// DELETE legacy /api/user/interview-milestones/:id
router.delete('/interview-milestones/:id', (req, res) => {
    req.url = `/milestones/${req.params.id}`;
    router.handle(req, res);
});

// DELETE /api/user/interview-requests/:applicationId - Remove the request row.
// Useful when the user wants to discard a stale entry. We only allow this
// when the request is still in 'requested' / 'cancelled' to avoid losing
// schedule data once it's been acted on.
router.delete('/interview-requests/:applicationId', (req, res) => {
    try {
        const applicationId = parseInt(req.params.applicationId);

        const application = getOne(`
            SELECT a.* FROM job_applications a
            LEFT JOIN user_profile_assignments ua
                ON ua.profile_id = a.profile_id AND ua.user_id = ?
            LEFT JOIN interview_requests ir
                ON ir.application_id = a.id
            WHERE a.id = ?
              AND (ua.user_id IS NOT NULL OR ir.assigned_developer_id = ?)
        `, [req.user.id, applicationId, req.user.id]);
        if (!application) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        const existing = getOne(
            `SELECT * FROM interview_requests WHERE application_id = ?`,
            [applicationId]
        );
        if (!existing) {
            return res.json({ message: 'Nothing to delete' });
        }
        if (!['requested', 'cancelled'].includes(existing.status)) {
            return res.status(400).json({
                error: `Cannot delete interview-request in status "${existing.status}". Cancel it first.`
            });
        }

        runQuery(`DELETE FROM interview_requests WHERE application_id = ?`, [applicationId]);
        res.json({ message: 'Interview-request deleted' });
    } catch (error) {
        console.error('Delete interview-request error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/user/resumes/:filename - Download resume
router.get('/resumes/:filename', (req, res) => {
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

// POST /api/user/resume-pdf - Convert the same resume HTML used for DOCX into
// a properly laid-out PDF via headless Chromium (puppeteer-core). This keeps
// the PDF visually identical to the DOCX and avoids rasterising via canvas.
//
// Accepts `template_id` and `font_family` so the PDF layout mirrors the
// DOCX that the user just generated. Falls back to the legacy hard-coded
// CSS when no spec is supplied.
router.post('/resume-pdf', async (req, res) => {
    try {
        const { resume_html, profile_id, template_id, template_source, font_family } = req.body || {};
        if (!resume_html || typeof resume_html !== 'string') {
            return res.status(400).json({ error: 'resume_html is required' });
        }
        if (!profile_id) {
            return res.status(400).json({ error: 'profile_id is required' });
        }

        const baseProfile = getAccessibleProfile(profile_id, req);

        if (!baseProfile) {
            return res.status(404).json({ error: 'Profile not found or not assigned to you' });
        }

        const profile = getOne(`
            SELECT p.id, p.preferred_template_id, COALESCE(p.preferred_template_kind, 'admin') AS preferred_template_kind
            FROM candidate_profiles p
            WHERE p.id = ?
        `, [baseProfile.id]);

        const font = (() => {
            const raw = font_family;
            if (raw === '__random__' || (typeof raw === 'string' && raw.toLowerCase() === 'random')) {
                return null;
            }
            return templateService.normaliseFontName(raw);
        })();
        const tplSource = template_source
            || (profile.preferred_template_kind === 'user' ? 'user' : 'admin');
        const providedTemplateId = template_id != null ? parseInt(template_id, 10) : null;
        const effectiveTemplateId = Number.isFinite(providedTemplateId) && providedTemplateId > 0
            ? providedTemplateId
            : (profile.preferred_template_id != null ? profile.preferred_template_id : null);

        let styleSpec;
        if (tplSource === 'user' && effectiveTemplateId) {
            let userSpec = userTemplateService.resolveStyleSpecForUser(req.user.id, effectiveTemplateId);
            if (!userSpec) {
                userSpec = userTemplateService.resolveStyleSpecAnyOwner(effectiveTemplateId);
            }
            styleSpec = userSpec || templateService.resolveStyleSpec({ templateId: null });
        } else {
            styleSpec = templateService.resolveStyleSpec({ templateId: effectiveTemplateId });
        }

        // Resolve random / missing font from the template pool (same as generate).
        let resolvedFont = font;
        if (!resolvedFont) {
            const pool = Array.isArray(styleSpec?.body?.font_pool)
                ? styleSpec.body.font_pool.map((f) => templateService.normaliseFontName(f)).filter(Boolean)
                : [];
            resolvedFont = pool[0]
                || templateService.normaliseFontName(styleSpec?.body?.font)
                || 'Arial';
        }

        const { renderResumePdfBuffer, decorateResumeHtmlForPreview } = (() => {
            const pdfSvc = require('../services/resumePdfService');
            return {
                renderResumePdfBuffer: pdfSvc.renderResumePdfBuffer,
                decorateResumeHtmlForPreview: templateRenderer.decorateResumeHtmlForPreview
            };
        })();
        const decoratedHtml = decorateResumeHtmlForPreview(resume_html);
        const pdfBuffer = await renderResumePdfBuffer({
            resumeHtml: decoratedHtml,
            styleSpec,
            font: resolvedFont
        });

        const pdfFilename = `resume_${Date.now()}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${pdfFilename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.end(pdfBuffer);
    } catch (error) {
        console.error('Resume PDF error:', error);
        res.status(500).json({ error: error.message || 'Failed to generate PDF' });
    }
});

// ==================== JOB APPLY CHAT ====================

// POST /api/user/generate-answers — draft form answers from JD + generated CV
router.post('/generate-answers', async (req, res) => {
    try {
        const {
            profile_id,
            job_description,
            resume_html,
            resume_content,
            questions,
            company_name,
            job_role,
            application_id
        } = req.body || {};

        if (!profile_id) {
            return res.status(400).json({ error: 'profile_id is required' });
        }
        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(400).json({ error: 'questions array is required' });
        }

        const profile = getAccessibleProfile(profile_id, req);

        if (!profile) {
            return res.status(404).json({ error: 'Profile not found or not assigned to you' });
        }

        let resumeHtml = resume_html || resume_content || '';
        let jobDescription = job_description || '';
        let companyName = company_name || '';
        let jobRole = job_role || '';

        if (application_id) {
            const isAdmin = userIsAdmin(req);
            const app = isAdmin
                ? getOne('SELECT a.* FROM job_applications a WHERE a.id = ?', [parseInt(application_id, 10)])
                : getOne(`
        SELECT a.*
        FROM job_applications a
        JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
        WHERE a.id = ? AND ua.user_id = ?
      `, [parseInt(application_id, 10), req.user.id]);
            if (!app) {
                return res.status(404).json({ error: 'Application not found' });
            }
            resumeHtml = resumeHtml || app.draft_html || '';
            jobDescription = jobDescription || app.job_description || '';
            companyName = companyName || app.company_name || '';
            jobRole = jobRole || app.job_role || '';
        }

        if (!jobDescription && !resumeHtml) {
            return res.status(400).json({ error: 'job_description or resume content is required' });
        }

        // If caller forgot resume_html but we have a recent CV for this profile, use it.
        if (!String(resumeHtml || '').trim() && profile_id) {
            try {
                const isAdmin = userIsAdmin(req);
                const recent = isAdmin
                    ? getOne(
                        `SELECT draft_html, job_description, company_name, job_role
                         FROM job_applications
                         WHERE profile_id = ? AND draft_html IS NOT NULL AND TRIM(draft_html) != ''
                         ORDER BY id DESC LIMIT 1`,
                        [parseInt(profile_id, 10)]
                    )
                    : getOne(
                        `SELECT a.draft_html, a.job_description, a.company_name, a.job_role
                         FROM job_applications a
                         JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
                         WHERE a.profile_id = ? AND ua.user_id = ?
                           AND a.draft_html IS NOT NULL AND TRIM(a.draft_html) != ''
                         ORDER BY a.id DESC LIMIT 1`,
                        [parseInt(profile_id, 10), req.user.id]
                    );
                if (recent?.draft_html) {
                    resumeHtml = recent.draft_html;
                    jobDescription = jobDescription || recent.job_description || '';
                    companyName = companyName || recent.company_name || '';
                    jobRole = jobRole || recent.job_role || '';
                }
            } catch (err) {
                console.warn('[generate-answers] recent draft lookup failed', err.message);
            }
        }

        const { generateApplicationAnswers } = require('../services/applicationAnswersService');
        const { withUsageContext } = require('../services/aiUsageService');
        const result = await withUsageContext(
            { userId: req.user.id, profileId: profile.id, kind: 'answers' },
            () => generateApplicationAnswers({
                profile,
                jobDescription,
                resumeHtml,
                questions,
                companyName,
                jobRole,
                userId: req.user.id
            })
        );

        res.json({
            answers: result.answers,
            skipped: result.skipped,
            provider: result.provider || null,
            model: result.model || null,
            written_count: result.written_count || 0,
            written_filled: result.written_filled || 0,
            profile: {
                id: profile.id,
                first_name: profile.first_name,
                last_name: profile.last_name,
                email: profile.email,
                phone: profile.phone,
                linkedin_url: profile.linkedin_url,
                github_url: profile.github_url,
                city: profile.city,
                state: profile.state,
                country: profile.country,
                address: profile.address,
                postal_code: profile.postal_code,
                birthdate: profile.birthdate || '',
                salary_range: profile.salary_range || '',
                gender: profile.gender || '',
                work_authorization: profile.work_authorization || '',
                requires_sponsorship: profile.requires_sponsorship || '',
                disability_status: 'No, I do not have a disability',
                veteran_status: profile.veteran_status || '',
                race_ethnicity: profile.race_ethnicity || '',
                website_url: profile.website_url || '',
                portfolio_url: profile.portfolio_url || '',
                preferred_name: profile.preferred_name || '',
                over_18: profile.over_18 || '',
                hispanic_latino: profile.hispanic_latino || '',
                willing_to_relocate: profile.willing_to_relocate || '',
                willing_to_travel: profile.willing_to_travel || '',
                earliest_start_date: profile.earliest_start_date || '',
                notice_period: profile.notice_period || '',
                how_heard: profile.how_heard || '',
                years_of_experience: profile.years_of_experience || '',
                education_level: profile.education_level || '',
                education: profile.education || '',
                school: profile.school || '',
                degree: profile.degree || '',
                discipline: profile.discipline || '',
                security_clearance: profile.security_clearance || ''
            }
        });
    } catch (error) {
        console.error('Generate answers error:', error.response?.data || error.message);
        res.status(500).json({ error: error.message || 'Failed to generate answers' });
    }
});

// ==================== BIDDER BRAIN (Auto Bidder only — not Autofill) ====================
router.post('/bidder/checkout-check', async (req, res) => {
    try {
        const {
            fields,
            missing_required,
            answers,
            company_name,
            job_role,
            ats,
            application_id
        } = req.body || {};
        let companyName = company_name || '';
        let jobRole = job_role || '';
        if (application_id) {
            const app = getAccessibleApplication(application_id, req);
            if (app) {
                companyName = companyName || app.company_name || '';
                jobRole = jobRole || app.job_role || '';
            }
        }
        const { checkApplicationCheckout } = require('../services/applicationCheckoutService');
        const result = await checkApplicationCheckout({
            fields: Array.isArray(fields) ? fields : [],
            missingRequired: Array.isArray(missing_required) ? missing_required : [],
            answers: Array.isArray(answers) ? answers : [],
            companyName,
            jobRole,
            ats: ats || ''
        });
        res.json(result);
    } catch (error) {
        console.error('Checkout check error:', error.message);
        res.status(500).json({
            ok: false,
            error: error.message || 'Checkout check failed',
            issues: [],
            fix_answers: []
        });
    }
});

router.post('/bidder/brain/answers', async (req, res) => {
    try {
        const {
            profile_id,
            job_description,
            resume_html,
            resume_content,
            questions,
            company_name,
            job_role,
            application_id
        } = req.body || {};
        if (!profile_id) return res.status(400).json({ error: 'profile_id is required' });
        if (!Array.isArray(questions) || !questions.length) {
            return res.status(400).json({ error: 'questions array is required' });
        }
        const profile = getAccessibleProfile(profile_id, req);
        if (!profile) return res.status(404).json({ error: 'Profile not found or not assigned to you' });

        let resumeHtml = resume_html || resume_content || '';
        let jobDescription = job_description || '';
        let companyName = company_name || '';
        let jobRole = job_role || '';
        if (application_id) {
            const app = getAccessibleApplication(application_id, req);
            if (!app) return res.status(404).json({ error: 'Application not found' });
            resumeHtml = resumeHtml || app.draft_html || '';
            jobDescription = jobDescription || app.job_description || '';
            companyName = companyName || app.company_name || '';
            jobRole = jobRole || app.job_role || '';
        }

        const brain = require('../services/bidderBrainService');
        const { withUsageContext } = require('../services/aiUsageService');
        const result = await withUsageContext(
            { userId: req.user.id, profileId: profile.id, kind: 'bidder' },
            () => brain.generateBidderAnswers({
                profile,
                jobDescription,
                resumeHtml,
                questions,
                companyName,
                jobRole,
                userId: req.user.id
            })
        );
        res.json(result);
    } catch (error) {
        console.error('Bidder brain answers error:', error.response?.data || error.message);
        res.status(500).json({ error: error.message || 'Bidder answers failed' });
    }
});

router.post('/bidder/brain/cv-check', (req, res) => {
    try {
        const brain = require('../services/bidderBrainService');
        const body = req.body || {};
        let draftHtml = body.draft_html || body.resume_html || '';
        let jobDescription = body.job_description || '';
        let resumeFilename = body.resume_filename || '';
        if (body.application_id) {
            const app = getAccessibleApplication(body.application_id, req);
            if (!app) return res.status(404).json({ error: 'Application not found' });
            draftHtml = draftHtml || app.draft_html || '';
            jobDescription = jobDescription || app.job_description || '';
            resumeFilename = resumeFilename || app.resume_filename || '';
        }
        const assessment = brain.assessCvQuality({ draftHtml, jobDescription, resumeFilename });
        res.json(assessment);
    } catch (error) {
        res.status(500).json({ error: error.message || 'CV check failed' });
    }
});

router.post('/bidder/brain/field-attempts', (req, res) => {
    try {
        const brain = require('../services/bidderBrainService');
        const attempts = Array.isArray(req.body?.attempts) ? req.body.attempts : [req.body];
        const applicationId = parseInt(req.body?.application_id || attempts[0]?.application_id, 10);
        if (!Number.isInteger(applicationId)) {
            return res.status(400).json({ error: 'application_id required' });
        }
        const app = getAccessibleApplication(applicationId, req);
        if (!app) return res.status(404).json({ error: 'Application not found' });
        for (const a of attempts) {
            if (!a) continue;
            brain.logFieldAttempt({ ...a, application_id: applicationId });
        }
        res.json({ ok: true, count: attempts.length });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to log field attempts' });
    }
});

router.get('/bidder/brain/field-attempts/:applicationId', (req, res) => {
    try {
        const brain = require('../services/bidderBrainService');
        const applicationId = parseInt(req.params.applicationId, 10);
        const app = getAccessibleApplication(applicationId, req);
        if (!app) return res.status(404).json({ error: 'Application not found' });
        res.json({ attempts: brain.listFieldAttempts(applicationId), engine_version: brain.ENGINE_VERSION });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to list attempts' });
    }
});

router.get('/bidder/brain/version', (_req, res) => {
    const brain = require('../services/bidderBrainService');
    res.json({ engine_version: brain.ENGINE_VERSION });
});

router.get('/bidder/brain/assistant-context', (req, res) => {
    try {
        const { buildAssistantContext } = require('../services/bidInsightsService');
        const profileId = req.query.profile_id ? parseInt(req.query.profile_id, 10) : null;
        const host = String(req.query.host || '').trim();
        const pack = buildAssistantContext({
            userId: req.user.id,
            profileId: Number.isFinite(profileId) ? profileId : null,
            host
        });
        res.json(pack);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Assistant context failed' });
    }
});

router.get('/bidder/brain/fill-lessons', (req, res) => {
    try {
        const brain = require('../services/bidderBrainService');
        const profileId = req.query.profile_id ? parseInt(req.query.profile_id, 10) : null;
        const host = String(req.query.host || '').trim();
        const lessons = brain.listFillLessons({
            userId: req.user.id,
            profileId: Number.isFinite(profileId) ? profileId : null,
            host,
            limit: 50
        });
        res.json({ lessons });
    } catch (error) {
        res.status(500).json({ error: error.message || 'List fill lessons failed' });
    }
});

router.post('/bidder/brain/fill-lessons', (req, res) => {
    try {
        const brain = require('../services/bidderBrainService');
        const body = req.body || {};
        const lesson = brain.upsertFillLesson({
            user_id: req.user.id,
            profile_id: body.profile_id,
            host: body.host,
            field_key: body.field_key || body.fieldKey,
            issue_key: body.issue_key || body.issueKey,
            instruction: body.instruction,
            actions: body.actions,
            actions_json: body.actions_json,
            ats: body.ats,
            source: body.source || 'user_instruct'
        });
        if (!lesson) return res.status(400).json({ error: 'host and user required' });
        res.json({ lesson });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Save fill lesson failed' });
    }
});

router.post('/bidder/brain/instruct', async (req, res) => {
    try {
        const body = req.body || {};
        const instruction = String(body.instruction || '').trim();
        if (!instruction) return res.status(400).json({ error: 'instruction is required' });

        let companyName = body.company_name || '';
        let jobRole = body.job_role || '';
        let profile = null;
        if (body.application_id) {
            const app = getAccessibleApplication(body.application_id, req);
            if (app) {
                companyName = companyName || app.company_name || '';
                jobRole = jobRole || app.job_role || '';
                if (app.profile_id) {
                    profile = getAccessibleProfile(app.profile_id, req);
                }
            }
        }
        if (!profile && body.profile_id) {
            profile = getAccessibleProfile(body.profile_id, req);
        }

        const brain = require('../services/bidderBrainService');
        const { buildAssistantContext } = require('../services/bidInsightsService');
        const { interpretFillInstruction } = require('../services/fillInstructionService');
        const host = String(body.host || '').replace(/^www\./i, '').toLowerCase();
        const lessons = brain.listFillLessons({
            userId: req.user.id,
            profileId: profile?.id || null,
            host,
            limit: 20
        });
        const assistantContext = buildAssistantContext({
            userId: req.user.id,
            profileId: profile?.id || null,
            host
        });

        const result = await interpretFillInstruction({
            instruction,
            fields: Array.isArray(body.fields) ? body.fields : [],
            missingRequired: Array.isArray(body.missing_required) ? body.missing_required : [],
            profile,
            lessons,
            assistantContext,
            companyName,
            jobRole,
            ats: body.ats || '',
            host
        });

        if (result.ok && host && (result.fills?.length || result.clickSubmit)) {
            brain.upsertFillLesson({
                user_id: req.user.id,
                profile_id: profile?.id,
                host,
                field_key: result.fieldKey || 'form',
                issue_key: result.issueKey || 'user_instruct',
                instruction,
                actions: {
                    fills: result.fills,
                    clickSubmit: !!result.clickSubmit
                },
                ats: body.ats || '',
                source: 'user_instruct'
            });
        }

        // Studying Engine: learn Policy answers from Instruct fills
        try {
            const qm = require('../services/questionMemoryService');
            const fills = Array.isArray(result.fills) ? result.fills : [];
            for (const fill of fills) {
                const label = String(fill.label || fill.fieldLabel || fill.field_key || '').trim();
                const answer = String(fill.value || fill.answer || '').trim();
                if (!label || !answer) continue;
                const kind = qm.inferPolicyKind(label);
                if (!kind) continue;
                qm.upsertMemory({
                    userId: req.user.id,
                    kind,
                    questionText: label,
                    answerText: answer,
                    source: 'instruct',
                    knockout: qm.KNOCKOUT_KINDS.has(kind)
                });
            }
        } catch (e) {
            console.warn('question memory instruct upsert:', e.message);
        }

        res.json({
            ...result,
            lessons_count: lessons.length,
            analytics_counts: assistantContext?.counts || null
        });
    } catch (error) {
        console.error('Bidder instruct error:', error.message);
        res.status(500).json({
            ok: false,
            error: error.message || 'Instruct failed',
            fills: [],
            clickSubmit: false
        });
    }
});

// --- Studying Engine: question memory ---
router.get('/bidder/brain/question-memory', (req, res) => {
    try {
        const qm = require('../services/questionMemoryService');
        qm.seedIfEmpty();
        const rows = qm.listMemory({
            userId: req.user.id,
            includeDisabled: String(req.query.include_disabled || '') === '1',
            limit: parseInt(req.query.limit, 10) || 200
        });
        res.json({ rows, studying: qm.studyingEnabled() });
    } catch (error) {
        res.status(500).json({ error: error.message || 'List question memory failed' });
    }
});

router.post('/bidder/brain/question-memory/match', async (req, res) => {
    try {
        const qm = require('../services/questionMemoryService');
        const question = String(req.body?.question || req.body?.label || '').trim();
        if (!question) return res.status(400).json({ error: 'question required' });
        const result = await qm.matchQuestion(question, { userId: req.user.id });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Match failed' });
    }
});

router.post('/bidder/brain/question-memory/upsert', (req, res) => {
    try {
        const qm = require('../services/questionMemoryService');
        const body = req.body || {};
        const result = qm.upsertMemory({
            userId: req.user.id,
            kind: body.kind,
            questionText: body.question || body.question_text,
            answerText: body.answer || body.answer_text,
            source: body.source || 'user',
            knockout: !!body.knockout
        });
        if (!result.ok) return res.status(400).json(result);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Upsert failed' });
    }
});

router.post('/bidder/brain/question-memory/disable', (req, res) => {
    try {
        const qm = require('../services/questionMemoryService');
        const id = parseInt(req.body?.id, 10);
        const disabled = req.body?.disabled !== false && req.body?.disabled !== 0;
        const result = qm.setDisabled(id, disabled, req.user.id);
        if (!result.ok) return res.status(400).json(result);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Disable failed' });
    }
});

router.post('/bidder/brain/question-memory/clear', (req, res) => {
    try {
        const qm = require('../services/questionMemoryService');
        res.json(qm.clearUserMemory(req.user.id));
    } catch (error) {
        res.status(500).json({ error: error.message || 'Clear failed' });
    }
});

router.post('/bidder/brain/fill-lessons/clear', (req, res) => {
    try {
        const brain = require('../services/bidderBrainService');
        const host = String(req.body?.host || '').replace(/^www\./i, '').toLowerCase();
        if (!host) return res.status(400).json({ error: 'host required' });
        const result = brain.clearFillLessonsForHost({
            userId: req.user.id,
            host
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Clear fill lessons failed' });
    }
});

// POST /api/user/bid-courses/fill — log autofill course snapshot (answers, salary, timing)
router.post('/bid-courses/fill', (req, res) => {
    try {
        const body = req.body || {};
        const applicationId = parseInt(body.application_id, 10);
        if (!Number.isInteger(applicationId) || applicationId <= 0) {
            return res.status(400).json({ error: 'application_id is required' });
        }

        const app = getAccessibleApplication(applicationId, req);
        if (!app) {
            return res.status(404).json({ error: 'Application not found or access denied' });
        }

        const bidCourseService = require('../services/bidCourseService');
        const salaryMeta = Array.isArray(body.answers)
            ? body.answers.find((a) => a && a.salary_meta)
            : null;
        const course = bidCourseService.recordFillDone({
            applicationId,
            profileId: app.profile_id,
            userId: req.user.id,
            jobUrl: body.job_url || app.job_url,
            companyName: body.company_name || app.company_name,
            jobRole: body.job_role || app.job_role,
            answers: body.answers || [],
            answersProvider: body.answers_provider || null,
            answersModel: body.answers_model || null,
            salaryValue: body.salary_value ?? salaryMeta?.salary_meta?.value ?? null,
            salaryFormatted: body.salary_formatted
                || salaryMeta?.answer
                || null,
            fillStats: body.fill_stats || null,
            templateId: body.template_id ?? app.template_id,
            fontFamily: body.font_family || app.font_family,
            cvProvider: body.cv_provider || null
        });

        res.json({ ok: true, course });
    } catch (error) {
        console.error('Bid course fill log error:', error);
        res.status(500).json({ error: error.message || 'Failed to log bid course' });
    }
});

/** POST /api/user/bid-courses/clear — wipe this user's Auto Bidder history. */
router.post('/bid-courses/clear', (req, res) => {
    try {
        const bidCourseService = require('../services/bidCourseService');
        const summary = userIsAdmin(req) && req.body?.all === true
            ? bidCourseService.clearHistory({ all: true })
            : bidCourseService.clearHistory({ userId: req.user.id });
        res.json({ ok: true, summary });
    } catch (error) {
        console.error('Clear bid courses error:', error);
        res.status(500).json({ error: error.message || 'Failed to clear bid courses' });
    }
});

// GET /api/user/bid-courses — recent courses for this user
router.get('/bid-courses', (req, res) => {
    try {
        const profileId = parseInt(req.query.profile_id, 10);
        const bidCourseService = require('../services/bidCourseService');
        const courses = userIsAdmin(req)
            ? bidCourseService.listCoursesAll({
                profileId: Number.isInteger(profileId) && profileId > 0 ? profileId : undefined,
                limit: parseInt(req.query.limit, 10) || 50
            })
            : bidCourseService.listCoursesForUser(req.user.id, {
                profileId: Number.isInteger(profileId) && profileId > 0 ? profileId : undefined,
                limit: parseInt(req.query.limit, 10) || 50
            });
        // Attention / failed first (do not treat captcha_cleared as failure)
        const needsAttention = (c) => {
            const t = String(c.last_event_type || '');
            if (/captcha_cleared|captcha_assist/i.test(t)) return false;
            return /needs_manual|needs_captcha|captcha_abandoned|login_wall|no_form|ai_failed|blocked_ats|open_failed|fill_failed|cv_regenerate_failed/i.test(t);
        };
        const ranked = [...courses].sort((a, b) => {
            const am = needsAttention(a);
            const bm = needsAttention(b);
            if (am !== bm) return am ? -1 : 1;
            const at = new Date(a.filled_at || a.updated_at || a.created_at || 0).getTime();
            const bt = new Date(b.filled_at || b.updated_at || b.created_at || 0).getTime();
            return bt - at;
        });
        res.json({ courses: ranked });
    } catch (error) {
        console.error('List bid courses error:', error);
        res.status(500).json({ error: 'Failed to list bid courses' });
    }
});

// GET /api/user/bid-courses/:id — full course report (JD, CV, answers, screenshots, events)
router.get('/bid-courses/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const lite = String(req.query.lite || '') === '1';
        const bidCourseService = require('../services/bidCourseService');
        const artifacts = require('../services/bidderArtifactService');
        const course = userIsAdmin(req)
            ? getOne(`SELECT * FROM bid_courses WHERE id = ?`, [id])
            : getOne(`SELECT * FROM bid_courses WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (!course) return res.status(404).json({ error: 'Course not found' });

        const app = getOne(`SELECT * FROM job_applications WHERE id = ?`, [course.application_id]);
        const events = bidCourseService.listEvents(course.id);
        const uniqueShots = bidCourseService.listExistingScreenshots(course.id, course.application_id);
        const diskShots = artifacts.listScreenshots(course.application_id);

        const needsManual = events.some((e) => {
            const t = String(e.event_type || '');
            if (/captcha_cleared|captcha_assist/i.test(t)) return false;
            return /needs_manual|needs_captcha|captcha_abandoned|no_form|login_wall|ai_failed|blocked_ats|fill_failed|open_failed/i.test(t);
        });

        res.json({
            course: {
                ...bidCourseService.getCourseByApplicationId(course.application_id),
                needs_manual: needsManual
            },
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
                updated_ms: s.updated_ms || 0,
                filename: s.filename || path.basename(s.file_path),
                url: `/user/bid-courses/${course.id}/screenshots/${encodeURIComponent(s.filename || path.basename(s.file_path))}`
            })),
            disk_screenshots: diskShots.map((s) => ({
                stage: s.stage,
                filename: s.filename,
                updated_ms: (() => {
                    try {
                        const fp = s.absolute || artifacts.readScreenshotFile(course.application_id, s.filename);
                        if (fp && require('fs').existsSync(fp)) {
                            return Math.round(require('fs').statSync(fp).mtimeMs || 0);
                        }
                    } catch (_) { /* ignore */ }
                    return 0;
                })(),
                url: `/user/bid-courses/${course.id}/screenshots/${encodeURIComponent(s.filename)}`
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
    } catch (error) {
        console.error('Bid course detail error:', error);
        res.status(500).json({ error: error.message || 'Failed to load course' });
    }
});

// GET screenshot file for a course
router.get('/bid-courses/:id/screenshots/:filename', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const course = userIsAdmin(req)
            ? getOne(`SELECT * FROM bid_courses WHERE id = ?`, [id])
            : getOne(`SELECT * FROM bid_courses WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (!course) return res.status(404).json({ error: 'Course not found' });
        const artifacts = require('../services/bidderArtifactService');
        const fp = artifacts.readScreenshotFile(course.application_id, req.params.filename);
        if (!fp) {
            // Fall back to DB-recorded absolute path (legacy rows / moved DATA_ROOT).
            const row = getOne(
                `SELECT file_path FROM bid_course_screenshots
                 WHERE course_id = ? AND (file_path LIKE ? OR file_path LIKE ?)
                 ORDER BY id DESC LIMIT 1`,
                [course.id, `%${req.params.filename}`, `%${path.basename(req.params.filename)}`]
            );
            const alt = row?.file_path && require('fs').existsSync(row.file_path) ? row.file_path : null;
            if (!alt) return res.status(404).json({ error: 'Screenshot not found' });
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
            res.setHeader('Pragma', 'no-cache');
            return res.sendFile(alt);
        }
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.sendFile(fp);
    } catch (error) {
        console.error('Screenshot serve error:', error);
        res.status(500).json({ error: 'Failed to serve screenshot' });
    }
});

// POST /api/user/bid-courses/event — timeline event (opened, captcha, etc.)
router.post('/bid-courses/event', (req, res) => {
    try {
        const body = req.body || {};
        const applicationId = parseInt(body.application_id, 10);
        if (!Number.isInteger(applicationId) || applicationId <= 0) {
            return res.status(400).json({ error: 'application_id is required' });
        }
        const app = getAccessibleApplication(applicationId, req);
        if (!app) return res.status(404).json({ error: 'Application not found' });

        const bidCourseService = require('../services/bidCourseService');
        const course = bidCourseService.upsertCourse({
            applicationId,
            profileId: app.profile_id,
            userId: req.user.id,
            jobUrl: body.job_url || app.job_url,
            companyName: body.company_name || app.company_name,
            jobRole: body.job_role || app.job_role,
            eventType: String(body.event_type || 'note').slice(0, 80),
            eventMeta: body.meta || null,
            filledAt: /awaiting_manual_submit|fill_done|after_fill/i.test(String(body.event_type || ''))
                ? new Date().toISOString()
                : undefined,
            appliedAt: /success_revoked|false_success_cleared/i.test(String(body.event_type || ''))
                ? null
                : (/marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(String(body.event_type || ''))
                    ? new Date().toISOString()
                    : undefined),
            outcome: /success_revoked|false_success_cleared/i.test(String(body.event_type || ''))
                ? 'unknown'
                : undefined
        });
        if (/success_revoked|false_success_cleared/i.test(String(body.event_type || ''))) {
            try {
                runQuery(
                    `UPDATE job_applications SET status = 'pending', updated_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND status = 'applied'`,
                    [applicationId]
                );
            } catch (_) { /* ignore */ }
        }
        res.json({ ok: true, course });
    } catch (error) {
        console.error('Bid course event error:', error);
        res.status(500).json({ error: error.message || 'Failed to log event' });
    }
});

// POST /api/user/bid-courses/screenshot — upload base64 screenshot to DATA_ROOT/lumi-bidder
router.post('/bid-courses/screenshot', (req, res) => {
    try {
        const body = req.body || {};
        const applicationId = parseInt(body.application_id, 10);
        const stage = String(body.stage || 'shot').slice(0, 64);
        if (!Number.isInteger(applicationId) || applicationId <= 0) {
            return res.status(400).json({ error: 'application_id is required' });
        }
        if (!body.image_base64) {
            return res.status(400).json({ error: 'image_base64 is required' });
        }
        const app = getAccessibleApplication(applicationId, req);
        if (!app) return res.status(404).json({ error: 'Application not found' });

        const bidCourseService = require('../services/bidCourseService');
        const artifacts = require('../services/bidderArtifactService');
        // Touch course without flooding timeline with screenshot events (status stays on last real event).
        const course = bidCourseService.upsertCourse({
            applicationId,
            profileId: app.profile_id,
            userId: req.user.id,
            jobUrl: app.job_url || undefined,
            companyName: app.company_name || undefined,
            jobRole: app.job_role || undefined,
            skipEvent: true
        });
        const saved = artifacts.saveScreenshot(applicationId, stage, body.image_base64);
        // Upsert one DB row per stage (overwrite live.png path) instead of endless inserts.
        const existingShot = getOne(
            `SELECT id FROM bid_course_screenshots WHERE course_id = ? AND stage = ? ORDER BY id DESC LIMIT 1`,
            [course.id, stage]
        );
        if (existingShot?.id) {
            runQuery(
                `UPDATE bid_course_screenshots SET file_path = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [saved.path, existingShot.id]
            );
            // Drop older duplicates for the same stage (pre-upsert spam).
            runQuery(
                `DELETE FROM bid_course_screenshots WHERE course_id = ? AND stage = ? AND id != ?`,
                [course.id, stage, existingShot.id]
            );
        } else {
            runQuery(
                `INSERT INTO bid_course_screenshots (course_id, application_id, stage, file_path)
                 VALUES (?, ?, ?, ?)`,
                [course.id, applicationId, stage, saved.path]
            );
        }
        res.json({
            ok: true,
            course_id: course.id,
            stage,
            path: saved.path,
            fallback: saved.fallback
        });
    } catch (error) {
        console.error('Bid course screenshot error:', error);
        res.status(500).json({ error: error.message || 'Failed to save screenshot' });
    }
});

// POST /api/user/bid-courses/package — write JD/answers/meta/CV copy to artifact root
router.post('/bid-courses/package', (req, res) => {
    try {
        const body = req.body || {};
        const applicationId = parseInt(body.application_id, 10);
        if (!Number.isInteger(applicationId) || applicationId <= 0) {
            return res.status(400).json({ error: 'application_id is required' });
        }
        const app = getAccessibleApplication(applicationId, req);
        if (!app) return res.status(404).json({ error: 'Application not found' });

        const artifacts = require('../services/bidderArtifactService');
        const bidCourseService = require('../services/bidCourseService');
        bidCourseService.upsertCourse({
            applicationId,
            profileId: app.profile_id,
            userId: req.user.id,
            jobUrl: app.job_url,
            companyName: app.company_name,
            jobRole: app.job_role,
            answers: body.answers,
            eventType: 'package_saved',
            eventMeta: {
                has_answers: Array.isArray(body.answers),
                filled: body.meta?.filled,
                incomplete: !!body.meta?.incomplete,
                ats: body.meta?.ats || null
            }
        });
        const saved = artifacts.saveCoursePackage(applicationId, {
            jd: body.jd != null ? body.jd : app.job_description,
            answers: body.answers || [],
            meta: body.meta || {
                company: app.company_name,
                role: app.job_role,
                url: app.job_url,
                at: new Date().toISOString()
            },
            resumeFilename: app.resume_filename,
            resumesDir
        });
        res.json({ ok: true, dir: saved.dir, fallback: saved.fallback, cv: saved.cvCopy });
    } catch (error) {
        console.error('Bid course package error:', error);
        res.status(500).json({ error: error.message || 'Failed to save package' });
    }
});

// GET /api/user/bid-insights — analytics + playbook
router.get('/bid-insights', (req, res) => {
    try {
        const profileId = parseInt(req.query.profile_id, 10);
        const jobRole = String(req.query.job_role || '').trim() || undefined;
        const { buildBidInsights } = require('../services/bidInsightsService');
        const insights = buildBidInsights({
            userId: req.user.id,
            profileId: Number.isInteger(profileId) && profileId > 0 ? profileId : undefined,
            jobRole
        });
        res.json(insights);
    } catch (error) {
        console.error('Bid insights error:', error);
        res.status(500).json({ error: 'Failed to build bid insights' });
    }
});

// GET /api/user/analyze — bid analytics + MiniMax chat counts
router.get('/analyze', (req, res) => {
    try {
        const profileIdRaw = parseInt(req.query.profile_id, 10);
        const profileId = Number.isInteger(profileIdRaw) && profileIdRaw > 0 ? profileIdRaw : undefined;
        const sinceDays = parseInt(req.query.since_days, 10) || 30;
        const { buildBidSnapshot } = require('../services/bidAnalyzeService');
        const { getUsageSummary } = require('../services/aiUsageService');
        const { buildBidInsights } = require('../services/bidInsightsService');
        const bids = buildBidSnapshot({
            userId: req.user.id,
            profileId,
            limit: Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100))
        });
        const usage = getUsageSummary({
            userId: req.user.id,
            profileId,
            sinceDays
        });
        const insights = buildBidInsights({
            userId: req.user.id,
            profileId
        });
        res.json({ bids, usage, insights });
    } catch (error) {
        console.error('Analyze load error:', error);
        res.status(500).json({ error: error.message || 'Failed to load analyze data' });
    }
});

// POST /api/user/analyze/run — MiniMax narrative of bid state
router.post('/analyze/run', async (req, res) => {
    try {
        const profileIdRaw = parseInt(req.body?.profile_id, 10);
        const profileId = Number.isInteger(profileIdRaw) && profileIdRaw > 0 ? profileIdRaw : undefined;
        const { runBidAnalysis } = require('../services/bidAnalyzeService');
        const result = await runBidAnalysis({
            userId: req.user.id,
            profileId
        });
        res.json(result);
    } catch (error) {
        const status = error.status || 500;
        console.error('Analyze run error:', error.message || error);
        res.status(status).json({
            error: error.message || 'Failed to run analysis',
            retry_after_sec: error.retryAfterSec || undefined
        });
    }
});

// GET /api/user/bidder/ready — Auto Bidder queue: CV-ready apps (oldest first)
// Optional: job_link_ids=1,2,3 to bid only selected Job Links rows.
router.get('/bidder/ready', (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const profileId = parseInt(req.query.profile_id, 10);
        const isAdmin = userIsAdmin(req);

        const params = [];
        let accessClause = '';
        if (isAdmin) {
            // Admins on Job Links may bid any assigned profile's ready CVs.
            accessClause = ' WHERE 1=1 ';
        } else {
            accessClause = ` WHERE EXISTS (
                SELECT 1 FROM user_profile_assignments ua
                 WHERE ua.profile_id = a.profile_id AND ua.user_id = ?
            ) `;
            params.push(req.user.id);
        }

        let profileClause = '';
        if (Number.isInteger(profileId) && profileId > 0) {
            profileClause = ' AND a.profile_id = ? ';
            params.push(profileId);
        }

        let linkClause = '';
        const rawIds = String(req.query.job_link_ids || '').trim();
        if (rawIds) {
            const ids = rawIds.split(',')
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => Number.isInteger(n) && n > 0);
            if (ids.length) {
                linkClause = ` AND a.job_link_id IN (${ids.map(() => '?').join(',')}) `;
                params.push(...ids);
            }
        }

        params.push(limit);

        const rows = getAll(`
      SELECT a.id, a.profile_id, a.company_name, a.job_role, a.job_url,
             a.resume_filename, a.generation_status, a.status, a.source,
             a.job_link_id, a.match_score, a.created_at, a.updated_at,
             p.first_name, p.last_name
      FROM job_applications a
      JOIN candidate_profiles p ON p.id = a.profile_id
      LEFT JOIN job_links jl ON jl.id = a.job_link_id
      ${accessClause}
        ${profileClause}
        ${linkClause}
        AND a.generation_status = 'ready'
        AND COALESCE(a.status, 'pending') = 'pending'
        AND a.resume_filename IS NOT NULL
        AND TRIM(a.resume_filename) <> ''
        AND a.job_url IS NOT NULL
        AND TRIM(a.job_url) <> ''
        AND (a.job_link_id IS NULL OR COALESCE(jl.is_available, 1) = 1)
        AND NOT EXISTS (
          SELECT 1 FROM job_applications prev
          WHERE prev.profile_id = a.profile_id
            AND prev.id <> a.id
            AND COALESCE(prev.status, '') = 'applied'
            AND LOWER(TRIM(COALESCE(prev.company_name, ''))) = LOWER(TRIM(COALESCE(a.company_name, '')))
            AND TRIM(COALESCE(a.company_name, '')) <> ''
        )
      ORDER BY a.created_at ASC, a.id ASC
      LIMIT ?
    `, params);

        res.json({
            items: rows.map((r) => {
                let openUrl = r.job_url || null;
                try {
                    const { canonicalizeGreenhouseApplyUrl, isGreenhouseUrl } = require('../services/scraper/greenhouseUrl');
                    if (openUrl && isGreenhouseUrl(openUrl)) {
                        openUrl = canonicalizeGreenhouseApplyUrl(openUrl) || openUrl;
                    }
                } catch (_) { /* ignore */ }
                return {
                    ...r,
                    open_url: openUrl,
                    download_url: r.resume_filename
                        ? `/resumes/${encodeURIComponent(r.resume_filename)}`
                        : null
                };
            }),
            filter: {
                job_link_ids: rawIds
                    ? rawIds.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0)
                    : null,
                admin: isAdmin
            }
        });
    } catch (error) {
        console.error('Bidder ready list error:', error);
        res.status(500).json({ error: 'Failed to list ready applications' });
    }
});

// GET /api/user/bidder/applications/:id — payload for extension fill
router.get('/bidder/applications/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const accessible = getAccessibleApplication(id, req);
        if (!accessible) return res.status(404).json({ error: 'Application not found' });
        const app = getOne(`
      SELECT a.*, p.first_name, p.last_name, p.email, p.phone,
             p.linkedin_url, p.github_url, p.city, p.state, p.country,
             p.address, p.postal_code, p.salary_range, p.birthdate,
             p.gender, p.work_authorization, p.requires_sponsorship,
             p.disability_status, p.veteran_status, p.race_ethnicity,
             p.website_url, p.portfolio_url, p.preferred_name, p.over_18,
             p.hispanic_latino, p.willing_to_relocate, p.willing_to_travel,
             p.earliest_start_date, p.notice_period, p.how_heard,
             p.years_of_experience, p.education_level, p.security_clearance
      FROM job_applications a
      JOIN candidate_profiles p ON p.id = a.profile_id
      WHERE a.id = ?
    `, [id]);
        if (!app) return res.status(404).json({ error: 'Application not found' });
        res.json({
            application: {
                id: app.id,
                profile_id: app.profile_id,
                company_name: app.company_name,
                job_role: app.job_role,
                job_url: app.job_url,
                job_description: app.job_description,
                resume_filename: app.resume_filename,
                draft_html: app.draft_html,
                generation_status: app.generation_status,
                status: app.status
            },
            profile: {
                id: app.profile_id,
                first_name: app.first_name,
                last_name: app.last_name,
                email: app.email,
                phone: app.phone,
                linkedin_url: app.linkedin_url,
                github_url: app.github_url,
                city: app.city,
                state: app.state,
                country: app.country,
                address: app.address,
                postal_code: app.postal_code,
                birthdate: app.birthdate || '',
                salary_range: app.salary_range || '',
                gender: app.gender || '',
                work_authorization: app.work_authorization || '',
                requires_sponsorship: app.requires_sponsorship || '',
                disability_status: 'No, I do not have a disability',
                veteran_status: app.veteran_status || '',
                race_ethnicity: app.race_ethnicity || '',
                website_url: app.website_url || '',
                portfolio_url: app.portfolio_url || '',
                preferred_name: app.preferred_name || '',
                over_18: app.over_18 || '',
                hispanic_latino: app.hispanic_latino || '',
                willing_to_relocate: app.willing_to_relocate || '',
                willing_to_travel: app.willing_to_travel || '',
                earliest_start_date: app.earliest_start_date || '',
                notice_period: app.notice_period || '',
                how_heard: app.how_heard || '',
                years_of_experience: app.years_of_experience || '',
                education_level: app.education_level || '',
                security_clearance: app.security_clearance || ''
            }
        });
    } catch (error) {
        console.error('Bidder application fetch error:', error);
        res.status(500).json({ error: 'Failed to load application' });
    }
});

// GET /api/user/bidder/latest — newest CV-ready application for fill (optional profile_id)
router.get('/bidder/latest', (req, res) => {
    try {
        const profileId = parseInt(req.query.profile_id, 10);
        const isAdmin = userIsAdmin(req);
        const params = [];
        let accessClause = '';
        if (isAdmin) {
            accessClause = ' WHERE 1=1 ';
        } else {
            accessClause = ` WHERE EXISTS (
                SELECT 1 FROM user_profile_assignments ua
                 WHERE ua.profile_id = a.profile_id AND ua.user_id = ?
            ) `;
            params.push(req.user.id);
        }
        let profileClause = '';
        if (Number.isInteger(profileId) && profileId > 0) {
            profileClause = ' AND a.profile_id = ? ';
            params.push(profileId);
        }
        const app = getOne(`
      SELECT a.id, a.profile_id, a.company_name, a.job_role, a.job_url,
             a.job_description, a.resume_filename, a.draft_html,
             a.generation_status, a.status, a.updated_at
      FROM job_applications a
      ${accessClause}
        AND a.resume_filename IS NOT NULL
        AND a.resume_filename <> ''
        ${profileClause}
      ORDER BY a.updated_at DESC
      LIMIT 1
    `, params);
        if (!app) return res.status(404).json({ error: 'No generated resume found for this profile' });
        res.json({ application: app });
    } catch (error) {
        console.error('Bidder latest error:', error);
        res.status(500).json({ error: 'Failed to load latest application' });
    }
});

// GET /api/user/bidder/by-job-url — reconnect fill to an existing CV after page refresh
// (no regenerate). Matches job_url loosely against recent apps for this user/profile.
router.get('/bidder/by-job-url', (req, res) => {
    try {
        const rawUrl = String(req.query.url || '').trim();
        if (!rawUrl) {
            return res.status(400).json({ error: 'url query param is required' });
        }
        const profileId = parseInt(req.query.profile_id, 10);
        const isAdmin = userIsAdmin(req);
        const params = [];
        let accessClause = '';
        if (isAdmin) {
            accessClause = ' WHERE 1=1 ';
        } else {
            accessClause = ` WHERE EXISTS (
                SELECT 1 FROM user_profile_assignments ua
                 WHERE ua.profile_id = a.profile_id AND ua.user_id = ?
            ) `;
            params.push(req.user.id);
        }
        let profileClause = '';
        if (Number.isInteger(profileId) && profileId > 0) {
            profileClause = ' AND a.profile_id = ? ';
            params.push(profileId);
        }

        const rows = getAll(`
      SELECT a.id, a.profile_id, a.company_name, a.job_role, a.job_url,
             a.job_description, a.resume_filename, a.draft_html,
             a.generation_status, a.status, a.updated_at
      FROM job_applications a
      ${accessClause}
        AND a.resume_filename IS NOT NULL
        AND a.resume_filename <> ''
        ${profileClause}
      ORDER BY a.updated_at DESC
      LIMIT 40
    `, params);

        const norm = (u) => {
            try {
                const parsed = new URL(u);
                return {
                    host: parsed.hostname.replace(/^www\./, '').toLowerCase(),
                    path: parsed.pathname.replace(/\/+$/, '').toLowerCase()
                };
            } catch {
                const s = String(u || '').split('?')[0].toLowerCase();
                return { host: '', path: s };
            }
        };
        const target = norm(rawUrl);
        const match = rows.find((r) => {
            if (!r.job_url) return false;
            const cand = norm(r.job_url);
            if (target.host && cand.host && target.host !== cand.host) return false;
            if (!target.path || !cand.path) return target.host && cand.host && target.host === cand.host;
            return (
                target.path === cand.path
                || target.path.includes(cand.path)
                || cand.path.includes(target.path)
            );
        });

        if (!match) {
            return res.status(404).json({ error: 'No generated CV found for this job URL' });
        }
        res.json({ application: match });
    } catch (error) {
        console.error('Bidder by-job-url error:', error);
        res.status(500).json({ error: 'Failed to look up CV by job URL' });
    }
});

// GET /api/user/bidder/status — caps + queue snapshot for extension monitor
router.get('/bidder/status', (req, res) => {
    try {
        const jobMatchService = require('../services/jobMatchService');
        const cfg = jobMatchService.getConfig();
        const todayCounts = jobMatchService.getDailyBidCounts(req.user.id);
        const ready = getOne(`
      SELECT COUNT(*) AS c
      FROM job_applications a
      JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
      WHERE ua.user_id = ?
        AND a.generation_status = 'ready'
        AND COALESCE(a.status, 'pending') = 'pending'
        AND a.resume_filename IS NOT NULL
    `, [req.user.id]);

        res.json({
            ready_count: ready?.c || 0,
            caps: {
                maxPerProfilePerDay: cfg.maxPerProfilePerDay,
                maxTotalPerDay: cfg.maxTotalPerDay
            },
            today: todayCounts,
            auto_apply: {
                enabled: cfg.enabled,
                intervalMs: cfg.intervalMs
            }
        });
    } catch (error) {
        console.error('Bidder status error:', error);
        res.status(500).json({ error: 'Failed to load bidder status' });
    }
});

// POST /api/user/chat - Ask questions about job application based on job description and resume
router.post('/chat', requireAuth, async (req, res) => {
    try {
        const { question, job_description, resume_content, conversationHistory } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }

        if (!job_description && !resume_content) {
            return res.status(400).json({ error: 'Job description or resume content is required' });
        }

        // Build context from provided data
        let context = '';
        if (job_description) {
            context += `JOB DESCRIPTION:\n${job_description}\n\n`;
        }
        if (resume_content) {
            context += `RESUME CONTENT:\n${resume_content}\n\n`;
        }

        // Create chat prompt
        const systemPrompt = `You are the candidate's job-application assistant on the Generate page.

Write calm, professional answers that sound human — not AI essays and not keyword dumps.

Rules:
- Ground in JOB DESCRIPTION + RESUME. Do not invent experience.
- Short: 1–2 sentences for advice; for "why company/role" drafts, 1–2 natural sentences that name a specific JD hook (product, team, or duty) and one true resume fact.
- Never answer with a comma-separated skill list ("Python, APIs, Postgres…").
- Never generic lines that would fit any employer.
- Yes/No → Yes or No. Avoid fluff: passionate, leverage, cutting-edge, thrilled, seamless, excited about the opportunity.`;

        // Build messages array with conversation history
        const messages = [
            { role: 'system', content: systemPrompt }
        ];

        // Add conversation history if available
        if (conversationHistory && Array.isArray(conversationHistory)) {
            conversationHistory.forEach(msg => {
                messages.push({ role: msg.role, content: msg.content });
            });
        }

        // Add current question with context
        const userPrompt = `${context}

Answer briefly and specifically:

${question}`;
        messages.push({ role: 'user', content: userPrompt });

        // Call active AI provider (configurable via admin settings)
        const provider = getProviderConfig();
        const response = await axios.post(provider.apiUrl, {
            model: provider.model,
            messages: messages,
            max_tokens: 350,
            temperature: 0.55
        }, {
            headers: {
                'Authorization': `Bearer ${provider.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        try {
            const { recordMinimaxResponse } = require('../services/aiUsageService');
            recordMinimaxResponse(response, {
                provider: provider.provider,
                model: provider.model,
                kind: 'chat',
                userId: req.user.id
            });
        } catch (_) { /* ignore */ }

        let answer = response.data.choices[0].message.content || '';

// Strip reasoning blocks emitted by reasoning models (MiniMax-M2.7, deepseek-reasoner).
answer = answer.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

        res.json({ answer });
    } catch (error) {
        console.error('Chat error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to get response. Please try again.' });
    }
});

// =============================================================================
// Resume templates (user-facing read-only)
// =============================================================================
// Any authenticated user can list templates + the allowed-font set so the
// resume-generation form can render the picker. Admin-only mutations live
// under /api/admin/resume-templates. (templateService is imported at the
// top of this file alongside the other service imports.)

router.get('/resume-templates', (req, res) => {
    try {
        // Lazy-seed: SQLite may not be initialised yet at module-load
        // time. Calling ensureDefaultTemplate() here (rather than at the
        // top of the file) is safe because every code path through this
        // handler is reached only after initDatabase() has finished.
        templateService.ensureDefaultTemplate();
        const templates = templateService.listTemplates().map((t) => ({
            // Strip the heavy style_spec for list views — clients fetch the
            // individual spec only when they actually pick a template.
            id: t.id,
            name: t.name,
            description: t.description,
            is_default: t.is_default,
            created_at: t.created_at
        }));
        res.json({
            templates,
            allowed_fonts: Array.from(templateService.ALLOWED_FONTS)
        });
    } catch (err) {
        console.error('List resume templates error:', err);
        res.status(500).json({ error: 'Failed to list resume templates' });
    }
});

router.get('/resume-templates/:id', (req, res) => {
    try {
        templateService.ensureDefaultTemplate();
        const tpl = templateService.getTemplate(req.params.id);
        if (!tpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tpl });
    } catch (err) {
        console.error('Get resume template error:', err);
        res.status(500).json({ error: 'Failed to load resume template' });
    }
});

// ============================================================================
// User-authored templates (drag-drop template builder)
// ============================================================================
//
// CRUD over `user_resume_templates`. Each user has their own library of
// templates built via the drag-drop builder UI. The list / get routes
// also auto-seed a starter template the first time a user asks for
// their library, so the picker is never empty.
//
// Routes:
//   GET    /api/user/user-templates              -> list + allowed fonts
//   GET    /api/user/user-templates/default-spec -> fresh default spec (for "New")
//   GET    /api/user/user-templates/:id          -> one template + style_spec
//   POST   /api/user/user-templates              -> create
//   PUT    /api/user/user-templates/:id          -> update
//   DELETE /api/user/user-templates/:id          -> delete
//
// Style-spec resolution for the resume generator lives in resumeService:
// when the user picks a user-template (kind='user') the route handler
// looks up the row by id, then forwards `style_spec` to generateResume
// exactly like admin templates do.

router.get('/user-templates', (req, res) => {
    try {
        // Seed a starter template the first time a user asks, so the
        // picker is never empty when the user opens ResumeGenerator.
        userTemplateService.ensureSeed(req.user.id);
        const templates = userTemplateService.listForUser(req.user.id).map(t => ({
            // Same trim as admin templates: keep list views light and
            // let the builder fetch the spec when it actually opens one.
            id: t.id,
            name: t.name,
            description: t.description,
            kind: t.kind,
            is_default: !!t.is_default,
            is_editable: !!t.is_editable,
            last_used_at: t.last_used_at,
            created_at: t.created_at,
            updated_at: t.updated_at
        }));
        res.json({
            templates,
            allowed_fonts: Array.from(userTemplateService.ALLOWED_FONTS)
        });
    } catch (err) {
        console.error('List user templates error:', err);
        res.status(500).json({ error: 'Failed to list user templates' });
    }
});
router.get('/user-templates/default-spec', (req, res) => {
    try {
        res.json({
            style_spec: userTemplateService.defaultStyleSpec(),
            allowed_fonts: Array.from(userTemplateService.ALLOWED_FONTS)
        });
    } catch (err) {
        console.error('Default user-template spec error:', err);
        res.status(500).json({ error: 'Failed to build default template spec' });
    }
});

router.get('/user-templates/:id', (req, res) => {
    try {
        const tpl = userTemplateService.getForUser(req.user.id, req.params.id);
        if (!tpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tpl });
    } catch (err) {
        console.error('Get user template error:', err);
        res.status(500).json({ error: 'Failed to load user template' });
    }
});

router.post('/user-templates', (req, res) => {
    try {
        const { name, description, style_spec, kind, is_default, is_editable } = req.body || {};
        const tpl = userTemplateService.createForUser(req.user.id, {
            name,
            description,
            style_spec,
            kind,
            is_default,
            is_editable
        });
        res.status(201).json({ template: tpl });
    } catch (err) {
        // Surface a 409 when the collision-prompt message fires
        // ("choose a different name") so the UI can prompt for input
        // instead of treating it as a generic server error. Everything
        // else is either 400 (validation) or 500 (unexpected).
        const msg = err.message || '';
        const status = /already exists/i.test(msg) ? 409
            : /required|invalid/i.test(msg) ? 400
            : 500;
        console.error('Create user template error:', err);
        res.status(status).json({ error: msg || 'Failed to create user template' });
    }
});

router.put('/user-templates/:id', (req, res) => {
    try {
        const { name, description, style_spec, is_default, is_editable } = req.body || {};
        const tpl = userTemplateService.updateForUser(req.user.id, req.params.id, {
            name,
            description,
            style_spec,
            is_default,
            is_editable
        });
        if (!tpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tpl });
    } catch (err) {
        const status = /required|read-only|invalid/i.test(err.message || '') ? 400 : 500;
        console.error('Update user template error:', err);
        res.status(status).json({ error: err.message || 'Failed to update user template' });
    }
});

router.delete('/user-templates/:id', (req, res) => {
    try {
        const ok = userTemplateService.deleteForUser(req.user.id, req.params.id);
        if (!ok) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete user template error:', err);
        res.status(500).json({ error: 'Failed to delete user template' });
    }
});

// ─── Email OTP — forward webhook (default) + optional Graph ────────────────

router.get('/outlook/status', (req, res) => {
    try {
        const config = {
            ...outlookMail.configStatus(),
            ...mailForward.configStatus()
        };
        const accounts = outlookMail.listMailboxesPublic(req.user.id);
        const account = accounts[0] || null;
        const forward = mailForward.forwardPublic(mailForward.getForwardByUser(req.user.id));
        res.json({ config, account, accounts, forward });
    } catch (err) {
        console.error('Outlook status error:', err);
        res.status(500).json({ error: err.message || 'Failed to load Outlook status' });
    }
});

router.post('/outlook/forward/enable', (req, res) => {
    try {
        const rotate = !!req.body?.rotate;
        const forward = mailForward.enableForward(req.user.id, { rotate });
        res.json({ forward, config: mailForward.configStatus() });
    } catch (err) {
        console.error('Outlook forward enable error:', err);
        res.status(400).json({ error: err.message || 'Failed to enable forward' });
    }
});

router.delete('/outlook/forward', (req, res) => {
    try {
        res.json(mailForward.disableForward(req.user.id));
    } catch (err) {
        console.error('Outlook forward disable error:', err);
        res.status(500).json({ error: err.message || 'Failed to disable forward' });
    }
});

router.post('/outlook/device-code', async (req, res) => {
    try {
        const started = await outlookMail.startDeviceCode();
        res.json(started);
    } catch (err) {
        console.error('Outlook device-code error:', err);
        res.status(400).json({ error: err.message || 'Failed to start Outlook device login' });
    }
});

/** Short poll (client loops). Returns pending | connected | error. */
router.post('/outlook/device-code/poll', async (req, res) => {
    try {
        const deviceCode = String(req.body?.device_code || '').trim();
        if (!deviceCode) return res.status(400).json({ error: 'device_code required' });
        const account = await outlookMail.pollDeviceCode(req.user.id, deviceCode, {
            maxWaitMs: 20_000
        });
        res.json({ status: 'connected', account });
    } catch (err) {
        const msg = err?.message || String(err);
        if (/authorization_pending|Timed out waiting/i.test(msg) || /authorization pending/i.test(msg)) {
            return res.json({ status: 'pending' });
        }
        // pollDeviceCode throws on real failures; pending loops throw "Timed out"
        // after maxWaitMs with no token — treat as still pending for the client loop.
        if (/Timed out waiting for Outlook/i.test(msg)) {
            return res.json({ status: 'pending' });
        }
        console.error('Outlook device-code poll error:', err);
        res.status(400).json({ error: msg || 'Outlook poll failed', status: 'error' });
    }
});

/** Create / renew Graph push for one mailbox, or all if mailbox_id omitted. */
router.post('/outlook/subscribe', async (req, res) => {
    try {
        const mailboxId = parseInt(req.body?.mailbox_id, 10);
        if (mailboxId) {
            const box = outlookMail.getMailboxForUser(req.user.id, mailboxId);
            if (!box) return res.status(404).json({ error: 'Mailbox not found' });
            const sub = await outlookMail.ensureMailSubscription(mailboxId);
            return res.json({
                subscription: sub,
                accounts: outlookMail.listMailboxesPublic(req.user.id)
            });
        }
        const all = await outlookMail.ensureAllSubscriptions(req.user.id);
        res.json({ ...all, accounts: outlookMail.listMailboxesPublic(req.user.id) });
    } catch (err) {
        console.error('Outlook subscribe error:', err);
        res.status(400).json({ error: err.message || 'Subscribe failed' });
    }
});

router.post('/outlook/sync', async (req, res) => {
    try {
        const mailboxId = parseInt(req.body?.mailbox_id, 10);
        const result = mailboxId
            ? await outlookMail.syncInbox(mailboxId)
            : await outlookMail.syncAllMailboxesForUser(req.user.id);
        res.json({ ...result, accounts: outlookMail.listMailboxesPublic(req.user.id) });
    } catch (err) {
        console.error('Outlook sync error:', err);
        res.status(400).json({ error: err.message || 'Outlook sync failed' });
    }
});

router.get('/outlook/messages', (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 30;
        const messages = outlookMail.listMessages(req.user.id, { limit });
        res.json({ messages });
    } catch (err) {
        console.error('Outlook messages error:', err);
        res.status(500).json({ error: err.message || 'Failed to list messages' });
    }
});

/** Block until a security-code email arrives (used by Auto Bidder AFK). */
router.post('/outlook/wait-otp', async (req, res) => {
    try {
        const timeoutMs = Math.min(
            10 * 60 * 1000,
            Math.max(15_000, Number(req.body?.timeoutMs) || 180_000)
        );
        const result = await outlookMail.waitForOtp(req.user.id, {
            timeoutMs,
            pollMs: Math.max(3000, Number(req.body?.pollMs) || 5000),
            afterIso: req.body?.afterIso || null,
            fromHint: req.body?.fromHint || 'greenhouse'
        });
        if (!result.ok) {
            return res.status(408).json(result);
        }
        res.json(result);
    } catch (err) {
        console.error('Outlook wait-otp error:', err);
        res.status(400).json({ error: err.message || 'wait-otp failed' });
    }
});

router.delete('/outlook/mailboxes/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const result = await outlookMail.disconnectMailbox(req.user.id, id);
        if (!result.ok) return res.status(404).json(result);
        res.json({ ...result, accounts: outlookMail.listMailboxesPublic(req.user.id) });
    } catch (err) {
        console.error('Outlook mailbox disconnect error:', err);
        res.status(500).json({ error: err.message || 'Disconnect failed' });
    }
});

router.delete('/outlook', (req, res) => {
    try {
        res.json(outlookMail.disconnect(req.user.id));
    } catch (err) {
        console.error('Outlook disconnect error:', err);
        res.status(500).json({ error: err.message || 'Disconnect failed' });
    }
});

module.exports = router;
