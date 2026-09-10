// =============================================================================
// routes/jobLinks.js — job-links directory endpoints
// =============================================================================
//
// The job_links table is the source of truth for "what jobs is the
// team tracking right now?". Endpoints:
//
//   Any authenticated user (admin / manager / caller / user / developer):
//     GET    /job-links                paginated + filtered list
//     GET    /job-links/cron-status    observability
//     GET    /job-links/:id            single row
//     POST   /job-links                create a row
//     PATCH  /job-links/:id            partial update (incl. availability)
//     DELETE /job-links/:id            remove a row
//
//   Filters supported by GET /job-links:
//     search, techstack, platform, available, date_from, date_to, fetch_status,
//     has_generated_resume (=1 to restrict to rows that have at
//     least one job_applications row with generation_status='ready'
//     and a non-empty resume_filename).
//
//   Admin-only (scraping is gated because it fans out to LinkedIn with
//   our server's IP; we don't want a regular user to trigger dozens of
//   fetches in a row):
//     POST   /job-links/:id/scrape     on-demand LinkedIn scrape
//
// Mounting (see index.js):
//   - `router` (read + basic writes) is mounted at `/`
//   - `adminWriteRouter` (the scrape endpoint) is mounted at `/admin`
//     ahead of `adminRoutes` so its `requireAdmin` intercepts the
//     request before the admin router's `requireAdmin` middleware runs.
// =============================================================================

const express = require('express');
const { getAll, getOne, runQuery, saveDatabase, LOCATION_FLAGS } = require('../config/database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
    scrapeJobLinkById,
    getCronStatus
} = require('../services/jobLinkScraper');
const {
    normalizeUrl,
    canonicalJobLinkUrl,
    urlsReferToSameJob,
    resolveStoredJobUrls
} = require('../services/scraper/jobLinkUrl');
const jobMatchService = require('../services/jobMatchService');
const { platformFilterSql } = require('../services/scraper/jobLinkPlatform');

const router = express.Router();
const adminWriteRouter = express.Router();

/**
 * Decode HTML entities (named, decimal, hex) and collapse
 * non-breaking spaces (U+00A0, both literal and entity-encoded) so
 * they never reach the database as `&nbsp;`. iCIMS and other ATSes
 * emit `&nbsp;` between words for layout; users paste from HTML
 * editors. We normalize here AND on the scrape path so the
 * normalization is consistent across both manual and automated
 * writes. Mirrors the Python service's `_decode_entities`; the two
 * implementations stay in sync by listing the same named entities.
 */
function normalizeDescription(input) {
    if (input == null) return null;
    let s = String(input);
    return s
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&rsquo;/gi, '\u2019')
        .replace(/&lsquo;/gi, '\u2018')
        .replace(/&rdquo;/gi, '\u201d')
        .replace(/&ldquo;/gi, '\u201c')
        .replace(/&mdash;/gi, '\u2014')
        .replace(/&ndash;/gi, '\u2013')
        .replace(/&hellip;/gi, '\u2026')
        .replace(/&copy;/gi, '\u00a9')
        .replace(/&reg;/gi, '\u00ae')
        .replace(/&trade;/gi, '\u2122')
        .replace(/\u00a0/g, ' ');
}

router.use(requireAuth);
adminWriteRouter.use(requireAuth, requireAdmin);

// Allowed values for the techstack enum — must match the CHECK clause
// on the table. We validate at the route layer so a stray value from
// the UI doesn't blow up the INSERT.
const VALID_TECHSTACKS = ['python', 'java', 'dotnet', 'golang', 'nodejs', 'frontend'];

/** Attach `created_by_username` for list/detail rows (batch lookup). */
function decorateJobLinksWithCreators(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows || [];
    const creatorIds = [...new Set(rows.map((r) => r.created_by).filter((id) => id != null))];
    const byId = new Map();
    if (creatorIds.length) {
        const placeholders = creatorIds.map(() => '?').join(',');
        const users = getAll(
            `SELECT id, username FROM users WHERE id IN (${placeholders})`,
            creatorIds
        );
        for (const u of users) byId.set(u.id, u.username);
    }
    return rows.map((row) => ({
        ...row,
        created_by_username: row.created_by ? (byId.get(row.created_by) || null) : null
    }));
}

/**
 * Build WHERE conditions for job_links list / detail prev-next navigation.
 * Accepts the same query keys as GET /job-links (except page/limit).
 */
