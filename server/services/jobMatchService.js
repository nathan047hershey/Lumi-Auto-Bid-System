// =============================================================================
// services/jobMatchService.js
// =============================================================================
//
// Background processing pipeline for the new "auto apply" feature:
//
//   1. Every 5 minutes a cron scans `job_links` for freshly-fetched
//      rows (fetch_status='success') that haven't been processed
//      yet.
//   2. For each row, we score every candidate profile by:
//        a) Region match       (exact flag match)
//        b) Techstack match     (intersection of profile.techstacks
//                                with job_links.techstack)
//        c) Optional tech stack overlap against profile.work_experience
//                                (keyword scan — gentle signal)
//   3. We pick the top-N profiles (N=3 by default; tunable) and
//      generate a resume for each via the existing resumeService
//      pipeline.
//   4. Each generated resume lands as a new job_applications row
//      with source='auto', job_link_id pointing back, and a
//      generation_status that walks:
//          pending → generating → ready (or failed)
//
// The service deliberately reuses the existing resumeService +
// templateService + userTemplateService pipeline — no new
// generation logic. The cron is "wire a job-link to that pipeline
// many times" rather than "build a new generator".
// =============================================================================

const fs = require('fs');
const path = require('path');
const {
    getOne, getAll, runQuery, saveDatabase,
    withTransaction, txRunQuery, getDb
} = require('../config/database');
const resumeService = require('./resumeService');
const { asNodeBuffer } = require('../utils/asNodeBuffer');
const templateService = require('./templateService');
const userTemplateService = require('./userTemplateService');
const resumeQueue = require('./resumeQueueService');
const { evaluateBidEligibility } = require('./bidEligibilityRules');
const {
    sqliteUtcToIso,
    parseSqliteUtcMs,
    generationDurationMs
} = require('../lib/generationClock');

// Tunables via env so admins can throttle in prod without code changes.
// All values are also mutable at runtime via the
// GET/PUT /admin/auto-apply/config endpoint — the env values
// just set the initial values. Bounds below stop an admin from
// accidentally asking the cron to walk the whole table every tick.
const DEFAULTS = {
    intervalMs: parseInt(process.env.AUTO_APPLY_CRON_MS || 5 * 60 * 1000, 10),
    // Default to "all available profiles" (no truncation). The
    // old default of 5 was a safety cap while the pipeline was
    // new; with the RabbitMQ worker in place each enqueue is
    // cheap so admins want the full matching set per job link.
    // Set AUTO_APPLY_MAX_PROFILES to a finite number to cap
    // batch size if needed.
    maxProfilesPerJob: parseInt(
        process.env.AUTO_APPLY_MAX_PROFILES || Number.MAX_SAFE_INTEGER, 10
    ),
    maxJobsPerTick: parseInt(
        process.env.AUTO_APPLY_JOBS_PER_TICK || Number.MAX_SAFE_INTEGER, 10
    ),
    staleGeneratingMs: parseInt(process.env.AUTO_APPLY_STALE_GENERATING_MS || 10 * 60 * 1000, 10),
    runOnBoot: (process.env.AUTO_APPLY_RUN_ON_BOOT || '1') !== '0',
    // Daily bid caps (Mode 2). Defaults until admin/user tunes them.
    maxPerProfilePerDay: parseInt(process.env.AUTO_APPLY_MAX_PER_PROFILE_DAY || '100', 10),
    maxTotalPerDay: parseInt(process.env.AUTO_APPLY_MAX_TOTAL_DAY || '500', 10)
};
const BOUNDS = {
    intervalMs:        { min: 30 * 1000,        max: 60 * 60 * 1000 },
    // No upper bound: admins want "all matching profiles" per
    // job link. Lower bound is still 1 (defensive — zero would
    // mean "skip every job").
    maxProfilesPerJob: { min: 1,                max: Number.MAX_SAFE_INTEGER },
    maxJobsPerTick:    { min: 1,                max: Number.MAX_SAFE_INTEGER },
    staleGeneratingMs: { min: 60 * 1000,        max: 60 * 60 * 1000 },
    maxPerProfilePerDay: { min: 1, max: 500 },
    maxTotalPerDay: { min: 1, max: 2000 }
};
const enabled = (process.env.AUTO_APPLY_CRON_DISABLED || '0') !== '1';
// Mutable config — read by the cron loop and exposed via
// getConfig / updateConfig so the admin UI can tune without
// restarting the server.
const config = { ...DEFAULTS };
// Backwards-compat aliases (some call sites still read the old
// const names; they now reference the mutable `config` object).
const CRON_INTERVAL_MS = () => config.intervalMs;
const MAX_PROFILES_PER_JOB = () => config.maxProfilesPerJob;
const MAX_JOBS_PER_TICK = () => config.maxJobsPerTick;
const STALE_GENERATING_MS = () => config.staleGeneratingMs;

const { RESUMES_DIR: resumesDir } = require('../config/paths');

// In-memory state (read by GET /job-links/:id/applications status
// sidebar in the UI). Exported so the route layer can read it for
// the "is the cron running?" status indicator.
let lastRunAt = null;
let lastError = null;
let running = false;
let workerHandle = null;
let shuttingDown = false;

// -----------------------------------------------------------------------------
// Region / techstack matcher
// -----------------------------------------------------------------------------

/**
 * Score a single (profile, job_link) pair. Higher = better fit.
 * The breakdown is intentionally simple so the score is easy to
 * explain in the UI:
 *   +1.0 if profile.location_flag === job_link.location_flag
 *   +0.7 if profile's techstacks include the job's techstack
 *   +0.3 keyword overlap between profile.work_experience and
 *       the job description (capped)
 * Returns null if the profile should be skipped (region mismatch
 * is a hard filter; techstack mismatch softens the score but
 * still allows the candidate in).
 */
