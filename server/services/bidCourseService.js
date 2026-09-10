/**
 * Bid-course logging: one course per application, with a timeline of events.
 * Used for analytics (what led to interviews) and autofill playbook injection.
 */
const fs = require('fs');
const path = require('path');
const { getOne, getAll, runQuery } = require('../config/database');
const { BIDDER_DIR } = require('../config/paths');

const OUTCOMES = new Set(['unknown', 'applied', 'interview', 'rejected']);

function jsonString(value) {
    if (value == null) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function addEvent(courseId, eventType, meta) {
    if (!courseId || !eventType) return;
    runQuery(
        `INSERT INTO bid_course_events (course_id, event_type, at, meta_json)
         VALUES (?, ?, CURRENT_TIMESTAMP, ?)`,
        [courseId, String(eventType).slice(0, 80), jsonString(meta || null)]
    );
}

function isTimelineNoiseEventType(eventType) {
    return /^(screenshot|screenshot_failed|live)$/i.test(String(eventType || ''));
}

function isBlankCompany(name) {
    const s = String(name || '').trim();
    // Reject placeholders and common department labels mistaken for company names.
    return !s || /^(unknown|company|job|n\/?a|none|-|engineering|product|design|marketing|sales|operations|finance|legal|hr|human resources|department|team|corp|inc)$/i.test(s);
}

function preferCompanyName(incoming, existing) {
    if (isBlankCompany(incoming)) return undefined; // don't overwrite
    if (isBlankCompany(existing)) return String(incoming).trim();
    // Keep existing good name unless incoming is clearly better (longer non-unknown)
    const next = String(incoming).trim();
    const cur = String(existing).trim();
    if (next.toLowerCase() === cur.toLowerCase()) return undefined;
    return next;
}

/** boards.greenhouse.io/acme | jobs.ashbyhq.com/bankjoy → Bankjoy */
function companyFromJobUrl(jobUrl) {
    try {
        const u = new URL(String(jobUrl || '').trim());
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const parts = u.pathname.split('/').filter(Boolean);
        let slug = '';
        if (host.includes('ashbyhq.com') && parts[0]) slug = parts[0];
        else if (host.includes('greenhouse.io') && parts[0]) {
            slug = /^(embed|jobs?|boards?)$/i.test(parts[0]) ? (parts[1] || '') : parts[0];
            if (/^job_app$/i.test(slug) || !slug) {
                const forMatch = String(u.searchParams.get('for') || '');
                if (forMatch) slug = forMatch;
            }
        } else if (host.includes('lever.co') && parts[0]) slug = parts[0];
        if (!slug || /^(jobs?|careers?|job-boards?|boards?|embed|application)$/i.test(slug)) return '';
        return slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    } catch {
        return '';
    }
}

function resolveCompanyName(companyName, jobUrl) {
    if (!isBlankCompany(companyName)) return String(companyName).trim();
    const fromUrl = companyFromJobUrl(jobUrl);
    return fromUrl || null;
}

function extractCompanyFromDescription(text) {
    const d = String(text || '').trim();
    if (!d) return null;
    const m = d.match(/^([A-Z][A-Za-z0-9&.,'\- ]{2,80}?)\s+is\s+(?:searching|looking|seeking|hiring)\b/);
    if (m && m[1]) {
        const name = m[1].trim().replace(/\s+/g, ' ');
        if (!isBlankCompany(name)) return name;
    }
    return null;
}

/** Resolve a display/storage company name from course + linked application rows. */
function resolveCompanyForCourse(course) {
    if (!course) return null;
    if (!isBlankCompany(course.company_name)) return String(course.company_name).trim();

    const app = getOne(
        `SELECT a.id, a.company_name, a.job_url, a.job_description, a.job_link_id,
                jl.company_name AS link_company, jl.job_apply_url, jl.job_description AS link_description
         FROM job_applications a
         LEFT JOIN job_links jl ON jl.id = a.job_link_id
         WHERE a.id = ? LIMIT 1`,
        [parseInt(course.application_id, 10)]
    );
    if (app && !isBlankCompany(app.company_name)) return String(app.company_name).trim();
    if (app && !isBlankCompany(app.link_company)) return String(app.link_company).trim();

    const url = course.job_url || app?.job_url || app?.job_apply_url || '';
    const link = url
        ? getOne(
              `SELECT company_name FROM job_links
               WHERE job_apply_url = ? OR job_apply_url LIKE ?
               ORDER BY id DESC LIMIT 1`,
              [url, `${String(url).split('?')[0]}%`]
          )
        : null;
    if (link && !isBlankCompany(link.company_name)) return String(link.company_name).trim();

    const fromUrl = companyFromJobUrl(url);
    if (!isBlankCompany(fromUrl)) return fromUrl;

    return extractCompanyFromDescription(app?.link_description || app?.job_description);
}

function outcomeFromEventType(eventType) {
    const t = String(eventType || '');
    if (/marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(t)) return 'applied';
    if (/rejected/i.test(t) && !/blocked_ats/i.test(t)) return 'rejected';
    // Fill-complete events keep DB outcome as unknown; filled_at drives FILLED in UI.
    return undefined;
}

/** Last status-relevant event (skips screenshot / enqueue / package spam). */
const LAST_STATUS_EVENT_SQL = `(SELECT e.event_type FROM bid_course_events e
              WHERE e.course_id = c.id
                AND e.event_type NOT IN (
                    'screenshot', 'screenshot_failed', 'live',
                    'queue_enqueued', 'qa_admin_access_check',
                    'package_saved', 'dial_country',
                    'cv_regenerate_needed', 'cv_regenerated'
                )
              ORDER BY e.at DESC, e.id DESC LIMIT 1)`;

const LAST_STATUS_META_SQL = `(SELECT e.meta_json FROM bid_course_events e
              WHERE e.course_id = c.id
                AND e.event_type NOT IN (
                    'screenshot', 'screenshot_failed', 'live',
                    'queue_enqueued', 'qa_admin_access_check',
                    'package_saved', 'dial_country',
                    'cv_regenerate_needed', 'cv_regenerated'
                )
              ORDER BY e.at DESC, e.id DESC LIMIT 1)`;

/**
 * Upsert course keyed by application_id. Returns the course row.
 */
function upsertCourse({
    applicationId,
    profileId,
    userId,
    jobUrl,
    companyName,
    jobRole,
    templateId,
    fontFamily,
    cvProvider,
    answersProvider,
    answersModel,
    salaryValue,
    salaryFormatted,
    fillStats,
    answers,
    startedAt,
    filledAt,
    appliedAt,
    outcome,
    eventType,
    eventMeta,
    skipEvent = false
} = {}) {
    const appId = parseInt(applicationId, 10);
    if (!Number.isInteger(appId) || appId <= 0) {
        throw new Error('application_id is required');
    }

    let course = getOne(`SELECT * FROM bid_courses WHERE application_id = ?`, [appId]);

    // Derive outcome from terminal events when not explicitly passed
    let resolvedOutcome = outcome;
    if (resolvedOutcome === undefined) {
        resolvedOutcome = outcomeFromEventType(eventType);
    }

    const effectiveCompany = resolveCompanyName(companyName, jobUrl)
        || (course
            ? resolveCompanyForCourse({
                ...course,
                company_name: companyName ?? course.company_name,
                job_url: jobUrl || course.job_url
            })
            : resolveCompanyForCourse({
                application_id: appId,
                company_name: companyName,
                job_url: jobUrl
            }));

    if (!course) {
        if (!profileId || !userId) {
            throw new Error('profile_id and user_id are required to create a bid course');
        }
        const result = runQuery(
            `INSERT INTO bid_courses (
                application_id, profile_id, user_id, job_url, company_name, job_role,
                started_at, filled_at, applied_at,
                template_id, font_family, cv_provider,
                answers_provider, answers_model,
                salary_value, salary_formatted, fill_stats_json,
                outcome, answers_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                appId,
                parseInt(profileId, 10),
                parseInt(userId, 10),
                jobUrl || null,
                effectiveCompany,
                jobRole || null,
                startedAt || (/^queue_started$/i.test(String(eventType || ''))
                    ? new Date().toISOString()
                    : null),
                filledAt || null,
                appliedAt || null,
                templateId != null ? parseInt(templateId, 10) : null,
                fontFamily || null,
                cvProvider || null,
                answersProvider || null,
                answersModel || null,
                salaryValue != null && Number.isFinite(Number(salaryValue)) ? Number(salaryValue) : null,
                salaryFormatted || null,
                jsonString(fillStats),
                OUTCOMES.has(resolvedOutcome) ? resolvedOutcome : 'unknown',
                jsonString(answers)
            ]
        );
        course = getOne(`SELECT * FROM bid_courses WHERE id = ?`, [result.lastInsertRowid]);
    } else {
        const sets = ['updated_at = CURRENT_TIMESTAMP'];
        const params = [];

        const setIf = (col, val, transform = (v) => v) => {
            if (val === undefined) return;
            sets.push(`${col} = ?`);
            params.push(val == null ? null : transform(val));
        };

        setIf('job_url', jobUrl !== undefined && jobUrl ? jobUrl : undefined);
        const nextCompany = effectiveCompany
            ? preferCompanyName(effectiveCompany, course.company_name)
            : (isBlankCompany(course.company_name) && jobUrl
                ? preferCompanyName(companyFromJobUrl(jobUrl), course.company_name)
                : undefined);
        setIf('company_name', nextCompany);
        setIf('job_role', jobRole !== undefined && jobRole && !/^unknown$/i.test(String(jobRole))
            ? jobRole
            : undefined);
        setIf('template_id', templateId !== undefined
            ? (templateId != null ? parseInt(templateId, 10) : null)
            : undefined);
        setIf('font_family', fontFamily !== undefined ? (fontFamily || null) : undefined);
        setIf('cv_provider', cvProvider !== undefined ? (cvProvider || null) : undefined);
        setIf('answers_provider', answersProvider !== undefined ? (answersProvider || null) : undefined);
        setIf('answers_model', answersModel !== undefined ? (answersModel || null) : undefined);
        setIf('salary_value', salaryValue !== undefined
            ? (salaryValue != null && Number.isFinite(Number(salaryValue)) ? Number(salaryValue) : null)
            : undefined);
        setIf('salary_formatted', salaryFormatted !== undefined ? (salaryFormatted || null) : undefined);
        setIf('fill_stats_json', fillStats !== undefined ? jsonString(fillStats) : undefined);
        setIf('answers_json', answers !== undefined ? jsonString(answers) : undefined);
        if (/^queue_started$/i.test(String(eventType || ''))) {
            sets.push('started_at = CURRENT_TIMESTAMP');
        } else {
            setIf('started_at', startedAt !== undefined ? (startedAt || null) : undefined);
        }
        setIf('filled_at', filledAt !== undefined ? (filledAt || null) : undefined);
        setIf('applied_at', appliedAt !== undefined ? (appliedAt || null) : undefined);

        if (resolvedOutcome !== undefined && OUTCOMES.has(resolvedOutcome)) {
            // Never downgrade interview → applied/unknown — except explicit false-SUCCESS revoke.
            const forceClearApplied = /success_revoked|false_success_cleared/i.test(String(eventType || ''))
                && resolvedOutcome === 'unknown';
            const rank = { unknown: 0, applied: 1, rejected: 1, interview: 2 };
            const cur = rank[course.outcome] || 0;
            const next = rank[resolvedOutcome] || 0;
            if (forceClearApplied && course.outcome === 'applied') {
                sets.push('outcome = ?');
                params.push('unknown');
                sets.push('applied_at = NULL');
            } else if (next >= cur || resolvedOutcome === 'rejected') {
                sets.push('outcome = ?');
                params.push(resolvedOutcome);
            }
        }

        // Mark filled when fill completes with meaningful coverage (even without submit).
        // Low fill counts (e.g. Lever mislabels writing an essay into ZIP) must NOT show FILLED.
        if (/awaiting_manual_submit|after_fill(?:_done)?|fill_done|ready_to_submit|submit_blocked_incomplete/i.test(String(eventType || ''))
            && !course.filled_at) {
            const metaObj = eventMeta && typeof eventMeta === 'object' ? eventMeta : {};
            const filledN = Number(metaObj.filled ?? metaObj.totalFilled ?? NaN);
            const force = !!metaObj.forceFilled || !!metaObj.requiredComplete || !!metaObj.submitClicked;
            const weakReady = /^ready_to_submit$/i.test(String(eventType || ''))
                && Number.isFinite(filledN)
                && filledN < 5
                && !force;
            if (!weakReady) {
                sets.push('filled_at = COALESCE(filled_at, CURRENT_TIMESTAMP)');
            }
        }

        params.push(course.id);
        runQuery(`UPDATE bid_courses SET ${sets.join(', ')} WHERE id = ?`, params);
        course = getOne(`SELECT * FROM bid_courses WHERE id = ?`, [course.id]);
    }

    // Screenshots never enter the timeline; other events always do.
    // Status SQL separately ignores enqueue noise so Failed sticks until queue_started.
    if (eventType && !skipEvent && !isTimelineNoiseEventType(eventType)) {
        addEvent(course.id, eventType, eventMeta);
    }

    return decorateCourse(course);
}

function decorateCourse(row) {
    if (!row) return null;
    const { last_event_meta_json, ...rest } = row;
    let company_name = rest.company_name;
    if (isBlankCompany(company_name)) {
        const resolved = resolveCompanyForCourse(rest);
        if (resolved) company_name = resolved;
    }
    const profileName = [rest.profile_first_name, rest.profile_last_name]
        .map((s) => String(s || '').trim())
        .filter(Boolean)
        .join(' ');
    return {
        ...rest,
        company_name,
        profile_name: profileName || null,
        fill_stats: parseJson(row.fill_stats_json, null),
        answers: parseJson(row.answers_json, []),
        last_event_meta: parseJson(last_event_meta_json, null)
    };
}

function getCourseByApplicationId(applicationId) {
    const row = getOne(
        `SELECT c.*,
            a.job_link_id AS job_link_id,
            ${LAST_STATUS_EVENT_SQL} AS last_event_type,
            ${LAST_STATUS_META_SQL} AS last_event_meta_json
         FROM bid_courses c
         LEFT JOIN job_applications a ON a.id = c.application_id
         WHERE c.application_id = ?`,
        [parseInt(applicationId, 10)]
    );
    return decorateCourse(row);
}

function listCoursesForUser(userId, { profileId, limit = 50, q, from, to } = {}) {
    const params = [parseInt(userId, 10)];
    const clauses = ['c.user_id = ?'];
    if (profileId) {
        clauses.push('c.profile_id = ?');
        params.push(parseInt(profileId, 10));
    }
    if (from) {
        clauses.push('COALESCE(c.filled_at, c.started_at, c.created_at) >= ?');
        params.push(String(from).trim());
    }
    if (to) {
        clauses.push('COALESCE(c.filled_at, c.started_at, c.created_at) <= ?');
        params.push(String(to).trim().length <= 10
            ? `${String(to).trim()} 23:59:59`
            : String(to).trim());
    }
    if (q && String(q).trim()) {
        const like = `%${String(q).trim().toLowerCase()}%`;
        clauses.push(`(
            LOWER(COALESCE(c.company_name,'')) LIKE ?
            OR LOWER(COALESCE(c.job_role,'')) LIKE ?
            OR LOWER(COALESCE(c.job_url,'')) LIKE ?
            OR CAST(c.id AS TEXT) LIKE ?
        )`);
        params.push(like, like, like, like);
    }
    params.push(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200));
    const rows = getAll(
        `SELECT c.*,
            a.job_link_id AS job_link_id,
            p.first_name AS profile_first_name,
            p.last_name AS profile_last_name,
            ${LAST_STATUS_EVENT_SQL} AS last_event_type,
            ${LAST_STATUS_META_SQL} AS last_event_meta_json
         FROM bid_courses c
         LEFT JOIN job_applications a ON a.id = c.application_id
         LEFT JOIN candidate_profiles p ON p.id = c.profile_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY COALESCE(c.filled_at, c.started_at, c.created_at) DESC
         LIMIT ?`,
        params
    );
    return rows.map(decorateCourse);
}

function listCoursesAll({ profileId, limit = 100, q, from, to } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
    const params = [];
    const clauses = [];
    if (profileId) {
        clauses.push('c.profile_id = ?');
        params.push(parseInt(profileId, 10));
    }
    if (from) {
        clauses.push('COALESCE(c.filled_at, c.started_at, c.created_at) >= ?');
        params.push(String(from).trim());
    }
    if (to) {
        clauses.push('COALESCE(c.filled_at, c.started_at, c.created_at) <= ?');
        params.push(String(to).trim().length <= 10
            ? `${String(to).trim()} 23:59:59`
            : String(to).trim());
    }
    if (q && String(q).trim()) {
        const like = `%${String(q).trim().toLowerCase()}%`;
        clauses.push(`(
            LOWER(COALESCE(c.company_name,'')) LIKE ?
            OR LOWER(COALESCE(c.job_role,'')) LIKE ?
            OR LOWER(COALESCE(c.job_url,'')) LIKE ?
            OR LOWER(COALESCE(u.username,'')) LIKE ?
            OR CAST(c.id AS TEXT) LIKE ?
        )`);
        params.push(like, like, like, like, like);
    }
    params.push(lim);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = getAll(
        `SELECT c.*,
            a.job_link_id AS job_link_id,
            p.first_name AS profile_first_name,
            p.last_name AS profile_last_name,
            ${LAST_STATUS_EVENT_SQL} AS last_event_type,
            ${LAST_STATUS_META_SQL} AS last_event_meta_json,
            u.username AS user_username
         FROM bid_courses c
         LEFT JOIN job_applications a ON a.id = c.application_id
         LEFT JOIN candidate_profiles p ON p.id = c.profile_id
         LEFT JOIN users u ON u.id = c.user_id
         ${where}
         ORDER BY COALESCE(c.filled_at, c.started_at, c.created_at) DESC
         LIMIT ?`,
        params
    );
    return rows.map(decorateCourse);
}

function recordGenerateDone({
    applicationId,
    profileId,
    userId,
    jobUrl,
    companyName,
    jobRole,
    templateId,
    fontFamily,
    cvProvider
}) {
    return upsertCourse({
        applicationId,
        profileId,
        userId,
        jobUrl,
        companyName,
        jobRole,
        templateId,
        fontFamily,
        cvProvider,
        eventType: 'generate_done',
        eventMeta: { template_id: templateId, cv_provider: cvProvider, font_family: fontFamily }
    });
}

function recordFillDone({
    applicationId,
    profileId,
    userId,
    jobUrl,
    companyName,
    jobRole,
    answers,
    answersProvider,
    answersModel,
    salaryValue,
    salaryFormatted,
    fillStats,
    templateId,
    fontFamily,
    cvProvider
}) {
    return upsertCourse({
        applicationId,
        profileId,
        userId,
        jobUrl,
        companyName,
        jobRole,
        answers,
        answersProvider,
        answersModel,
        salaryValue,
        salaryFormatted,
        fillStats,
        templateId,
        fontFamily,
        cvProvider,
        filledAt: new Date().toISOString(),
        eventType: 'fill_done',
        eventMeta: {
            answers_count: Array.isArray(answers) ? answers.length : 0,
            fill_stats: fillStats || null,
            answers_provider: answersProvider,
            answers_model: answersModel
        }
    });
}

function recordMarkApplied({ applicationId, userId }) {
    const existing = getCourseByApplicationId(applicationId);
    if (!existing) {
        // Soft no-op if course never started (manual apply without fill)
        return null;
    }
    // Verify ownership
    if (userId && Number(existing.user_id) !== Number(userId)) {
        const app = getOne(
            `SELECT a.id FROM job_applications a
             JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
             WHERE a.id = ? AND ua.user_id = ?`,
            [parseInt(applicationId, 10), parseInt(userId, 10)]
        );
        if (!app) return null;
    }
    return upsertCourse({
        applicationId,
        appliedAt: new Date().toISOString(),
        outcome: existing.outcome === 'interview' ? 'interview' : 'applied',
        eventType: 'mark_applied',
        eventMeta: {}
    });
}

/** Undo a false SUCCESS (regex / Update state mistake while form still open). */
function recordClearFalseSuccess({ applicationId, userId, reason, meta }) {
    const existing = getCourseByApplicationId(applicationId);
    if (!existing) return null;
    if (userId && Number(existing.user_id) !== Number(userId)) {
        const app = getOne(
            `SELECT a.id FROM job_applications a
             JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
             WHERE a.id = ? AND ua.user_id = ?`,
            [parseInt(applicationId, 10), parseInt(userId, 10)]
        );
        if (!app) return null;
    }
    if (existing.outcome === 'interview') return existing;
    return upsertCourse({
        applicationId,
        appliedAt: null,
        outcome: 'unknown',
        eventType: 'success_revoked',
        eventMeta: {
            reason: reason || 'form_still_open',
            ...(meta && typeof meta === 'object' ? meta : {})
        }
    });
}

function recordRejected({ applicationId, userId, reason }) {
    const existing = getCourseByApplicationId(applicationId);
    if (!existing) return null;
    if (userId && Number(existing.user_id) !== Number(userId)) return null;
    return upsertCourse({
        applicationId,
        outcome: 'rejected',
        eventType: 'rejected',
        eventMeta: { reason: reason || null }
    });
}

function recordInterviewMilestone({ applicationId, kind, milestoneId, label }) {
    const existing = getCourseByApplicationId(applicationId);
    if (!existing) {
        // Still try to create a minimal course from the application row
        const app = getOne(
            `SELECT a.*, ua.user_id AS assignee_user_id
             FROM job_applications a
             JOIN user_profile_assignments ua ON ua.profile_id = a.profile_id
             WHERE a.id = ?
             LIMIT 1`,
            [parseInt(applicationId, 10)]
        );
        if (!app) return null;
        upsertCourse({
            applicationId: app.id,
            profileId: app.profile_id,
            userId: app.applier_id || app.assignee_user_id,
            jobUrl: app.job_url,
            companyName: app.company_name,
            jobRole: app.job_role,
            templateId: app.template_id,
            fontFamily: app.font_family,
            outcome: 'interview',
            eventType: 'interview_milestone',
            eventMeta: { kind, milestone_id: milestoneId, label }
        });
        return getCourseByApplicationId(applicationId);
    }
    return upsertCourse({
        applicationId,
        outcome: 'interview',
        eventType: 'interview_milestone',
        eventMeta: { kind, milestone_id: milestoneId, label }
    });
}

function listEvents(courseId) {
    return getAll(
        `SELECT * FROM bid_course_events WHERE course_id = ? ORDER BY at ASC, id ASC`,
        [parseInt(courseId, 10)]
    ).map((e) => ({ ...e, meta: parseJson(e.meta_json, null) }));
}

function dedupeCourseScreenshots(courseId) {
    const stages = getAll(
        `SELECT stage, COUNT(1) n FROM bid_course_screenshots
         WHERE course_id = ? GROUP BY stage HAVING n > 1`,
        [parseInt(courseId, 10)]
    );
    let removed = 0;
    for (const { stage } of stages) {
        const keep = getOne(
            `SELECT id FROM bid_course_screenshots
             WHERE course_id = ? AND stage = ?
             ORDER BY id DESC LIMIT 1`,
            [parseInt(courseId, 10), stage]
        );
        if (!keep?.id) continue;
        const r = runQuery(
            `DELETE FROM bid_course_screenshots
             WHERE course_id = ? AND stage = ? AND id != ?`,
            [parseInt(courseId, 10), stage, keep.id]
        );
        removed += r.changes || 0;
    }
    return removed;
}

/** Drop DB screenshot rows whose files are gone (stops UI 404s). */
function pruneMissingScreenshotFiles(courseId, applicationId) {
    const fs = require('fs');
    const path = require('path');
    let artifacts;
    try {
        artifacts = require('./bidderArtifactService');
    } catch {
        return 0;
    }
    const rows = getAll(
        `SELECT id, file_path FROM bid_course_screenshots WHERE course_id = ?`,
        [parseInt(courseId, 10)]
    );
    let removed = 0;
    for (const row of rows) {
        const name = path.basename(String(row.file_path || ''));
        if (!name) continue;
        const disk = artifacts.readScreenshotFile(applicationId, name);
        const absOk = row.file_path && fs.existsSync(row.file_path);
        if (!disk && !absOk) {
            runQuery(`DELETE FROM bid_course_screenshots WHERE id = ?`, [row.id]);
            removed += 1;
        }
    }
    return removed;
}

/** List unique screenshot stages that still exist on disk. */
function listExistingScreenshots(courseId, applicationId) {
    const fs = require('fs');
    const path = require('path');
    let artifacts;
    try {
        artifacts = require('./bidderArtifactService');
    } catch {
        artifacts = null;
    }
    const shots = getAll(
        `SELECT id, stage, file_path, created_at FROM bid_course_screenshots WHERE course_id = ? ORDER BY created_at ASC`,
        [parseInt(courseId, 10)]
    );
    const byStage = new Map();
    for (const s of shots) {
        const name = path.basename(String(s.file_path || ''));
        const disk = artifacts ? artifacts.readScreenshotFile(applicationId, name) : null;
        const absOk = s.file_path && fs.existsSync(s.file_path);
        if (!disk && !absOk) continue;
        byStage.set(String(s.stage || 'shot'), {
            ...s,
            filename: name,
            file_path: disk || s.file_path,
            // File mtime so Live UI refreshes when live.png is overwritten in place
            updated_ms: (() => {
                try {
                    const fp = disk || s.file_path;
                    if (fp && fs.existsSync(fp)) return Math.round(fs.statSync(fp).mtimeMs || 0);
                } catch (_) { /* ignore */ }
                return 0;
            })()
        });
    }
    return [...byStage.values()];
}

function isStatusNoiseEventType(eventType) {
    return /^(screenshot|screenshot_failed|live|queue_enqueued|qa_admin_access_check)$/i.test(
        String(eventType || '')
    );
}

/** Close out abandoned autofill_engine checkpoints so UI shows Stale not Running. */
function syncStaleRun(course, events) {
    const real = [...events].reverse().filter((e) => !isStatusNoiseEventType(e.event_type));
    const last = real[0];
    if (!last || !/^autofill_engine$/i.test(last.event_type || '')) return null;

    const updatedMs = course.updated_at ? new Date(course.updated_at).getTime() : 0;
    const ageMs = updatedMs ? Date.now() - updatedMs : Infinity;
    if (ageMs <= 10 * 60 * 1000) return null;

    const lastIdx = events.findIndex((e) => e.id === last.id);
    if (lastIdx >= 0 && events.slice(lastIdx + 1).some((e) => /^stale_run$/i.test(e.event_type || ''))) {
        return null;
    }

    const priorFail = real.slice(1).find((e) =>
        /blocked_ats|fill_failed|open_failed|ai_failed|no_form/i.test(e.event_type || '')
    );
    addEvent(course.id, 'stale_run', {
        prior: priorFail?.event_type || null,
        reason: priorFail?.meta?.reason || priorFail?.meta?.error || null,
        autofill_engine_at: last.at
    });
    return 'stale_run';
}

/** Backfill company names, dedupe screenshots, sync filled_at / outcome from events. */
function repairAllCourses({ limit = 500 } = {}) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 500);
    const courses = getAll(
        `SELECT c.* FROM bid_courses c
         ORDER BY COALESCE(c.filled_at, c.started_at, c.created_at) DESC
         LIMIT ?`,
        [lim]
    );
    const summary = {
        total: courses.length,
        companyFixed: 0,
        appsFixed: 0,
        linksFixed: 0,
        shotsRemoved: 0,
        orphanShotsRemoved: 0,
        filledAtSynced: 0,
        outcomeSynced: 0,
        staleRunsFixed: 0,
        fixes: []
    };

    for (const c of courses) {
        const rowFix = { id: c.id, company: null, shots: 0, orphanShots: 0, filledAt: null, outcome: null, staleRun: null };
        const company = resolveCompanyForCourse(c);
        if (company && String(c.company_name || '').trim() !== company) {
            runQuery(`UPDATE bid_courses SET company_name = ? WHERE id = ?`, [company, c.id]);
            rowFix.company = company;
            summary.companyFixed += 1;

            const app = getOne(
                `SELECT id, company_name, job_link_id FROM job_applications WHERE id = ?`,
                [parseInt(c.application_id, 10)]
            );
            if (app && isBlankCompany(app.company_name)) {
                runQuery(`UPDATE job_applications SET company_name = ? WHERE id = ?`, [company, app.id]);
                summary.appsFixed += 1;
            }
            if (app?.job_link_id) {
                const link = getOne(`SELECT id, company_name FROM job_links WHERE id = ?`, [app.job_link_id]);
                if (link && isBlankCompany(link.company_name)) {
                    runQuery(`UPDATE job_links SET company_name = ? WHERE id = ?`, [company, link.id]);
                    summary.linksFixed += 1;
                }
            }
        }

        rowFix.shots = dedupeCourseScreenshots(c.id);
        summary.shotsRemoved += rowFix.shots;
        rowFix.orphanShots = pruneMissingScreenshotFiles(c.id, c.application_id);
        summary.orphanShotsRemoved += rowFix.orphanShots;

        const events = listEvents(c.id);
        const toMs = (v) => {
            const t = Date.parse(String(v || '').replace(' ', 'T') + 'Z');
            return Number.isFinite(t) ? t : 0;
        };
        const fillEv = [...events].reverse().find((e) => {
            const t = e.event_type || '';
            const m = e.meta || {};
            if (/ready_to_submit/i.test(t)) {
                const n = Number(m.filled ?? m.totalFilled ?? NaN);
                return m.forceFilled || m.requiredComplete || m.submitClicked
                    || !Number.isFinite(n) || n >= 5;
            }
            if (/awaiting_manual_submit|fill_done|after_fill_done|submit_blocked_incomplete/i.test(t)) {
                return true;
            }
            if (/mid_fill/i.test(t)) {
                return !!(m.complete || Number(m.filled) > 0);
            }
            return false;
        });
        const lastStatus = [...events].reverse().find((e) =>
            !/^(screenshot|screenshot_failed|live|queue_enqueued|qa_admin_access_check)$/i.test(e.event_type || '')
        );
        const laterFail = !!(
            lastStatus
            && /needs_captcha|captcha_abandoned|fill_failed|open_failed|blocked_ats|no_form/i.test(
                lastStatus.event_type || ''
            )
            && (!fillEv || toMs(lastStatus.at) >= toMs(fillEv.at))
        );

        if (fillEv && !c.filled_at && !laterFail) {
            runQuery(`UPDATE bid_courses SET filled_at = ? WHERE id = ? AND filled_at IS NULL`, [
                fillEv.at,
                c.id
            ]);
            rowFix.filledAt = fillEv.at;
            summary.filledAtSynced += 1;
        } else if ((c.filled_at || rowFix.filledAt) && laterFail) {
            // Later CAPTCHA / fail must not keep a stale filled_at (audit filled_but_fail_status).
            runQuery(`UPDATE bid_courses SET filled_at = NULL WHERE id = ?`, [c.id]);
            rowFix.filledAt = 'cleared';
            summary.filledAtSynced += 1;
        }

        if (c.outcome !== 'applied' && c.outcome !== 'interview') {
            const appliedEv = [...events].reverse().find((e) =>
                /marked_applied|submitted_ok/i.test(e.event_type || '')
            );
            if (appliedEv) {
                runQuery(
                    `UPDATE bid_courses SET outcome = 'applied', applied_at = COALESCE(applied_at, ?) WHERE id = ?`,
                    [appliedEv.at, c.id]
                );
                rowFix.outcome = 'applied';
                summary.outcomeSynced += 1;
            }
        }

        const staleRun = syncStaleRun(c, events);
        if (staleRun) {
            rowFix.staleRun = staleRun;
            summary.staleRunsFixed += 1;
        }

        if (rowFix.company || rowFix.shots || rowFix.orphanShots || rowFix.filledAt || rowFix.outcome || rowFix.staleRun) {
            summary.fixes.push(rowFix);
        }
    }

    return summary;
}

/**
 * Wipe Auto Bidder history (bid courses + events + screenshot rows + artifact folders).
 * @param {{ userId?: number, all?: boolean }} opts
 *   - all: delete every course (admin)
 *   - userId: delete only that user's courses
 */
function clearHistory(opts = {}) {
    const all = opts.all === true;
    const userId = Number.isInteger(Number(opts.userId)) ? Number(opts.userId) : null;
    if (!all && !userId) {
        throw new Error('userId or all=true is required');
    }

    const courses = all
        ? getAll(`SELECT id, application_id FROM bid_courses`)
        : getAll(`SELECT id, application_id FROM bid_courses WHERE user_id = ?`, [userId]);

    const courseIds = courses.map((c) => c.id).filter(Boolean);
    const appIds = [...new Set(courses.map((c) => c.application_id).filter(Boolean))];

    let eventsDeleted = 0;
    let shotsDeleted = 0;
    let coursesDeleted = 0;
    let artifactsRemoved = 0;

    if (courseIds.length) {
        const placeholders = courseIds.map(() => '?').join(',');
        eventsDeleted = runQuery(
            `DELETE FROM bid_course_events WHERE course_id IN (${placeholders})`,
            courseIds
        ).changes || 0;
        shotsDeleted = runQuery(
            `DELETE FROM bid_course_screenshots WHERE course_id IN (${placeholders})`,
            courseIds
        ).changes || 0;
        if (all) {
            runQuery(`DELETE FROM bid_courses`);
            coursesDeleted = courseIds.length;
        } else {
            coursesDeleted = runQuery(`DELETE FROM bid_courses WHERE user_id = ?`, [userId]).changes
                || courseIds.length;
        }
    }

    for (const appId of appIds) {
        const dir = path.join(BIDDER_DIR, String(appId));
        try {
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
                artifactsRemoved += 1;
            }
        } catch (err) {
            console.warn('[bidCourse] artifact remove failed', appId, err.message);
        }
    }

    return {
        courses: coursesDeleted,
        events: eventsDeleted,
        screenshots: shotsDeleted,
        artifacts: artifactsRemoved
    };
}

module.exports = {
    upsertCourse,
    getCourseByApplicationId,
    listCoursesForUser,
    listCoursesAll,
    listEvents,
    recordGenerateDone,
    recordFillDone,
    recordMarkApplied,
    recordClearFalseSuccess,
    recordRejected,
    recordInterviewMilestone,
    addEvent,
    companyFromJobUrl,
    isBlankCompany,
    resolveCompanyName,
    resolveCompanyForCourse,
    repairAllCourses,
    listExistingScreenshots,
    pruneMissingScreenshotFiles,
    dedupeCourseScreenshots,
    clearHistory
};