function buildJobLinkListFilters(query = {}) {
    const search = (query.search || '').trim();
    const techstack = (query.techstack || 'all').trim();
    const platform = (query.platform || query.ats || 'all').trim();
    const available = (query.available || 'all').trim();
    const dateFrom = (query.date_from || '').trim();
    const dateTo = (query.date_to || '').trim();
    const fetchStatus = (query.fetch_status || 'all').trim();
    const hasGeneratedResumeRaw = (query.has_generated_resume || '').trim().toLowerCase();
    const hasGeneratedResume = ['1', 'true', 'yes'].includes(hasGeneratedResumeRaw);

    const conds = [];
    const params = [];

    if (search) {
        conds.push(`(
            techstack LIKE ? OR
            company_name LIKE ? OR
            position_title LIKE ? OR
            source_url LIKE ? OR
            job_apply_url LIKE ? OR
            IFNULL(comment, '') LIKE ?
            OR EXISTS (
                SELECT 1 FROM job_applications ja
                JOIN candidate_profiles cp ON cp.id = ja.profile_id
                WHERE ja.job_link_id = job_links.id
                  AND (
                    cp.first_name LIKE ?
                    OR cp.last_name LIKE ?
                    OR (IFNULL(cp.first_name, '') || ' ' || IFNULL(cp.last_name, '')) LIKE ?
                  )
            )
        )`);
        const like = `%${search}%`;
        for (let i = 0; i < 9; i += 1) params.push(like);
    }

    if (techstack && techstack !== 'all' && VALID_TECHSTACKS.includes(techstack)) {
        conds.push('techstack = ?');
        params.push(techstack);
    }

    const platformSql = platformFilterSql(platform);
    if (platformSql) {
        conds.push(platformSql.sql);
        params.push(...platformSql.params);
    }

    if (available === '1') {
        conds.push('is_available = 1');
    } else if (available === '0') {
        conds.push('is_available = 0');
    }

    if (dateFrom) {
        conds.push('DATE(created_at) >= ?');
        params.push(dateFrom);
    }
    if (dateTo) {
        conds.push('DATE(created_at) <= ?');
        params.push(dateTo);
    }
    if (fetchStatus && fetchStatus !== 'all'
        && ['pending', 'fetching', 'success', 'failed'].includes(fetchStatus)) {
        conds.push('fetch_status = ?');
        params.push(fetchStatus);
    }
    if (hasGeneratedResume) {
        conds.push(`EXISTS (
            SELECT 1 FROM job_applications ja
             WHERE ja.job_link_id = job_links.id
               AND ja.generation_status = 'ready'
               AND ja.resume_filename IS NOT NULL
               AND ja.resume_filename <> ''
        )`);
    }

    const bidState = String(query.bid_state || query.bid || 'all').trim().toLowerCase();
    if (bidState === 'success') {
        conds.push(`EXISTS (
            SELECT 1 FROM job_applications ja
            LEFT JOIN bid_courses c ON c.application_id = ja.id
            WHERE ja.job_link_id = job_links.id
              AND (
                ja.status = 'applied'
                OR c.outcome = 'applied'
                OR c.applied_at IS NOT NULL
                OR EXISTS (
                    SELECT 1 FROM bid_course_events e
                    WHERE e.course_id = c.id
                      AND e.event_type IN ('marked_applied', 'submitted_ok', 'mark_applied', 'submit_success_detected')
                )
              )
        )`);
    } else if (bidState === 'filled') {
        conds.push(`EXISTS (
            SELECT 1 FROM job_applications ja
            LEFT JOIN bid_courses c ON c.application_id = ja.id
            WHERE ja.job_link_id = job_links.id
              AND c.filled_at IS NOT NULL
              AND IFNULL(ja.status, '') NOT IN ('applied', 'interview')
              AND IFNULL(c.outcome, '') != 'applied'
              AND c.applied_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM bid_course_events e
                WHERE e.course_id = c.id
                  AND e.event_type IN ('marked_applied', 'submitted_ok', 'mark_applied', 'submit_success_detected')
              )
        )`);
    } else if (bidState === 'failed') {
        conds.push(`EXISTS (
            SELECT 1 FROM job_applications ja
            LEFT JOIN bid_courses c ON c.application_id = ja.id
            WHERE ja.job_link_id = job_links.id
              AND (
                ja.status = 'rejected'
                OR ja.state IN ('rejected', 'cancelled')
                OR EXISTS (
                    SELECT 1 FROM bid_course_events e
                    WHERE e.course_id = c.id
                      AND e.event_type IN (
                        'fill_failed', 'open_failed', 'blocked_ats',
                        'cv_regenerate_failed', 'reautofill_failed', 'bid_budget_exceeded'
                      )
                )
              )
        )`);
    }

    return { conds, params };
}

function jobLinkListWhereClause(query = {}) {
    const { conds, params } = buildJobLinkListFilters(query);
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    return { where, params };
}

/**
 * True when two URLs refer to the same job posting for dedupe.
 * Prefer canonical identity; avoid broad path LIKE on shared ATS
 * shell paths (e.g. greenhouse /embed/job_app).
 */
// urlsReferToSameJob / canonicalJobLinkUrl / normalizeUrl imported
// from services/scraper/jobLinkUrl.js

function findExistingJobLinkByUrl(url) {
    const raw = normalizeUrl(url);
    if (!raw) return null;
    const canonical = canonicalJobLinkUrl(raw);

    // Exact match on source or apply URL
    let existing = getOne(
        `SELECT id, source_url, job_apply_url, company_name, position_title
           FROM job_links
          WHERE source_url = ? OR job_apply_url = ?
             OR (? <> '' AND (source_url = ? OR job_apply_url = ?))
          LIMIT 1`,
        [raw, raw, canonical, canonical, canonical]
    );
    if (existing) return existing;

    // Greenhouse / other identity: scan recent rows by canonical form
    // (table is small; avoids false positives from path LIKE).
    const rows = getAll(
        `SELECT id, source_url, job_apply_url, company_name, position_title
           FROM job_links
          ORDER BY id DESC
          LIMIT 500`
    );
    for (const row of rows) {
        if (
            urlsReferToSameJob(raw, row.source_url)
            || urlsReferToSameJob(raw, row.job_apply_url)
            || (canonical && (
                canonicalJobLinkUrl(row.source_url) === canonical
                || canonicalJobLinkUrl(row.job_apply_url) === canonical
            ))
        ) {
            return row;
        }
    }
    return null;
}