function scoreProfile(profile, jobLink) {
    if (!profile || !jobLink) return null;

    let score = 0;

    // Hard region filter. We deliberately do NOT skip on region
    // mismatch because the admin may want to consider profiles
    // flagged "EU" for a US role if the JD says "Remote, US-based
    // or EU". Instead we apply a heavy penalty so they sink to
    // the bottom of the list without being filtered out.
    const profileFlag = profile.location_flag || 'US';
    const jobFlag = jobLink.location_flag || 'US';
    if (profileFlag === jobFlag) {
        score += 1.0;
    } else {
        score -= 0.5;
    }

    // Techstack intersection.
    const profileTechstacks = Array.isArray(profile.techstacks)
        ? profile.techstacks
        : [];
    if (jobLink.techstack && profileTechstacks.includes(jobLink.techstack)) {
        score += 0.7;
    } else {
        score -= 0.2;
    }

    // Lightweight keyword overlap between work_experience text and
    // the job description. We only skim a small set of high-signal
    // words (tech tokens) so a long JD doesn't drown the score.
    const jd = (jobLink.job_description || '').toLowerCase();
    if (jd && profile.work_experience) {
        const workText = String(profile.work_experience).toLowerCase();
        // Pull short tokens (3+ chars, alphanumeric) from each
        // side and intersect. Cap to 8 matches so a noisy JD
        // doesn't overshoot.
        const tokenize = (s) => new Set((s.match(/\b[a-z][a-z0-9+#.-]{2,}\b/g) || []).slice(0, 400));
        const jdTokens = tokenize(jd);
        const workTokens = tokenize(workText);
        let hits = 0;
        for (const t of jdTokens) {
            if (workTokens.has(t)) {
                hits += 1;
                if (hits >= 8) break;
            }
        }
        score += Math.min(0.3, hits * 0.05);
    }

    return score;
}

/**
 * Score every profile for a job and return the top N.
 *
 * Hard filter: profile.techstacks MUST include job_link.techstack
 * (when the job has a techstack set).
 *
 * Region: prefer exact location_flag match. If that yields nobody,
 * fall back to same-techstack any-region so EU/Brazil jobs still
 * get CVs when profiles are US-tagged (common in this product).
 */
function loadPriorAppliedForProfile(profileId) {
    return loadPriorAppliedForProfiles([profileId]).get(Number(profileId)) || [];
}

/** Batch prior applied rows for many profiles (avoids N+1 in pickTopProfiles). */
function loadPriorAppliedForProfiles(profileIds) {
    const map = new Map();
    const ids = [...new Set((profileIds || []).map((id) => Number(id)).filter((id) => id > 0))];
    for (const id of ids) map.set(id, []);
    if (!ids.length) return map;
    const rows = getAll(`
        SELECT prev.id, prev.profile_id, prev.company_name, prev.job_role,
               prev.job_description, prev.core_skills, prev.status,
               prev.updated_at, prev.created_at,
               jl.techstack AS link_techstack,
               (
                 SELECT bc.applied_at FROM bid_courses bc
                  WHERE bc.application_id = prev.id
                  ORDER BY bc.id DESC LIMIT 1
               ) AS applied_at
          FROM job_applications prev
          LEFT JOIN job_links jl ON jl.id = prev.job_link_id
         WHERE prev.profile_id IN (${ids.map(() => '?').join(',')})
           AND COALESCE(prev.status, '') = 'applied'
    `, ids);
    for (const p of rows) {
        const key = Number(p.profile_id);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(p);
    }
    return map;
}

/**
 * Company / stack / same-job / cooldown gates before generating a CV.
 */
function canEnqueueForCompanyRules(jobLink, profileId, priorsByProfileId = null) {
    const candidate = {
        id: 0,
        profile_id: profileId,
        company_name: jobLink.company_name,
        job_role: jobLink.position_title,
        job_description: jobLink.job_description,
        core_skills: jobLink.techstack || '',
        techstack: jobLink.techstack || '',
        link_techstack: jobLink.techstack || ''
    };
    const priors = priorsByProfileId
        ? (priorsByProfileId.get(Number(profileId)) || [])
        : loadPriorAppliedForProfile(profileId);
    return evaluateBidEligibility(candidate, priors);
}

function pickTopProfiles(jobLink, limit = MAX_PROFILES_PER_JOB()) {
    const techstack = jobLink.techstack;
    const jobRegion = jobLink.location_flag || 'US';

    let profiles;
    if (techstack) {
        profiles = getAll(`
            SELECT p.*
            FROM candidate_profiles p
            WHERE EXISTS (
                SELECT 1 FROM profile_techstacks t
                WHERE t.profile_id = p.id AND t.techstack = ?
            )
        `, [techstack]);
    } else {
        profiles = getAll('SELECT * FROM candidate_profiles');
    }

    // Hydrate techstacks array for each profile in one round-trip.
    const techRows = getAll('SELECT profile_id, techstack FROM profile_techstacks');
    const techByProfile = new Map();
    for (const r of techRows) {
        if (!techByProfile.has(r.profile_id)) techByProfile.set(r.profile_id, []);
        techByProfile.get(r.profile_id).push(r.techstack);
    }

    // Exclude profiles that already have an application for this
    // job_link so the cron is idempotent.
    const existingAppProfileIds = new Set(
        getAll(
            'SELECT DISTINCT profile_id FROM job_applications WHERE job_link_id = ?',
            [jobLink.id]
        ).map((r) => r.profile_id)
    );

    const scored = [];
    const candidateIds = profiles
        .map((p) => p.id)
        .filter((id) => !existingAppProfileIds.has(id));
    const priorsByProfileId = loadPriorAppliedForProfiles(candidateIds);
    for (const p of profiles) {
        if (existingAppProfileIds.has(p.id)) continue;
        p.techstacks = techByProfile.get(p.id) || [];
        if (techstack && !(p.techstacks || []).includes(techstack)) continue;
        const companyGate = canEnqueueForCompanyRules(jobLink, p.id, priorsByProfileId);
        if (!companyGate.ok) continue;
        const s = scoreProfile(p, jobLink);
        if (s == null) continue;
        scored.push({ profile: p, score: s });
    }

    // Prefer same-region first; if none, keep techstack matches (any region).
    const sameRegion = scored.filter(
        (row) => (row.profile.location_flag || 'US') === jobRegion
    );
    const pool = sameRegion.length > 0 ? sameRegion : scored;
    pool.sort((a, b) => b.score - a.score);
    return pool.slice(0, limit);
}

// -----------------------------------------------------------------------------
// Resume generation (extracted so the route handler and the cron
// call the same pipeline).
// -----------------------------------------------------------------------------

/**
 * Resolve a profile's preferred template spec into a style_spec
 * object the renderer can consume. Mirrors the route-layer logic
 * exactly so the cron produces the same DOCX a manual run would.
 */
function resolveTemplateSpecForProfile(profile) {
    const tid = profile.preferred_template_id;
    const kind = profile.preferred_template_kind || 'admin';
    if (!tid) {
        return {
            styleSpec: templateService.resolveStyleSpec({ templateId: null }),
            templateId: null,
            source: 'admin'
        };
    }
    if (kind === 'user') {
        const spec = userTemplateService.resolveStyleSpecAnyOwner(tid)
            || templateService.resolveStyleSpec({ templateId: null });
        return {
            styleSpec: spec,
            templateId: tid,
            source: 'user'
        };
    }
    return {
        styleSpec: templateService.resolveStyleSpec({ templateId: tid }),
        templateId: tid,
        source: 'admin'
    };
}

function pickFontFromStyleSpec(styleSpec, font = null) {
    const explicit = templateService.normaliseFontName(font);
    if (explicit) return explicit;
    const pool = Array.isArray(styleSpec?.body?.font_pool)
        ? styleSpec.body.font_pool
            .map((f) => templateService.normaliseFontName(f))
            .filter(Boolean)
        : [];
    if (pool.length > 0) {
        return pool[Math.floor(Math.random() * pool.length)];
    }
    return templateService.normaliseFontName(styleSpec?.body?.font)
        || templateService.normaliseFontName(styleSpec?.fonts?.body)
        || 'Arial';
}

/**
 * Live template + font the profile is assigned right now. Used both
 * to stamp the application row (so the card shows template #N / font
 * before the DOCX exists) and to drive generateResumeForPair.
 */
function intendedTemplateForProfile(profile, font = null) {
    const resolved = resolveTemplateSpecForProfile(profile);
    return {
        ...resolved,
        font: pickFontFromStyleSpec(resolved.styleSpec, font)
    };
}

function stampProfileTemplateOnApplication(applicationId, profile, font = null) {
    const intended = intendedTemplateForProfile(profile, font);
    runQuery(
        `UPDATE job_applications
         SET template_id = ?, font_family = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [intended.templateId || null, intended.font || 'Arial', applicationId]
    );
    saveDatabase();
    return intended;
}

/** Queue a CV without starting the live Generating clock (serial worker). */
function markApplicationQueuedForGeneration(applicationId, profile) {
    const intended = intendedTemplateForProfile(profile);
    runQuery(
        `UPDATE job_applications
         SET generation_status = 'pending',
             generation_error = NULL,
             generation_started_at = NULL,
             generation_finished_at = NULL,
             generation_ms = NULL,
             template_id = ?,
             font_family = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [intended.templateId || null, intended.font || 'Arial', applicationId]
    );
    saveDatabase();
    return intended;
}

/**
 * Generate one resume for one (profile, job_link) pair. The output
 * matches the shape of resumeService.generateResume so the route
 * handler can keep its current return contract. Throws on
 * generation failure; callers decide whether to retry / mark the
 * row failed.
 */
async function generateResumeForPair(profile, jobLink, font = null, genOptions = {}) {
    const { styleSpec, templateId, source, font: resolvedFont } = intendedTemplateForProfile(profile, font);
    const jobDescription = jobLink.job_description || '';
    const companyName = jobLink.company_name || 'Unknown';
    const jobRole = jobLink.position_title || '';

    const result = await resumeService.generateResume(
        profile,
        jobDescription,
        companyName,
        {
            styleSpec,
            font: resolvedFont,
            templateId,
            jobUrl: jobLink.job_apply_url || jobLink.source_url || '',
            _cvLockHeld: !!genOptions._cvLockHeld
        }
    );

    // Persist the DOCX file. Filename pattern mirrors the route
    // handler so existing /resumes/<file> serving works without
    // any change.
    const fname = result.filename
        || resumeService.buildArchiveResumeFilename(profile, companyName, Date.now(), '.docx');
    const filepath = path.join(resumesDir, fname);
    const buf = await asNodeBuffer(result.resumeBuffer);
    fs.writeFileSync(filepath, buf);
    const uploadFilename = await resumeService.writeReadyResumeCopy(buf, profile)
        || result.upload_filename
        || resumeService.buildUploadResumeFilename(profile);

    const pdfFilename = await require('./resumePdfService').writePdfAlongsideDocx({
        resumesDir,
        docxFilename: fname,
        resumeHtml: result.resumeHtml,
        styleSpec,
        font: resolvedFont
    });

    return {
        filename: fname,
        uploadFilename,
        pdfFilename,
        templateId,
        font: resolvedFont,
        source,
        html: result.resumeHtml,
        providerUsed: result.provider_used,
        fallbackUsed: result.fallback_used
    };
}

// -----------------------------------------------------------------------------
// Per-job processing
// -----------------------------------------------------------------------------

function getDailyBidCounts(userId = null) {
    // Count auto-source applications created today (UTC date via SQLite date()).
    const totalRow = getOne(`
        SELECT COUNT(*) AS c FROM job_applications
        WHERE source = 'auto'
          AND date(created_at) = date('now')
    `);
    const byProfile = getAll(`
        SELECT profile_id, COUNT(*) AS c FROM job_applications
        WHERE source = 'auto'
          AND date(created_at) = date('now')
        GROUP BY profile_id
    `);
    const perProfile = {};
    for (const row of byProfile) {
        perProfile[row.profile_id] = row.c;
    }

    let userTotal = null;
    if (userId != null) {
        const u = getOne(`
            SELECT COUNT(*) AS c
            FROM job_applications a
            JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
            WHERE ua.user_id = ?
              AND a.source = 'auto'
              AND date(a.created_at) = date('now')
        `, [userId]);
        userTotal = u?.c || 0;
    }

    return {
        total: totalRow?.c || 0,
        perProfile,
        userTotal
    };
}

function canEnqueueProfileToday(profileId) {
    const counts = getDailyBidCounts();
    if ((counts.total || 0) >= config.maxTotalPerDay) {
        return { ok: false, reason: 'total_day_cap' };
    }
    if ((counts.perProfile[profileId] || 0) >= config.maxPerProfilePerDay) {
        return { ok: false, reason: 'profile_day_cap' };
    }
    return { ok: true };
}

/**
 * Insert one `pending` row into job_applications for a
 * (profile, job_link) pair and enqueue a RabbitMQ message so
 * the resume-generation worker picks it up. The worker is the
 * one that actually generates the DOCX — this function only
 * prepares the work item.
 *
 * Returns the new applicationId (or null on insert failure).
 */
function enqueueForPair(jobLink, profile, score) {
    const gate = canEnqueueProfileToday(profile.id);
    if (!gate.ok) {
        console.log(
            `[autoApply] skip enqueue profile=${profile.id} job_link=${jobLink.id} (${gate.reason})`
        );
        return null;
    }
    const companyGate = canEnqueueForCompanyRules(jobLink, profile.id);
    if (!companyGate.ok) {
        console.log(
            `[autoApply] skip enqueue profile=${profile.id} job_link=${jobLink.id} (${companyGate.code}: ${companyGate.message})`
        );
        return null;
    }
    let applyUrl = jobLink.job_apply_url || '';
    try {
        const { canonicalizeGreenhouseApplyUrl, isGreenhouseUrl } = require('./scraper/greenhouseUrl');
        if (applyUrl && isGreenhouseUrl(applyUrl)) {
            applyUrl = canonicalizeGreenhouseApplyUrl(applyUrl) || applyUrl;
        }
    } catch (_) { /* ignore */ }
    const intended = intendedTemplateForProfile(profile);
    const ins = runQuery(
        `INSERT INTO job_applications
            (profile_id, company_name, job_role, core_skills,
             job_description, job_url, resume_filename, applier_id,
             status, state, source, job_link_id, match_score,
             generation_status, template_id, font_family)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 'in_progress',
                 'auto', ?, ?, 'pending', ?, ?)`,
        [
            profile.id,
            jobLink.company_name || 'Unknown',
            jobLink.position_title || '',
            jobLink.techstack || '',
            jobLink.job_description || '',
            applyUrl,
            null,
            jobLink.id,
            score,
            intended.templateId || null,
            intended.font || 'Arial'
        ]
    );
    const applicationId = ins.lastInsertRowid;
    saveDatabase();
    return applicationId;
}

/**
 * Worker-side handler. Pulls the freshest profile + job_link
 * from the DB (the message body is just ids, since DB is the
 * source of truth), generates the resume, and updates the
 * job_applications row to ready/failed.
 *
 * Throws on failure — the queue layer nacks the message and
 * the row stays in 'pending' / 'failed' for the UI to surface.
 */
async function processQueuedPair({ profileId, jobLinkId, correlationId, force } = {}) {
    const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [profileId]);
    const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
    if (!profile || !jobLink) {
        // Orphan queue message — the job_link or candidate_profile was
        // deleted between enqueue and dispatch. The right move is to
        // garbage-collect every job_applications row that points at the
        // missing entity so the cron doesn't keep enqueueing new
        // messages for a job that no longer exists. Without this, the
        // worker would nack the message forever and the orphan row
        // would block throughput on every tick.
        const missing = [];
        if (!jobLink) missing.push('job_link');
        if (!profile) missing.push('profile');
        const cleaned = runQuery(
            `DELETE FROM job_applications
              WHERE profile_id = ? AND job_link_id = ?`,
            [profileId, jobLinkId]
        );
        const orphanCount = (cleaned && typeof cleaned === 'object' && 'changes' in cleaned)
            ? cleaned.changes
            : 0;
        console.warn(
            `[resumeQueue] orphan detected (missing: ${missing.join(', ')}) — ` +
            `deleted ${orphanCount} job_applications row(s) for ` +
            `profile=${profileId} job_link=${jobLinkId}`
        );
        // Don't throw — there's nothing to retry and we don't want the
        // queue layer to nack-and-retry a known-bad message. The DB
        // cleanup is the recovery. Return `skipped` so the caller acks.
        return { skipped: true, orphan: true, deleted: orphanCount };
    }
    // Refuse to re-process a row that's already done. The cron
    // is idempotent (NOT EXISTS) but a manual re-enqueue from
    // the UI could land here. Belt-and-braces.
    const existing = getOne(
        `SELECT id, generation_status, generation_started_at
           FROM job_applications WHERE profile_id = ? AND job_link_id = ?`,
        [profileId, jobLinkId]
    );
    if (!existing) {
        throw new Error(`no job_applications row for profile=${profileId} job_link=${jobLinkId}`);
    }
    const forceRegen = force === true
        || /^regen[-_]/i.test(String(correlationId || ''));
    if (existing.generation_status === 'ready' && !forceRegen) {
        console.log(
            `[autoApply] worker: skip already-ready application id=${existing.id} ` +
            `(job_link=${jobLinkId} profile=${profileId})`
        );
        return { skipped: true };
    }

    // Re-read the profile's template at worker start so a template
    // assigned after the row was created is used on this run.
    const intended = intendedTemplateForProfile(profile);

    // Take the CV lock BEFORE flipping status to `generating`.
    // Otherwise the UI live timer includes wait time behind another
    // MiniMax call (manual regenerate + queue, or retry overlap).
    return resumeService.withCvGenerateLock(async () => {
        const latest = getOne(
            `SELECT id, generation_status, generation_started_at
               FROM job_applications WHERE id = ?`,
            [existing.id]
        );
        if (!latest) {
            throw new Error(`no job_applications row id=${existing.id}`);
        }
        if (latest.generation_status === 'ready' && !forceRegen) {
            return { skipped: true };
        }

        const resetClock = latest.generation_status !== 'generating';
        const keptStartMs = resetClock ? null : parseSqliteUtcMs(latest.generation_started_at);
        runQuery(
            `UPDATE job_applications
             SET generation_status = 'generating',
                 template_id = ?,
                 font_family = ?,
                 generation_error = NULL,
                 generation_started_at = ${resetClock ? "datetime('now')" : "COALESCE(generation_started_at, datetime('now'))"},
                 generation_finished_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [intended.templateId || null, intended.font || 'Arial', latest.id]
        );
        saveDatabase();
        const stamped = getOne(
            'SELECT generation_started_at FROM job_applications WHERE id = ?',
            [latest.id]
        );
        const genStartedAt = parseSqliteUtcMs(stamped?.generation_started_at);
        const startMs = Number.isFinite(genStartedAt)
            ? genStartedAt
            : (Number.isFinite(keptStartMs) ? keptStartMs : Date.now());

        try {
            const gen = await generateResumeForPair(profile, jobLink, intended.font, { _cvLockHeld: true });
            const finishedAt = Date.now();
            const generationMs = generationDurationMs(startMs, finishedAt) || Math.max(1, finishedAt - startMs);
            runQuery(
                `UPDATE job_applications
                 SET resume_filename = ?, template_id = ?, font_family = ?,
                     generation_status = 'ready', generation_error = NULL,
                     generation_ms = ?,
                     generation_started_at = COALESCE(generation_started_at, datetime('now')),
                     generation_finished_at = datetime('now'),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [gen.filename, gen.templateId, gen.font, generationMs, latest.id]
            );
            saveDatabase();
            try {
                const bidCourseService = require('./bidCourseService');
                const assignee = getOne(
                    `SELECT user_id FROM user_profile_assignments WHERE profile_id = ? ORDER BY user_id ASC LIMIT 1`,
                    [profileId]
                );
                if (assignee?.user_id) {
                    bidCourseService.recordGenerateDone({
                        applicationId: latest.id,
                        profileId,
                        userId: assignee.user_id,
                        jobUrl: jobLink.job_apply_url || jobLink.source_url || null,
                        companyName: jobLink.company_name || null,
                        jobRole: jobLink.position_title || null,
                        templateId: gen.templateId,
                        fontFamily: gen.font,
                        cvProvider: gen.provider || null
                    });
                }
            } catch (courseErr) {
                console.warn('[autoApply] bid-course generate_done log failed:', courseErr.message);
            }
            return { filename: gen.filename };
        } catch (err) {
            const failMs = generationDurationMs(startMs, Date.now());
            runQuery(
                `UPDATE job_applications
                 SET generation_status = 'failed',
                     generation_error = ?,
                     generation_ms = COALESCE(?, generation_ms),
                     generation_finished_at = datetime('now'),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [(err.message || String(err)).slice(0, 500), failMs, latest.id]
            );
            saveDatabase();
            throw err;
        }
    });
}

/**
 * Backwards-compat shim. The cron used to call this to
 * "generate everything inline"; now it just enqueues. We keep
 * the name so existing call sites don't break, and to make it
 * obvious that the work moved from this file to the queue.
 *
 * Returns the number of (profile, job_link) pairs successfully
 * enqueued.
 */
async function processJobLink(jobLink, profileScores) {
    let enqueued = 0;
    for (const { profile, score } of profileScores) {
        try {
            const appId = enqueueForPair(jobLink, profile, score);
            if (!appId) continue;
            // enqueueGeneration prefers RabbitMQ; when the broker is down it
            // pushes onto the in-process serial queue (never leaves rows pending).
            await resumeQueue.enqueueGeneration(profile.id, jobLink.id, {
                correlationId: `app-${appId}`
            });
            enqueued += 1;
        } catch (err) {
            console.error(
                `[autoApply] enqueue failed for job_link=${jobLink.id} profile=${profile.id}:`,
                err.message
            );
        }
    }
    return enqueued;
}

/**
 * After techstack / region metadata changes, enqueue CV generation for
 * newly matching profiles that do not already have an application row.
 */
async function reconcileJobLinkAfterMetadataChange(jobLinkId) {
    const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
    if (!jobLink) return { enqueued: 0 };
    if (!jobLink.job_description || !String(jobLink.job_description).trim()) {
        return { enqueued: 0 };
    }
    const profileScores = pickTopProfiles(jobLink, config.maxProfilesPerJob);
    if (!profileScores.length) return { enqueued: 0 };
    const enqueued = await processJobLink(jobLink, profileScores);
    return { enqueued };
}

/**
 * Enqueue missing CVs for a list of job_links (new profiles on
 * already-processed jobs). Caps at 50 ids per call so a bulk
 * refresh cannot stall the API.
 */
async function reconcileJobLinks(ids) {
    const unique = [...new Set((ids || []).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n) && n > 0))];
    const limited = unique.slice(0, 50);
    let enqueued = 0;
    const results = [];
    for (const id of limited) {
        try {
            const r = await reconcileJobLinkAfterMetadataChange(id);
            const n = r.enqueued || 0;
            enqueued += n;
            results.push({ id, enqueued: n });
        } catch (err) {
            results.push({ id, enqueued: 0, error: err.message || String(err) });
        }
    }
    return { enqueued, ids: limited, results };
}

// -----------------------------------------------------------------------------
// Cron loop
// -----------------------------------------------------------------------------

/**
 * Refresh the queue: pull job_links that are fetched AND don't
 * have any 'auto' applications yet. We don't claim them with a
 * status flag here because the work is long (resume generation)
 * and we want the UI to see the per-application progress. The
 * per-application row's generation_status is what the cron uses
 * to serialize.
 */
function refreshQueue() {
    // Fetched job_links that still need CVs: either never processed,
    // or a newer matching profile was added after the first pass.
    // pickTopProfiles skips profiles that already have an application,
    // so re-visiting a job is cheap when nothing is missing.
    const rows = getAll(`
        SELECT jl.*
        FROM job_links jl
        WHERE jl.fetch_status = 'success'
          AND jl.job_description IS NOT NULL
          AND jl.job_description <> ''
          AND EXISTS (
            SELECT 1
            FROM candidate_profiles p
            WHERE (
                jl.techstack IS NULL OR EXISTS (
                    SELECT 1 FROM profile_techstacks t
                    WHERE t.profile_id = p.id AND t.techstack = jl.techstack
                )
            )
            AND NOT EXISTS (
                SELECT 1 FROM job_applications ja
                WHERE ja.job_link_id = jl.id AND ja.profile_id = p.id
            )
          )
        ORDER BY jl.last_fetched_at ASC, jl.id ASC
        LIMIT ?
    `, [MAX_JOBS_PER_TICK()]);
    return rows;
}

/**
 * Recover stale rows: any application left in `generating` for
 * more than STALE_GENERATING_MS is flipped back to `pending` so
 * the next pass picks it up. Mirrors the LinkedIn-scraper pattern
 * so a process crash mid-generation can't permanently wedge a
 * row.
 *
 * We deliberately do NOT write to `generation_error` here. The
 * recovery is bookkeeping, not an error: the row had no recorded
 * error before (it was still in flight), and writing
 * 'recovered after stale timeout' causes the UI to render a
 * misleading red error box for what is actually a normal retry.
 * If the row had a prior error string we preserve it for
 * debugging (COALESCE), but a NULL prior error stays NULL.
 */
function cleanupStaleGenerating() {
    try {
        const r = runQuery(
            `UPDATE job_applications
             SET generation_status = 'pending',
                 updated_at = CURRENT_TIMESTAMP
             WHERE generation_status = 'generating'
               AND updated_at < datetime('now', '-' || ? || ' seconds')`,
            [Math.floor(STALE_GENERATING_MS() / 1000)]
        );
        if (r.changes > 0) {
            console.log(`[autoApply] recovered ${r.changes} stale-generating applications`);
            saveDatabase();
        }
    } catch (e) {
        console.warn('[autoApply] cleanupStaleGenerating failed:', e.message);
    }
}

/**
 * The in-process queue dies with the Node process. Any row left in
 * `generating` at boot is orphaned (nodemon restart, crash, deploy).
 * Flip them back to pending immediately so the UI does not show a
 * dozen live clocks, then requeueStuckPendingApplications can pick
 * them up. The 10-minute stale timeout still covers a hung worker
 * during a live run.
 */
function resetOrphanedGeneratingOnBoot() {
    try {
        const r = runQuery(
            `UPDATE job_applications
             SET generation_status = 'pending',
                 generation_started_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE generation_status = 'generating'`
        );
        if (r.changes > 0) {
            console.log(`[autoApply] reset ${r.changes} orphaned generating row(s) after process start`);
            saveDatabase();
        }
    } catch (e) {
        console.warn('[autoApply] resetOrphanedGeneratingOnBoot failed:', e.message);
    }
}

/**
 * Re-enqueue auto apps stuck in `pending` with no DOCX.
 *
 * A lost queue message (common when RabbitMQ is down and the
 * in-process queue is wiped by a server restart) leaves DOCX/PDF
 * disabled forever. This pass closes that gap.
 */
async function requeueStuckPendingApplications() {
    // RabbitMQ is often down locally — the in-process queue is serial and
    // MiniMax is ~50–120s/CV. Dumping 48 jobs on boot makes every card
    // look "stuck generating" for a long time. Cap each tick.
    const limit = Math.max(
        3,
        Math.min(5, MAX_JOBS_PER_TICK() * Math.max(1, Math.min(3, MAX_PROFILES_PER_JOB())))
    );
    let rows;
    try {
        rows = getAll(
            `SELECT id, profile_id, job_link_id
             FROM job_applications
             WHERE source = 'auto'
               AND generation_status = 'pending'
               AND (resume_filename IS NULL OR resume_filename = '')
               AND job_link_id IS NOT NULL
             ORDER BY id ASC
             LIMIT ?`,
            [limit]
        );
    } catch (e) {
        console.warn('[autoApply] requeueStuckPendingApplications query failed:', e.message);
        return 0;
    }
    if (!rows.length) return 0;

    let enqueued = 0;
    for (const row of rows) {
        try {
            await resumeQueue.enqueueGeneration(row.profile_id, row.job_link_id, {
                correlationId: `requeue-app-${row.id}`
            });
            enqueued += 1;
        } catch (err) {
            console.warn(
                `[autoApply] requeue failed app=${row.id} profile=${row.profile_id} job_link=${row.job_link_id}:`,
                err.message || err
            );
        }
    }
    if (enqueued > 0) {
        console.log(`[autoApply] re-queued ${enqueued} stuck pending application(s)`);
    }
    return enqueued;
}

/**
 * CVs that died on Groq 8k TPM (413 / gpt-oss-120b) should retry on
 * MiniMax-M2.7. Re-enqueue those failed auto apps once they are still
 * marked failed with the Groq error string.
 */
async function requeueGroq413Failures() {
    let rows;
    try {
        rows = getAll(
            `SELECT id, profile_id, job_link_id, generation_error
             FROM job_applications
             WHERE job_link_id IS NOT NULL
               AND generation_status = 'failed'
               AND generation_error IS NOT NULL
               AND (
                    lower(generation_error) LIKE '%groq%'
                    OR lower(generation_error) LIKE '%gpt-oss%'
                    OR generation_error LIKE '%413%'
                    OR generation_error LIKE '%instance of Blob%'
                    OR generation_error LIKE '%data" argument must be of type string%'
               )
             ORDER BY id DESC
             LIMIT 20`,
            []
        );
    } catch (e) {
        console.warn('[autoApply] requeueGroq413Failures query failed:', e.message);
        return 0;
    }
    if (!rows.length) return 0;

    let enqueued = 0;
    for (const row of rows) {
        try {
            runQuery(
                `UPDATE job_applications
                    SET generation_status = 'pending',
                        generation_error = NULL,
                        updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`,
                [row.id]
            );
            await resumeQueue.enqueueGeneration(row.profile_id, row.job_link_id, {
                correlationId: `requeue-groq413-${row.id}`
            });
            enqueued += 1;
        } catch (err) {
            console.warn(
                `[autoApply] requeue Groq-413 failed app=${row.id}:`,
                err.message || err
            );
        }
    }
    if (enqueued > 0) {
        try { saveDatabase(); } catch (_) { /* ignore */ }
        console.log(`[autoApply] re-queued ${enqueued} failed CV(s) (Groq-413 / DOCX write)`);
    }
    return enqueued;
}

async function tick() {
    if (running || shuttingDown) return;
    running = true;
    try {
        cleanupStaleGenerating();
        // Recover pending rows whose queue messages were lost (e.g.
        // Rabbit down + process restart wiped the in-memory queue).
        await requeueStuckPendingApplications();
        await requeueGroq413Failures();
        // Refresh the broker's view of queue depth so the admin
        // UI shows the real backlog (not just our optimistic
        // counter from the publish confirm callback).
        resumeQueue.refreshQueueStats().catch(() => {});
        const queue = refreshQueue();
        // Always stamp lastRunAt, even when there's no work —
        // otherwise the admin UI's "Last run" label never
        // moves when the queue is idle, which makes it look
        // like the cron has frozen.
        lastRunAt = new Date();
        lastError = null;
        if (queue.length === 0) return;
        console.log(`[autoApply] tick — ${queue.length} job_link(s) ready`);
        let totalEnqueued = 0;
        for (const jobLink of queue) {
            const profiles = pickTopProfiles(jobLink, MAX_PROFILES_PER_JOB());
            if (profiles.length === 0) {
                console.log(`[autoApply] no profiles matched job_link=${jobLink.id} (${jobLink.company_name || jobLink.position_title || 'unknown'})`);
                continue;
            }
            const n = await processJobLink(jobLink, profiles);
            totalEnqueued += n;
        }
        if (totalEnqueued > 0) {
            console.log(`[autoApply] tick complete — enqueued ${totalEnqueued} resume-generation job(s)`);
        }
    } catch (err) {
        lastError = err;
        console.error('[autoApply] tick error:', err);
    } finally {
        running = false;
    }
}

function startCron() {
    if (workerHandle) return;
    if (!enabled) {
        console.log('[autoApply] cron disabled via env (AUTO_APPLY_CRON_DISABLED=1)');
        return;
    }
    resetOrphanedGeneratingOnBoot();
    // Run once immediately on boot (configurable) so the first
    // deploy doesn't have to wait one full interval for the first
    // pass. Then schedule.
    if (config.runOnBoot) {
        setImmediate(() => tick());
    }
    scheduleNext();
    console.log(`[autoApply] cron started (interval=${config.intervalMs}ms, max_jobs_per_tick=${config.maxJobsPerTick}, max_profiles_per_job=${config.maxProfilesPerJob}, run_on_boot=${config.runOnBoot})`);
}

/**
 * (Re-)arm the setInterval timer using the current
 * config.intervalMs. Called on boot and after every config
 * update so admins can change the cadence at runtime.
 */
function scheduleNext() {
    if (workerHandle) {
        clearInterval(workerHandle);
        workerHandle = null;
    }
    workerHandle = setInterval(tick, config.intervalMs);
}

async function stopCron() {
    shuttingDown = true;
    if (workerHandle) {
        clearInterval(workerHandle);
        workerHandle = null;
    }
    // Wait for any in-flight tick to finish (best-effort).
    for (let i = 0; i < 50 && running; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    console.log('[autoApply] cron stopped');
}

// -----------------------------------------------------------------------------
// Read helpers — used by the new /job-links/:id/applications route
// to render the per-job detail page.
// -----------------------------------------------------------------------------

/**
 * List every application tied to a job_link, newest first. Each
 * row carries the joined profile so the detail-page cards have
 * everything they need without a second round-trip.
 */
function listApplicationsForJobLink(jobLinkId) {
    const apps = getAll(
        `SELECT a.*
         FROM job_applications a
         WHERE a.job_link_id = ?
         ORDER BY a.match_score DESC NULLS LAST, a.id DESC`,
        [jobLinkId]
    );
    if (apps.length === 0) return [];
    const profileIds = [...new Set(apps.map((a) => a.profile_id))];
    // Single SELECT for all profiles — O(1) round-trips.
    const placeholders = profileIds.map(() => '?').join(',');
    const profiles = getAll(
        `SELECT p.* FROM candidate_profiles p WHERE p.id IN (${placeholders})`,
        profileIds
    );
    const byId = new Map(profiles.map((p) => [p.id, p]));
    // Hydrate techstacks too.
    const techRows = getAll(
        `SELECT profile_id, techstack FROM profile_techstacks WHERE profile_id IN (${placeholders})`,
        profileIds
    );
    const techByProfile = new Map();
    for (const r of techRows) {
        if (!techByProfile.has(r.profile_id)) techByProfile.set(r.profile_id, []);
        techByProfile.get(r.profile_id).push(r.techstack);
    }
    return apps.map((a) => {
        const p = byId.get(a.profile_id) || null;
        return {
            ...a,
            generation_started_at: sqliteUtcToIso(a.generation_started_at),
            generation_finished_at: sqliteUtcToIso(a.generation_finished_at),
            generation_updated_at: sqliteUtcToIso(a.updated_at),
            profile: p
                ? {
                    ...p,
                    techstacks: techByProfile.get(p.id) || []
                }
                : null
        };
    });
}

/**
 * List every profile that *matches* this job_link. Used by the
 * JobLinkDetail page so admins can see the full candidate pool
 * before the cron has had a chance to enqueue resumes for all of
 * them.
 *
 * Matching is STRICT here, even though the cron uses a softer
 * scorer:
 *   - profile.location_flag MUST equal job_link.location_flag
 *   - profile.techstacks MUST include job_link.techstack
 *   (when the job has no techstack set, the techstack filter is
 *   skipped — the region filter alone is the meaningful filter)
 *
 * The cron (`pickTopProfiles`) is more permissive on purpose so
 * borderline candidates can still be surfaced when the pool is
 * small. This UI panel is the admin's "who actually fits" view,
 * so we tighten the bar to keep the list focused.
 *
 * Returns one entry per profile carrying:
 *   - profile: the candidate_profiles row (+ techstacks)
 *   - score: the scoreProfile() score (still useful for sorting)
 *   - has_application: whether a job_applications row already
 *     exists for this (profile, job_link) pair
 *   - application: the job_application row if one exists, else null
 *
 * Sorted by score DESC, then by profile name ASC so deterministic.
 */
function listMatchedProfilesForJobLink(jobLinkId) {
    const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
    if (!jobLink) return [];

    // Pull every candidate profile, including the ones that
    // already have an application (so we can render the existing
    // resume on the same card).
    const profiles = getAll('SELECT * FROM candidate_profiles');
    if (profiles.length === 0) return [];

    // Hydrate techstacks in one round-trip.
    const techRows = getAll(
        'SELECT profile_id, techstack FROM profile_techstacks WHERE profile_id IN (SELECT id FROM candidate_profiles)'
    );
    const techByProfile = new Map();
    for (const r of techRows) {
        if (!techByProfile.has(r.profile_id)) techByProfile.set(r.profile_id, []);
        techByProfile.get(r.profile_id).push(r.techstack);
    }
    for (const p of profiles) {
        p.techstacks = techByProfile.get(p.id) || [];
    }

    // Look up existing applications for this job_link so we can
    // mark which profiles already have a resume generated.
    const existingApps = getAll(
        `SELECT id, profile_id, generation_status, match_score, status
           FROM job_applications
          WHERE job_link_id = ?`,
        [jobLinkId]
    );
    const appByProfile = new Map(existingApps.map((a) => [a.profile_id, a]));

    const out = [];
    const jobFlag = jobLink.location_flag || 'US';
    for (const p of profiles) {
        const score = scoreProfile(p, jobLink);
        if (score == null) continue;
        // Hard: techstack must match when the job has one.
        // Soft: prefer same region; if none share region, still show
        // same-techstack profiles (US profiles on EU jobs, etc.).
        const profileTechstacks = Array.isArray(p.techstacks) ? p.techstacks : [];
        const techstackMatch = jobLink.techstack
            ? profileTechstacks.includes(jobLink.techstack)
            : true;
        if (!techstackMatch) continue;
        const app = appByProfile.get(p.id);
        out.push({
            profile: p,
            score,
            has_application: !!app,
            application: app || null,
            region_match: (p.location_flag || 'US') === jobFlag
        });
    }

    const sameRegion = out.filter((row) => row.region_match);
    const pool = sameRegion.length > 0 ? sameRegion : out;

    // Profiles that already have an application on this link still
    // belong on the detail page after techstack/region edits.
    for (const [profileId, app] of appByProfile.entries()) {
        if (pool.some((row) => row.profile.id === profileId)) continue;
        const p = profiles.find((x) => x.id === profileId);
        if (!p) continue;
        pool.push({
            profile: p,
            score: app.match_score ?? null,
            has_application: true,
            application: app,
            region_match: (p.location_flag || 'US') === jobFlag
        });
    }

    pool.sort((a, b) => {
        if (!!b.region_match !== !!a.region_match) return b.region_match ? 1 : -1;
        if (b.score !== a.score) return b.score - a.score;
        return String(a.profile.full_name || a.profile.name || '').localeCompare(
            String(b.profile.full_name || b.profile.name || '')
        );
    });
    return pool;
}

function isBidApplied(app) {
    if (!app) return false;
    if (app.bid_applied_at || app.bid_outcome === 'applied' || app.status === 'applied') return true;
    const t = String(app.bid_last_event || '');
    if (/marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(t)) return true;
    const meta = typeof app.bid_last_meta === 'string'
        ? app.bid_last_meta
        : JSON.stringify(app.bid_last_meta || {});
    if (/^item_aborted$/i.test(t) && app.bid_filled_at && /application not found or access denied/i.test(meta)) {
        return true;
    }
    return false;
}

function profileChipRank(p) {
    if (p.bid_applied || p.status === 'applied') return 0;
    if (p.status === 'interview') return 1;
    if (p.bid_filled) return 2;
    if (p.generation_status === 'ready') return 3;
    if (p.status === 'rejected' || p.state === 'rejected' || p.state === 'cancelled') return 4;
    return 5;
}

/**
 * Attach available (matched) profiles + application state to a page of
 * job_links rows. Used by GET /job-links so the directory list can show
 * every fitting candidate and their CV / apply state without N+1 calls.
 *
 * Each `available_profiles` entry:
 *   - profile_id, first_name, last_name, location_flag
 *   - score
 *   - has_application
 *   - application_id | null
 *   - generation_status | null  (pending / generating / ready / failed)
 *   - status | null             (pending / applied / rejected / interview)
 *   - state | null              (in_progress / completed / cancelled / rejected)
 *   - bid_filled | boolean      (Auto Bidder filled the form — not SUCCESS yet)
 *   - bid_outcome | null        (unknown / applied / interview / rejected)
 */
function attachAvailableProfilesToJobLinks(jobLinks) {
    if (!Array.isArray(jobLinks) || jobLinks.length === 0) return jobLinks || [];

    const profiles = getAll('SELECT id, first_name, last_name, location_flag FROM candidate_profiles');
    if (profiles.length === 0) {
        return jobLinks.map((row) => ({ ...row, available_profiles: [] }));
    }

    const techRows = getAll(
        'SELECT profile_id, techstack FROM profile_techstacks WHERE profile_id IN (SELECT id FROM candidate_profiles)'
    );
    const techByProfile = new Map();
    for (const r of techRows) {
        if (!techByProfile.has(r.profile_id)) techByProfile.set(r.profile_id, []);
        techByProfile.get(r.profile_id).push(r.techstack);
    }
    for (const p of profiles) {
        p.techstacks = techByProfile.get(p.id) || [];
    }

    const linkIds = jobLinks.map((r) => r.id);
    const placeholders = linkIds.map(() => '?').join(',');
    const apps = getAll(
        `SELECT a.id, a.job_link_id, a.profile_id, a.generation_status, a.generation_ms,
                a.generation_started_at, a.generation_finished_at, a.status, a.state, a.match_score, a.updated_at,
                c.filled_at AS bid_filled_at, c.applied_at AS bid_applied_at, c.outcome AS bid_outcome,
                (SELECT e.event_type FROM bid_course_events e
                  WHERE e.course_id = c.id ORDER BY e.id DESC LIMIT 1) AS bid_last_event,
                (SELECT e.meta_json FROM bid_course_events e
                  WHERE e.course_id = c.id ORDER BY e.id DESC LIMIT 1) AS bid_last_meta
           FROM job_applications a
           LEFT JOIN bid_courses c ON c.application_id = a.id
          WHERE a.job_link_id IN (${placeholders})`,
        linkIds
    );
    const appsByLink = new Map();
    for (const a of apps) {
        if (!appsByLink.has(a.job_link_id)) appsByLink.set(a.job_link_id, new Map());
        // Prefer the row that has the strongest bid signal if duplicates somehow appear.
        const prev = appsByLink.get(a.job_link_id).get(a.profile_id);
        if (
            !prev
            || (isBidApplied(a) && !isBidApplied(prev))
            || (a.bid_applied_at && !prev.bid_applied_at)
            || (a.bid_filled_at && !prev.bid_filled_at)
        ) {
            appsByLink.get(a.job_link_id).set(a.profile_id, a);
        }
    }

    const toProfileChip = (p, app, score) => ({
        profile_id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        location_flag: p.location_flag || 'US',
        score,
        has_application: !!app,
        application_id: app?.id ?? null,
        generation_status: app?.generation_status ?? null,
        generation_ms: app?.generation_ms != null ? Number(app.generation_ms) : null,
        generation_started_at: sqliteUtcToIso(app?.generation_started_at),
        generation_finished_at: sqliteUtcToIso(app?.generation_finished_at),
        generation_updated_at: sqliteUtcToIso(app?.updated_at),
        status: app?.status ?? null,
        state: app?.state ?? null,
        bid_filled: !!(app?.bid_filled_at || isBidApplied(app)),
        bid_outcome: app?.bid_outcome ?? null,
        bid_applied: isBidApplied(app),
        bid_applied_at: app?.bid_applied_at ? sqliteUtcToIso(app.bid_applied_at) : null
    });

    return jobLinks.map((jobLink) => {
        const appByProfile = appsByLink.get(jobLink.id) || new Map();
        const available = [];
        const seen = new Set();
        const jobFlag = jobLink.location_flag || 'US';

        for (const p of profiles) {
            const techstackMatch = jobLink.techstack
                ? (p.techstacks || []).includes(jobLink.techstack)
                : true;
            if (!techstackMatch) continue;

            const app = appByProfile.get(p.id) || null;
            seen.add(p.id);
            available.push({
                ...toProfileChip(p, app, scoreProfile(p, jobLink)),
                region_match: (p.location_flag || 'US') === jobFlag
            });
        }

        const sameRegion = available.filter((row) => row.region_match);
        const pool = sameRegion.length > 0 ? sameRegion : available;

        // Also surface profiles that already have an application on this
        // link even if techstack/region no longer match (stale but useful).
        for (const [profileId, app] of appByProfile.entries()) {
            if (seen.has(profileId)) continue;
            const p = profiles.find((x) => x.id === profileId);
            if (!p) continue;
            pool.push(toProfileChip(p, app, app.match_score ?? null));
        }

        pool.sort((a, b) => {
            const ra = profileChipRank(a);
            const rb = profileChipRank(b);
            if (ra !== rb) return ra - rb;
            if (!!b.region_match !== !!a.region_match) return b.region_match ? 1 : -1;
            return (b.score || 0) - (a.score || 0);
        });

        return { ...jobLink, available_profiles: pool };
    });
}

// -----------------------------------------------------------------------------
// Runtime config (read & update by the admin endpoint).
// -----------------------------------------------------------------------------

/**
 * Snapshot the current cron configuration. The values come from
 * the `config` object so this always reflects the live state, not
 * the env-var defaults.
 */
function getConfig() {
    return {
        enabled,
        intervalMs: config.intervalMs,
        maxJobsPerTick: config.maxJobsPerTick,
        maxProfilesPerJob: config.maxProfilesPerJob,
        staleGeneratingMs: config.staleGeneratingMs,
        runOnBoot: config.runOnBoot,
        maxPerProfilePerDay: config.maxPerProfilePerDay,
        maxTotalPerDay: config.maxTotalPerDay
    };
}

/**
 * Apply a partial update to the cron configuration. Each value
 * is clamped to its BOUNDS range so a typo can't blow up the
 * pipeline (e.g. intervalMs=0 would setImmediate-loop the cron).
 * Returns the new effective config.
 */
function updateConfig(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
        if (!(key in config)) continue;
        if (key === 'runOnBoot') {
            config.runOnBoot = Boolean(value);
            continue;
        }
        const bound = BOUNDS[key];
        let n = Number(value);
        if (!Number.isFinite(n)) continue;
        if (bound) {
            n = Math.min(bound.max, Math.max(bound.min, Math.round(n)));
        }
        config[key] = n;
    }
    // Re-arm the interval so the new cadence takes effect
    // immediately (no need to wait for the next tick to land).
    if (workerHandle) scheduleNext();
    console.log(
        `[autoApply] config updated: interval=${config.intervalMs}ms, ` +
        `max_jobs_per_tick=${config.maxJobsPerTick}, ` +
        `max_profiles_per_job=${config.maxProfilesPerJob}, ` +
        `stale_generating_ms=${config.staleGeneratingMs}, ` +
        `run_on_boot=${config.runOnBoot}`
    );
    return getConfig();
}

module.exports = {
    // Cron lifecycle
    startCron,
    stopCron,
    // Worker lifecycle (RabbitMQ consumer that does the
    // actual generation)
    startWorker: () => resumeQueue.startWorker(processQueuedPair),
    stopWorker: () => resumeQueue.stopWorker(),
    closeQueue: () => resumeQueue.close(),
    // Config (runtime-tunable)
    getConfig,
    updateConfig,
    getDailyBidCounts,
    // Internal helpers (exported for tests / debugging)
    scoreProfile,
    pickTopProfiles,
    generateResumeForPair,
    intendedTemplateForProfile,
    stampProfileTemplateOnApplication,
    markApplicationQueuedForGeneration,
    enqueueForPair,
    canEnqueueForCompanyRules,
    processQueuedPair,
    processJobLink,
    refreshQueue,
    cleanupStaleGenerating,
    requeueStuckPendingApplications,
    tick,
    // Read helpers
    listApplicationsForJobLink,
    listMatchedProfilesForJobLink,
    attachAvailableProfilesToJobLinks,
    reconcileJobLinkAfterMetadataChange,
    reconcileJobLinks,
    // Status (for /health-style endpoint)
    getStatus() {
        return {
            running,
            lastRunAt,
            lastError: lastError ? String(lastError.message || lastError) : null,
            ...getConfig(),
            defaults: { ...DEFAULTS },
            bounds: { ...BOUNDS },
            queue: resumeQueue.getStatus()
        };
    },
    // triggerTickNow() — fire one cron pass on demand (admin
    // debug endpoint, NOT a normal user flow). Useful when an
    // admin wants to push pending job_links through the pipeline
    // without waiting for the next scheduled tick. Resolves once
    // the tick finishes. Concurrent triggers are coalesced via
    // the `running` flag so we don't double-fire.
    triggerTickNow: async function triggerTickNow() {
        if (running) {
            return { ok: false, reason: 'already-running' };
        }
        await tick();
        return { ok: true, lastRunAt, lastError: lastError ? String(lastError.message || lastError) : null };
    }
};