// -----------------------------------------------------------------------------
// GET /job-links — paginated list with filters (any user)
// -----------------------------------------------------------------------------
function listHandler(req, res) {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        // Default page size: 10. Clients can override with `?limit=N`
        // up to 100; below 1 we clamp to 1.
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = (page - 1) * limit;

        const { where, params } = jobLinkListWhereClause(req.query);

        const total = getOne(`SELECT COUNT(*) AS total FROM job_links ${where}`, params)?.total || 0;
        const rows = getAll(
            `SELECT * FROM job_links ${where}
             ORDER BY created_at DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        // Attach every available (region+stack matched) profile and their
        // application / generation / terminal state for the list UI.
        const withProfiles = jobMatchService.attachAvailableProfilesToJobLinks(rows);
        const data = decorateJobLinksWithCreators(withProfiles);

        res.json({
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('List job-links error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// GET /job-links/cron-status — observability (any user)
//
// Back-compat shim. The cron is gone; the new "status" of the
// job-detail pipeline is the RabbitMQ worker in
// services/jobDetailFetchService.js. We proxy that here so the
// old client polling code keeps working unchanged.
// -----------------------------------------------------------------------------
async function cronStatusHandler(req, res) {
    try {
        const jobDetailFetch = require('../services/jobDetailFetchService');
        const { scrapeJobLinkById } = require('../services/jobLinkScraper');
        const { getCronStatus } = require('../services/jobLinkScraper');
        await jobDetailFetch.refreshQueueDepth().catch(() => {});
        const q = jobDetailFetch.getStatus();
        const provider = getCronStatus();
        res.json({
            // Legacy fields (cron-managed) — left in place so the
            // existing UI doesn't render "undefined". They always
            // report the worker as idle + 0 queued when there is
            // no in-flight message.
            queueSize: q.queueDepth,
            workerRunning: q.processingCount > 0,
            lastRunAt: q.lastMessageAt,
            lastAttemptAt: q.lastMessageAt,
            lastError: q.lastError,
            // New (RabbitMQ-driven) fields the UI uses.
            provider: provider.provider,
            authReady: provider.authReady,
            fetchQueue: q
        });
    } catch (err) {
        console.error('Cron status error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// POST /job-links — create a row (any user)
// -----------------------------------------------------------------------------
async function createHandler(req, res) {
    try {
        // The column used to be called `linkedin_url`; we accept the
        // legacy field name too so old API clients keep working
        // during the migration window.
        const { techstack, job_apply_url, job_description, is_available } = req.body || {};
        const sourceRaw = req.body?.source_url ?? req.body?.linkedin_url;

        if (!techstack || !VALID_TECHSTACKS.includes(techstack)) {
            return res.status(400).json({ error: `techstack must be one of: ${VALID_TECHSTACKS.join(', ')}` });
        }

        const { source, apply: applyUrl } = resolveStoredJobUrls(sourceRaw, job_apply_url);
        if (!applyUrl) {
            return res.status(400).json({ error: 'job_apply_url is required' });
        }

        // Region is always US unless the admin explicitly picks another flag.
        const requestedFlag = (req.body?.location_flag || '').trim();
        const locationFlag = (requestedFlag && LOCATION_FLAGS.includes(requestedFlag))
            ? requestedFlag
            : 'US';

        // Pre-INSERT duplicate check — same posting (tracking params
        // ignored). Greenhouse embeds MUST compare board+token, not
        // shared /embed/job_app path.
        if (source || applyUrl) {
            const existing = findExistingJobLinkByUrl(source || applyUrl)
                || (source && applyUrl && source !== applyUrl
                    ? findExistingJobLinkByUrl(applyUrl)
                    : null);
            if (existing) {
                return res.status(409).json({
                    error: 'A job link with this URL already exists.',
                    existing_id: existing.id,
                    existing_source_url: existing.source_url,
                    existing_job_apply_url: existing.job_apply_url
                });
            }
        }

        const available = is_available === undefined || is_available === null
            ? 1
            : (is_available ? 1 : 0);

        const normalizedDesc = normalizeDescription(job_description);
        const hasPastedDescription = !!(normalizedDesc && String(normalizedDesc).trim());
        // If the caller already pasted a JD, mark the row fetched so
        // CV generation can start immediately. Otherwise stay pending
        // until the detail-fetch worker scrapes the source URL.
        const initialFetchStatus = hasPastedDescription ? 'success' : 'pending';

        const { lastInsertRowid } = runQuery(
            `INSERT INTO job_links (
                techstack, source_url, job_apply_url,
                job_description, location, is_available, fetch_status, created_by,
                location_flag, comment, last_fetched_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${hasPastedDescription ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
            [
                techstack,
                source || null,
                applyUrl,
                normalizedDesc,
                // Free-text location is optional. The cron normally
                // backfills this from the scraped page, but when
                // the admin types it up-front (so the auto-detect
                // can run before submit) we honour the value.
                (req.body?.location && typeof req.body.location === 'string')
                    ? req.body.location.trim() || null
                    : null,
                available,
                initialFetchStatus,
                req.user.id,
                locationFlag,
                (req.body?.comment != null && String(req.body.comment).trim() !== '')
                    ? String(req.body.comment).trim()
                    : null
            ]
        );

        const row = getOne('SELECT * FROM job_links WHERE id = ?', [lastInsertRowid]);

        // Enqueue detail fetch when we still need a JD. resolveStoredJobUrls
        // often nulls source_url when it matches apply — scrape still uses
        // job_apply_url via rowSourceUrl. Pasted JD rows are already success.
        if ((source || applyUrl) && !hasPastedDescription) {
            try {
                const jobDetailFetchService = require('../services/jobDetailFetchService');
                await jobDetailFetchService.enqueueJobDetailFetch(row.id, { source: 'create' });
            } catch (err) {
                // Soft-fail: if the broker is down we still want to
                // return the row to the user. The recovery pass at
                // boot + the periodic stale-fetching cleanup will
                // pick it up next time around.
                console.warn(
                    `[jobLinks] enqueue detail-fetch failed for job_link=${row.id}:`,
                    err.message
                );
            }
        }

        // Auto-generate CVs for matching profiles as soon as a JD is ready.
        // Scraped rows are kicked from jobLinkScraper after fetch success;
        // pasted-JD rows kick here so we don't wait for the cron tick.
        if (hasPastedDescription) {
            setImmediate(() => {
                jobMatchService
                    .reconcileJobLinkAfterMetadataChange(row.id)
                    .then((r) => {
                        if (r && r.enqueued > 0) {
                            console.log(
                                `[jobLinks] auto-enqueued ${r.enqueued} CV(s) for job_link=${row.id} (pasted JD)`
                            );
                        }
                    })
                    .catch((err) => {
                        console.warn(
                            `[jobLinks] auto CV kick failed for job_link=${row.id}:`,
                            err && err.message ? err.message : err
                        );
                    });
            });
        }

        res.status(201).json({ data: decorateJobLinksWithCreators([row])[0] });
    } catch (err) {
        console.error('Create job-link error:', err);
        // sql.js throws plain Error("SQLITE_CONSTRAINT: UNIQUE constraint
        // failed: ...") when the row hits a unique index. Translate
        // that into a friendly 409 so the UI can surface it.
        const msg = String(err && err.message || '');
        if (
            err && (
                err.code === 'SQLITE_CONSTRAINT' ||
                /UNIQUE constraint failed/i.test(msg) ||
                /constraint failed/i.test(msg)
            )
        ) {
            // Defense-in-depth: the pre-check above catches the
            // common case, but the DB may still throw if a race
            // (two concurrent inserts) slips past. Translate the
            // SQL error into a friendly 409 and best-effort look
            // up the colliding row's id so the UI can show "row
            // #N already has this URL".
            const m = /UNIQUE constraint failed:\s*job_links\.([a-z_]+)/i.exec(msg);
            const col = m ? m[1] : null;
            let hint;
            let existing = null;
            if (col === 'job_apply_url') {
                hint = 'A job link with this Job-apply URL already exists.';
                existing = applyUrl && getOne(
                    'SELECT id FROM job_links WHERE job_apply_url = ? LIMIT 1',
                    [applyUrl]
                );
            } else if (col === 'source_url') {
                hint = 'A job link with this Source URL already exists.';
                existing = source && getOne(
                    'SELECT id FROM job_links WHERE source_url = ? LIMIT 1',
                    [source]
                );
            } else {
                hint = 'A job link with these URLs already exists.';
            }
            return res.status(409).json({
                error: hint,
                existing_id: existing && existing.id
            });
        }
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// GET /job-links/:id — single row (any user)
// -----------------------------------------------------------------------------
function getHandler(req, res) {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const row = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ data: decorateJobLinksWithCreators([row])[0] });
}

// -----------------------------------------------------------------------------
// PATCH /job-links/:id — partial update (any user)
// -----------------------------------------------------------------------------
async function patchHandler(req, res) {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid id' });

        const existing = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
        if (!existing) return res.status(404).json({ error: 'Not found' });

        const fields = [];
        const params = [];
        let sourceChanged = false;
        let matchingChanged = false;

        const body = req.body || {};

        if ('techstack' in body) {
            if (!VALID_TECHSTACKS.includes(body.techstack)) {
                return res.status(400).json({ error: `techstack must be one of: ${VALID_TECHSTACKS.join(', ')}` });
            }
            if (body.techstack !== existing.techstack) matchingChanged = true;
            fields.push('techstack = ?');
            params.push(body.techstack);
        }

        // Accept both the new `source_url` and the legacy
        // `linkedin_url` keys so old clients keep working during the
        // migration window. Coalesce apply+source so Lever posting vs
        // apply?utm_source=jobright don't store as two links.
        if ('source_url' in body || 'linkedin_url' in body || 'job_apply_url' in body) {
            const applyIn = 'job_apply_url' in body
                ? body.job_apply_url
                : existing.job_apply_url;
            const sourceIn = ('source_url' in body || 'linkedin_url' in body)
                ? ('source_url' in body ? body.source_url : body.linkedin_url)
                : (existing.source_url ?? existing.linkedin_url);
            const resolved = resolveStoredJobUrls(sourceIn, applyIn);
            if (!resolved.apply) {
                return res.status(400).json({ error: 'job_apply_url is required' });
            }

            if (
                'job_apply_url' in body
                || resolved.apply !== existing.job_apply_url
            ) {
                fields.push('job_apply_url = ?');
                params.push(resolved.apply);
            }

            const prevSource = existing.source_url ?? existing.linkedin_url ?? null;
            if (
                'source_url' in body
                || 'linkedin_url' in body
                || resolved.source !== prevSource
            ) {
                fields.push('source_url = ?');
                params.push(resolved.source);
                sourceChanged = (resolved.source !== prevSource);
            }
        }

        if ('job_description' in body) {
            fields.push('job_description = ?');
            params.push(normalizeDescription(body.job_description));
        }

        // Editable metadata: company / position / location. We allow
        // the admin to manually override the cron-parsed values
        // (e.g. to correct a bad parse or add context the cron
        // missed). Empty strings become NULL.
        for (const col of ['company_name', 'position_title', 'location', 'comment']) {
            if (col in body) {
                const v = body[col];
                const normalized = (v == null || String(v).trim() === '') ? null : String(v).trim();
                fields.push(`${col} = ?`);
                params.push(normalized);
            }
        }

        // Editable region flag. Default / empty → US. Do not auto-detect
        // from free-text location (product default is US for all jobs).
        if ('location_flag' in body) {
            const raw = body.location_flag;
            if (raw == null || String(raw).trim() === '') {
                if ((existing.location_flag || 'US') !== 'US') matchingChanged = true;
                fields.push("location_flag = 'US'");
            } else if (LOCATION_FLAGS.includes(raw)) {
                if (raw !== (existing.location_flag || 'US')) matchingChanged = true;
                fields.push('location_flag = ?');
                params.push(raw);
            } else {
                return res.status(400).json({
                    error: `location_flag must be one of: ${LOCATION_FLAGS.join(', ')}`
                });
            }
        }

        if ('is_available' in body) {
            const available = body.is_available ? 1 : 0;
            fields.push('is_available = ?');
            params.push(available);
            // Re-enabling a row clears an auto-expired flag so the
            // Expired badge does not stick after a human override.
            if (available === 1 && !('closed_reason' in body)) {
                fields.push('closed_reason = NULL');
            }
        }

        if ('closed_reason' in body) {
            const raw = body.closed_reason;
            const normalized = (raw == null || String(raw).trim() === '')
                ? null
                : String(raw).trim().slice(0, 40);
            fields.push('closed_reason = ?');
            params.push(normalized);
        }

        if (sourceChanged) {
            fields.push("fetch_status = 'pending'", 'fetch_error = NULL');
        }

        if (fields.length === 0) {
            return res.json({ data: existing });
        }

        // Pre-UPDATE collision check. The DB's UNIQUE constraint
        // is now only on `job_apply_url` (we relaxed `source_url`
        // to allow NULL), so a duplicate source_url would silently
        // overwrite another row. Check up-front and return the
        // colliding row's id so the UI can highlight it.
        //
        // We only check when the relevant field is in the body —
        // partial updates that don't touch the URL must not collide
        // with the existing row's own value.
        if ('source_url' in body || 'linkedin_url' in body || 'job_apply_url' in body) {
            const applyIn = 'job_apply_url' in body
                ? body.job_apply_url
                : existing.job_apply_url;
            const sourceIn = ('source_url' in body || 'linkedin_url' in body)
                ? ('source_url' in body ? body.source_url : body.linkedin_url)
                : (existing.source_url ?? existing.linkedin_url);
            const resolved = resolveStoredJobUrls(sourceIn, applyIn);
            if (resolved.apply) {
                const collision = findExistingJobLinkByUrl(resolved.apply)
                    || (resolved.source ? findExistingJobLinkByUrl(resolved.source) : null);
                if (collision && collision.id !== id) {
                    return res.status(409).json({
                        error: 'Another job link already uses this URL.',
                        existing_id: collision.id,
                        existing_source_url: collision.source_url,
                        existing_job_apply_url: collision.job_apply_url
                    });
                }
            }
        }

        fields.push('updated_at = CURRENT_TIMESTAMP');
        params.push(id);

        try {
            runQuery(`UPDATE job_links SET ${fields.join(', ')} WHERE id = ?`, params);
        } catch (err) {
            // UNIQUE constraint hit on source_url or job_apply_url.
            // Defense-in-depth: the pre-check above catches the
            // common case, but the DB still owns the truth, so we
            // keep the catch-and-translate path. We also try to
            // look up the colliding row's id so the UI can show
            // "row #N already has this URL".
            const msg = String(err && err.message || '');
            if (
                err && (
                    err.code === 'SQLITE_CONSTRAINT' ||
                    /UNIQUE constraint failed/i.test(msg) ||
                    /constraint failed/i.test(msg)
                )
            ) {
                const m = /UNIQUE constraint failed:\s*job_links\.([a-z_]+)/i.exec(msg);
                const col = m ? m[1] : null;
                let hint;
                let existing = null;
                if (col === 'job_apply_url') {
                    hint = 'Another job link already uses this Job-apply URL.';
                } else if (col === 'source_url') {
                    hint = 'Another job link already uses this Source URL.';
                } else {
                    hint = 'These URLs conflict with another job link.';
                }
                // Best-effort lookup of the colliding row.
                const target = col === 'job_apply_url'
                    ? body.job_apply_url
                    : (body.source_url || body.linkedin_url);
                if (target) {
                    const where = col === 'job_apply_url'
                        ? 'id <> ? AND job_apply_url = ?'
                        : 'id <> ? AND source_url = ?';
                    existing = getOne(
                        `SELECT id FROM job_links WHERE ${where} LIMIT 1`,
                        [id, String(target)]
                    );
                }
                return res.status(409).json({
                    error: hint,
                    existing_id: existing && existing.id
                });
            }
            throw err;
        }

        const row = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
        const [enriched] = decorateJobLinksWithCreators(
            jobMatchService.attachAvailableProfilesToJobLinks([row])
        );

        if (matchingChanged) {
            try {
                const reconcile = await jobMatchService.reconcileJobLinkAfterMetadataChange(id);
                if (reconcile.enqueued > 0) {
                    const refreshed = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
                    const [withProfiles] = decorateJobLinksWithCreators(
                        jobMatchService.attachAvailableProfilesToJobLinks([refreshed])
                    );
                    return res.json({
                        data: withProfiles,
                        reconcile: { enqueued: reconcile.enqueued }
                    });
                }
            } catch (reconcileErr) {
                console.warn(`[jobLinks] reconcile after metadata change failed for #${id}:`, reconcileErr.message);
            }
        }

        res.json({ data: enriched });

        // URL change → re-queue scrape (status already reset to pending above).
        if (sourceChanged) {
            try {
                const jobDetailFetchService = require('../services/jobDetailFetchService');
                await jobDetailFetchService.enqueueJobDetailFetch(id, { source: 'url-change' });
            } catch (err) {
                console.warn(`[job-links] enqueue after URL change failed for ${id}:`, err.message);
            }
        }
    } catch (err) {
        console.error('Update job-link error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// DELETE /job-links/:id — remove a row (any user)
// -----------------------------------------------------------------------------
function deleteHandler(req, res) {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        runQuery('DELETE FROM job_links WHERE id = ?', [id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('Delete job-link error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// POST /job-links/:id/scrape — on-demand scrape (admin-only)
// -----------------------------------------------------------------------------
async function scrapeHandler(req, res) {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const result = await scrapeJobLinkById(id);
        const row = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
        res.json({ result, data: row });
    } catch (err) {
        console.error('Scrape job-link error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// GET /job-links/:id/applications
//
// Drives the new JobLink detail page. Returns:
//   - the job_link row itself (for the left column)
//   - every job_application tied to this job_link, newest first,
//     each carrying the joined candidate profile + techstacks so
//     the page renders without a second round-trip
//   - the auto-apply cron status so the page can show a "cron
//     running" badge in the header
//
// Any authenticated user can read; the route is intentionally
// open because the Job Links directory is already shared across
// the team.
// -----------------------------------------------------------------------------
function applicationsListHandler(req, res) {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid id' });

        const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
        if (!jobLink) return res.status(404).json({ error: 'Job link not found' });

        const applications = jobMatchService.listApplicationsForJobLink(id);
        // Every profile that the auto-apply scorer would consider
        // a match for this job_link, including profiles that don't
        // yet have a job_applications row. The detail page shows
        // both lists so admins can see the full candidate pool
        // before the cron has caught up.
        const matchedProfiles = jobMatchService.listMatchedProfilesForJobLink(id);

        // Prev / next siblings within the same filtered set the Job
        // Links list uses. Query params mirror GET /job-links filters
        // (techstack, search, etc.) so Next/Prev on the detail page
        // stay inside the user's current view.
        const { conds: filterConds, params: filterParams } = buildJobLinkListFilters(req.query);
        const prevConds = [...filterConds, '(created_at, id) > (?, ?)'];
        const nextConds = [...filterConds, '(created_at, id) < (?, ?)'];
        const prev = getOne(
            `SELECT id FROM job_links
              WHERE ${prevConds.join(' AND ')}
              ORDER BY created_at ASC, id ASC
              LIMIT 1`,
            [...filterParams, jobLink.created_at, jobLink.id]
        );
        const next = getOne(
            `SELECT id FROM job_links
              WHERE ${nextConds.join(' AND ')}
              ORDER BY created_at DESC, id DESC
              LIMIT 1`,
            [...filterParams, jobLink.created_at, jobLink.id]
        );

        res.json({
            data: {
                job_link: decorateJobLinksWithCreators([jobLink])[0],
                applications,
                matched_profiles: matchedProfiles,
                cron: jobMatchService.getStatus(),
                prev_id: prev?.id ?? null,
                next_id: next?.id ?? null
            }
        });
    } catch (err) {
        console.error('List job-link applications error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// POST /job-links/:id/applications/:appId/regenerate
//
// Re-runs the resume pipeline against the existing application row.
// The job_description is re-read from the linked job_links row (so
// the regenerated resume always tracks the freshest scrape) and
// the profile's preferred template + font are re-resolved from
// current admin settings. Used by the detail-page "Regenerate"
// button.
// -----------------------------------------------------------------------------
async function applicationRegenerateHandler(req, res) {
    try {
        const jobLinkId = parseInt(req.params.id);
        const appId = parseInt(req.params.appId);
        if (!jobLinkId || !appId) return res.status(400).json({ error: 'Invalid id' });

        const application = getOne(
            'SELECT * FROM job_applications WHERE id = ? AND job_link_id = ?',
            [appId, jobLinkId]
        );
        if (!application) return res.status(404).json({ error: 'Application not found' });

        const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
        if (!jobLink) return res.status(404).json({ error: 'Job link not found' });

        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [application.profile_id]);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        // Stay `pending` until the serial worker actually starts so a
        // second Regenerate does not show a live Generating clock.
        // Re-stamp template/font from the live profile (assigned after
        // the first attempt still applies on this run).
        jobMatchService.markApplicationQueuedForGeneration(appId, profile);

        const resumeQueue = require('../services/resumeQueueService');
        await resumeQueue.enqueueGeneration(profile.id, jobLinkId, {
            correlationId: `regen-app-${appId}`,
            force: true
        });
        res.json({
            ok: true,
            resume_filename: application.resume_filename,
            generation_status: 'pending',
            queued: true
        });
    } catch (err) {
        console.error('Regenerate application error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// POST /job-links/:id/applications/:appId/apply
//
// Flips the application's status to 'applied' so the caller /
// manager can track that they actually submitted it. Pure
// metadata — no third-party submission happens here. Used by the
// detail-page "Mark as applied" button.
// -----------------------------------------------------------------------------
function applicationMarkAppliedHandler(req, res) {
    try {
        const jobLinkId = parseInt(req.params.id);
        const appId = parseInt(req.params.appId);
        if (!jobLinkId || !appId) return res.status(400).json({ error: 'Invalid id' });

        const application = getOne(
            'SELECT * FROM job_applications WHERE id = ? AND job_link_id = ?',
            [appId, jobLinkId]
        );
        if (!application) return res.status(404).json({ error: 'Application not found' });

        runQuery(
            `UPDATE job_applications
             SET status = 'applied', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [appId]
        );
        saveDatabase();
        res.json({ ok: true, status: 'applied' });
    } catch (err) {
        console.error('Mark applied error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// -----------------------------------------------------------------------------
// POST /job-links/:id/apply
//
// Bulk action triggered from the JobLinks list. Marks EVERY
// non-applied job_application tied to this job_link as 'applied',
// and flips the job_link's is_available flag to 0 so it stops
// showing as actionable for new generations. Pure metadata —
// we don't actually submit anything to the ATS.
//
// Available to ANY authenticated user (mounted on the open
// router, not the adminWriteRouter) so the user-side caller /
// manager can press Apply from the JobLinks page the same way
// the admin can. The detail-page per-card "Mark applied" button
// still uses the per-application endpoint above; this is the
// "apply to the whole job" sweep.
// -----------------------------------------------------------------------------
function jobLinkMarkAppliedHandler(req, res) {
    try {
        const jobLinkId = parseInt(req.params.id);
        if (!jobLinkId) return res.status(400).json({ error: 'Invalid id' });

        const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
        if (!jobLink) return res.status(404).json({ error: 'Job link not found' });

        // Flip every still-pending application for this job_link
        // to 'applied'. Already-applied rows stay 'applied' so
        // we don't churn updated_at on a no-op. We also leave
        // rows in 'rejected' alone — rejected means a candidate
        // was explicitly turned down, not that someone hit Apply.
        const result = runQuery(
            `UPDATE job_applications
             SET status = 'applied', updated_at = CURRENT_TIMESTAMP
             WHERE job_link_id = ?
               AND status IN ('pending', 'applied', 'interview')`,
            [jobLinkId]
        );

        // Mark the job_link itself as no-longer-available so the
        // next cron tick doesn't generate fresh resumes for it.
        runQuery(
            `UPDATE job_links
             SET is_available = 0, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [jobLinkId]
        );
        saveDatabase();

        res.json({
            ok: true,
            job_link_id: jobLinkId,
            applications_updated: result.changes,
            is_available: 0
        });
    } catch (err) {
        console.error('Job-link mark applied error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// POST /job-links/:id/expired
// Bidder (or scrape) saw a closed / no-longer-open posting. Flip
// the link unavailable and stamp closed_reason so Job Links shows
// an Expired badge and the ready queue skips it.
function jobLinkMarkExpiredHandler(req, res) {
    try {
        const jobLinkId = parseInt(req.params.id, 10);
        if (!jobLinkId) return res.status(400).json({ error: 'Invalid id' });

        const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
        if (!jobLink) return res.status(404).json({ error: 'Job link not found' });

        runQuery(
            `UPDATE job_links
             SET is_available = 0,
                 closed_reason = 'expired',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [jobLinkId]
        );
        saveDatabase();

        res.json({
            ok: true,
            job_link_id: jobLinkId,
            is_available: 0,
            closed_reason: 'expired'
        });
    } catch (err) {
        console.error('Job-link mark expired error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// Open routes (any authenticated user). Mounted at top-level `/` in
// index.js, so the full paths are `/job-links/...`.
router.get('/job-links',                  listHandler);
router.get('/job-links/cron-status',      cronStatusHandler);
router.get('/job-links/:id',              getHandler);
router.post('/job-links',                 createHandler);
router.patch('/job-links/:id',            patchHandler);
router.delete('/job-links/:id',           deleteHandler);
// New detail-page endpoints. The `:id/applications/:appId/...`
// paths live under the same open router because the Job Links
// directory is already shared; the inner `:appId` makes it
// impossible to accidentally target a row from another job.
router.get('/job-links/:id/applications',                       applicationsListHandler);
router.post('/job-links/:id/applications/:appId/regenerate',    applicationRegenerateHandler);
router.post('/job-links/:id/applications/:appId/apply',         applicationMarkAppliedHandler);
// Bulk "Apply to this whole job" — flips every still-pending
// application under the job_link to 'applied' AND closes the
// job_link itself (is_available=0) so the cron stops generating
// fresh resumes for it. Open to any authenticated user so both
// admin and user / caller / manager can trigger it.
router.post('/job-links/:id/apply',                              jobLinkMarkAppliedHandler);
router.post('/job-links/:id/expired',                            jobLinkMarkExpiredHandler);

// Admin-only scrape endpoint. Mounted at `/admin` in index.js, so the
// full path is `/admin/job-links/:id/scrape`. We keep scraping gated
// because it makes outbound requests to LinkedIn from the server's IP
// — we want admins to be the only ones able to trigger this.
adminWriteRouter.post('/job-links/:id/scrape', scrapeHandler);

// -----------------------------------------------------------------------------
// POST /admin/job-links/:id/refetch — force a re-fetch of a row that
// already has fetch_status='success' but stale/empty data. The
// regular scrape endpoint refuses to re-claim a 'success' row
// (claimRowForFetch only transitions pending/failed → fetching),
// so we expose this admin-only escape hatch.
// -----------------------------------------------------------------------------
async function refetchHandler(req, res) {
    try {
        const id = parseInt(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        // Reset status so the worker's claimRowForFetch passes.
        runQuery(
            `UPDATE job_links
                SET fetch_status = 'pending',
                    fetch_error = NULL,
                    consecutive_failures = 0,
                    next_retry_at = NULL,
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [id]
        );
        const jobDetailFetchService = require('../services/jobDetailFetchService');
        const enqueueResult = await jobDetailFetchService.enqueueJobDetailFetch(id, { source: 'admin-refetch' });
        res.json({ ok: true, id, enqueued: true, mode: enqueueResult.mode, result: enqueueResult.result });
    } catch (err) {
        console.error('Refetch job-link error:', err);
        const errMsg = err && err.message ? err.message : String(err);
        res.status(500).json({ error: errMsg });
    }
}
adminWriteRouter.post('/job-links/:id/refetch', refetchHandler);

// Any authenticated user can force-refetch (same directory write model as create/update).
router.post('/job-links/:id/refetch', refetchHandler);

// -----------------------------------------------------------------------------
// POST /job-links/:id/reconcile-cvs
// POST /job-links/reconcile-cvs  { ids: number[] }
//
// Enqueue CV generation for matching profiles that do not yet have a
// job_applications row. Used when a new profile is added after the
// job was first processed — the cron used to skip those jobs.
// -----------------------------------------------------------------------------
async function reconcileCvsHandler(req, res) {
    try {
        const id = parseInt(req.params.id, 10);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [id]);
        if (!jobLink) return res.status(404).json({ error: 'Job link not found' });
        if (!jobLink.job_description || !String(jobLink.job_description).trim()) {
            return res.json({ ok: true, id, enqueued: 0, skipped: 'no_jd' });
        }
        const result = await jobMatchService.reconcileJobLinkAfterMetadataChange(id);
        res.json({ ok: true, id, enqueued: result.enqueued || 0 });
    } catch (err) {
        console.error('Reconcile CVs error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}

async function reconcileCvsBulkHandler(req, res) {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        if (!ids.length) return res.status(400).json({ error: 'ids required' });
        const result = await jobMatchService.reconcileJobLinks(ids);
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('Bulk reconcile CVs error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}

router.post('/job-links/reconcile-cvs', reconcileCvsBulkHandler);
router.post('/job-links/:id/reconcile-cvs', reconcileCvsHandler);

// -----------------------------------------------------------------------------
// POST /admin/job-links/:id/generate/:profileId
//
// Manually creates a job_applications row for a (profile, job_link)
// pair that hasn't been picked up by the cron yet, then enqueues
// the resume-generation message. Used by the "Matched profiles"
// panel on the detail page so admins can fire a single candidate
// without waiting for the next tick.
//
// Idempotent: if an application already exists for this pair,
// returns the existing application id instead of duping.
// -----------------------------------------------------------------------------
async function generateForProfileHandler(req, res) {
    try {
        const jobLinkId = parseInt(req.params.id);
        const profileId = parseInt(req.params.profileId);
        if (!jobLinkId || !profileId) return res.status(400).json({ error: 'Invalid id' });

        const jobLink = getOne('SELECT * FROM job_links WHERE id = ?', [jobLinkId]);
        if (!jobLink) return res.status(404).json({ error: 'Job link not found' });

        if (!jobLink.job_description || !String(jobLink.job_description).trim()) {
            const fetchHint = jobLink.fetch_status === 'failed' || jobLink.fetch_status === 'dead'
                ? ` JD scrape ${jobLink.fetch_status}${jobLink.fetch_error ? `: ${jobLink.fetch_error}` : ''}.`
                : jobLink.fetch_status === 'pending' || jobLink.fetch_status === 'fetching'
                    ? ' Job description is still being fetched — wait a moment, then try again.'
                    : ' Paste a job description or use a URL that scrapes successfully.';
            return res.status(400).json({
                error: `Cannot generate a CV without a job description.${fetchHint}`
            });
        }

        const profile = getOne('SELECT * FROM candidate_profiles WHERE id = ?', [profileId]);
        if (!profile) return res.status(404).json({ error: 'Profile not found' });

        // Idempotency: if an application already exists, re-kick generation.
        const existing = getOne(
            'SELECT * FROM job_applications WHERE job_link_id = ? AND profile_id = ?',
            [jobLinkId, profileId]
        );
        if (existing) {
            jobMatchService.markApplicationQueuedForGeneration(existing.id, profile);
            const resumeQueue = require('../services/resumeQueueService');
            await resumeQueue.enqueueGeneration(profileId, jobLinkId, {
                correlationId: `manual-existing-app-${existing.id}`,
                force: true
            });
            return res.json({
                ok: true,
                application_id: existing.id,
                enqueued: true,
                reused: true
            });
        }

        // Score the pair so the new row carries the same match
        // score the cron would have assigned.
        const score = jobMatchService.scoreProfile(profile, jobLink);
        const applicationId = jobMatchService.enqueueForPair(jobLink, profile, score);
        if (!applicationId) {
            return res.status(500).json({
                error: 'Failed to create application row (daily cap reached or insert failed)'
            });
        }

        const resumeQueue = require('../services/resumeQueueService');
        await resumeQueue.enqueueGeneration(profileId, jobLinkId, {
            correlationId: `manual-app-${applicationId}`
        });

        res.json({
            ok: true,
            application_id: applicationId,
            enqueued: true,
            reused: false
        });
    } catch (err) {
        console.error('Generate for profile error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
}
adminWriteRouter.post('/job-links/:id/generate/:profileId', generateForProfileHandler);

module.exports = { router, adminWriteRouter };
