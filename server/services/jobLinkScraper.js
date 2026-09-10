// =============================================================================
// services/jobLinkScraper.js — fetch job details via the python/node
// scraper providers. No cron here — fetching is driven by the
// RabbitMQ worker in services/jobDetailFetchService.js. This file
// keeps the per-row fetch + recovery logic and the provider
// selection so the worker can call into it.
// =============================================================================
//
// Two-tier architecture:
//
//   1. services/jobDetailFetchService.js: RabbitMQ producer + single
//      consumer. The producer is called by the route layer every
//      time a new job_link row is added; the consumer pulls one
//      message at a time (prefetch=1) and invokes
//      `scrapeJobLinkById(id)` here. No polling — the worker is
//      fully event-driven.
//
//   2. services/scraper/providers.js: pluggable backend
//        - `pythonService` — talks to an external Python Playwright
//          microservice over HTTP. Preferred when reachable.
//        - `nodeBuiltin`    — same logic as the previous implementation,
//          runs in-process via puppeteer-core + cheerio. Used when
//          no Python service is reachable.
//
// The two backends return the same shape:
//
//   { title, company, location, description }   success
//   { error: '...' }                           failure
//
// =============================================================================

const { getOne, getAll, runQuery, txRunQuery, getDb, saveDatabase } = require('../config/database');

// Helper to safely format any error (including AggregateError) to a string
function formatFetchError(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) {
        // Handle AggregateError specifically - it has multiple sub-errors
        if (err.constructor && err.constructor.name === 'AggregateError') {
            const subErrors = (err.errors || []).map(e => {
                if (e instanceof Error) return e.message;
                if (typeof e === 'string') return e;
                try { return JSON.stringify(e); } catch { return String(e); }
            }).filter(Boolean);
            if (subErrors.length > 0) {
                return 'AggregateError: ' + subErrors.join(' | ');
            }
            return 'AggregateError (no detail)';
        }
        // For regular Errors, return the message
        if (err.message) return err.message;
        // Some errors have a 'reason' field
        if (err.reason) {
            if (typeof err.reason === 'string') return err.reason;
            if (err.reason.message) return err.reason.message;
        }
    }
    // Fallback to String() conversion
    try {
        const s = String(err);
        if (s && s !== '[object Object]') return s;
    } catch {}
    try {
        return JSON.stringify(err);
    } catch {
        return 'unknown error';
    }
}


const { selectProvider, pythonService } = require('./scraper/providers');

/**
 * Normalize a job description for storage:
 *   1. Decode HTML entities so the DB has real characters
 *   2. Collapse non-breaking spaces into regular spaces
 *   3. Strip residual HTML tags (Greenhouse boards API returns
 *      entity-encoded markup; a naive strip can leave `<div>` etc.)
 */
function normalizeDescription(input) {
    if (input == null) return input;
    let s = String(input);
    // Decode all HTML entities (named + decimal + hex) using the
    // robust stdlib parser — this matches what Python's
    // `html.unescape` does.
    s = s
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        // Most common named entities — full list in HTML spec is
        // larger but these cover ~99% of real-world usage. We
        // handle the most common ones explicitly to avoid pulling
        // in a heavy dep; add more here as new ones surface.
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
        .replace(/&trade;/gi, '\u2122');
    // Collapse literal U+00A0 (non-breaking space) codepoints in
    // case the upstream already decoded the entity but kept the
    // character.
    s = s.replace(/\u00a0/g, ' ');
    // Strip leftover HTML tags (Greenhouse entity-decode miss, etc.).
    if (/<[a-zA-Z!/?]/.test(s)) {
        try {
            const cheerio = require('cheerio');
            s = cheerio.load(s).text().replace(/\s+/g, ' ').trim();
        } catch (_) {
            s = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
    }
    return s;
}

/**
 * Detect "clearance required" phrasing in a job description and
 * return a normalised label like "US Citizen (no clearance mentioned)",
 * "Public Trust", "Secret", "Top Secret", or "TS/SCI" — or null if
 * none found.
 *
 * Many federal / defense / IC job posts require some form of
 * security background check. We don't auto-apply for these (most
 * candidates on this platform don't hold an active clearance), so
 * the success-commit below sets `is_available = 0` whenever we
 * detect any clearance language beyond the bare "must be authorized
 * to work in the US" boilerplate.
 *
 * The detector is intentionally narrow — we'd rather miss a
 * borderline role than blacklist a legit one. Phrases that imply a
 * real adjudication (polygraph, reinvestigation, etc.) are kept.
 */
function detectClearanceRequirement(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text;

    // Top Secret / SCI / SAP — highest tier. Always block.
    if (/\bTS\s*\/\s*SCI\b/i.test(t)) return 'TS/SCI';
    if (/\bSCI\s+clearance\b/i.test(t)) return 'TS/SCI';
    if (/\bSensitive\s+Compartmented\s+Information\b/i.test(t)) return 'TS/SCI';
    if (/\bSpecial\s+Access\s+Program\b/i.test(t)) return 'TS/SCI';
    if (/\bSAP\s+clearance\b/i.test(t)) return 'TS/SCI';

    // Top Secret alone
    if (/\bTop\s*Secret\s+clearance\b/i.test(t)) return 'Top Secret';
    if (/\bactive\s+Top\s*Secret\b/i.test(t)) return 'Top Secret';

    // Secret
    if (/\bSecret\s+clearance\b/i.test(t)) return 'Secret';
    if (/\bactive\s+Secret\s+clearance\b/i.test(t)) return 'Secret';

    // Public Trust (federal jobs, no clearance but a background check)
    if (/\bPublic\s+Trust\s+(?:position|investigation|background)/i.test(t)) return 'Public Trust';

    // Generic "security clearance" without a tier — treat as Secret.
    if (/\bsecurity\s+clearance\b/i.test(t)) return 'Security Clearance';

    // CI polygraph + adjudication language ("must be able to pass a
    // polygraph" / "subject to a counterintelligence polygraph").
    if (/\b( counterintelligence | CI )?\s*polygraph\b/i.test(t)) return 'Polygraph';

    return null;
}

// How often (ms) the cron scans the table for rows needing a scrape.
const POLL_INTERVAL_MS = parseInt(process.env.JOB_LINKS_POLL_MS || 30 * 1000, 10);

// Minimum gap (ms) between two fetches. 500 ms = 2 requests/sec —
// LinkedIn's documented unauthenticated rate-limit threshold is much
// higher, but staying at 2/s keeps the IP from getting throttled
// during long runs.
const SCRAPE_INTERVAL_MS = parseInt(process.env.JOB_LINKS_SCRAPE_MS || 500, 10);

// Maximum number of rows processed in a single cron pass. Caps the
// longest possible scrape window so we don't spend 25 minutes straight
// scraping the table.
const MAX_BATCH = parseInt(process.env.JOB_LINKS_BATCH || 60, 10);

// Quiet period after the queue empties. Lets LinkedIn's rate-limit
// window fully reset before the next polling tick.
const IDLE_QUIET_MS = parseInt(process.env.JOB_LINKS_QUIET_MS || 5 * 1000, 10);

// After a row has failed this many times in a row, we mark it
// `dead` and stop retrying. Admins can revive a dead row by editing
// the URL or by updating `fetch_status` back to `pending`. Without
// this guard the cron would loop forever on the same broken URL
// (auth-walled LinkedIn IDs, 404 Greenhouse IDs, typo'd Lever
// companies, etc.) — blocking new rows from being processed.
const MAX_FAILURES = parseInt(process.env.JOB_LINKS_MAX_FAILURES || 6, 10);

// Exponential backoff base (ms). On the Nth consecutive failure the
// row waits BASE * 2^(N-1) minutes. With BASE=300_000 (5 min) we get
// 5m → 10m → 20m → 40m → 80m → 160m → … capped at MAX_FAILURES (=6 by
// default, so 80m). That keeps the queue clear of permanently-broken
// links while still giving transient failures a chance to clear on
// their own.
const BACKOFF_BASE_MS = parseInt(process.env.JOB_LINKS_BACKOFF_BASE_MS || 5 * 60 * 1000, 10);

// Stale-fetching threshold (ms). If a row has been stuck in
// `fetch_status = 'fetching'` for longer than this, the cron will
// flip it back to 'pending' so it can be retried. This guards
// against a process crash that left the row stuck in 'fetching'
// (the cron's `refreshQueue` deliberately excludes 'fetching' rows
// to avoid double-scraping, which is great until the worker that
// set the flag dies). 2 minutes is generous enough to absorb a
// full scrape timeout (default 30s) plus retries.
const STALE_FETCHING_MS = parseInt(process.env.JOB_LINKS_STALE_FETCHING_MS || 2 * 60 * 1000, 10);

// In-memory state -------------------------------------------------------------

let queue = [];
let workerRunning = false;
let shuttingDown = false;
let lastRunAt = null;
let lastError = null;
let lastAttemptAt = null;

// Provider chosen at boot. Stays in place for the lifetime of the
// process; we re-probe in the next poll cycle when the provider
// throws a "service unreachable" error so a transient outage recovers
// on its own.
let provider = null;

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

/**
 * Extract the numeric LinkedIn job id out of a
 * `linkedin.com/jobs/view/:id/?...` URL. Returns `null` if the URL
 * doesn't match. Re-exported for use by the route layer so that
 * legacy `linkedin_url` payloads still get the id parsed even though
 * the DB column was renamed to `source_url`.
 */
function extractLinkedInJobId(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/linkedin\.com\/jobs\/view\/(\d+)/i);
    return match ? match[1] : null;
}

/**
 * Normalize a LinkedIn URL down to the canonical
 * `https://www.linkedin.com/jobs/view/:id` form. We drop the
 * tracking params because LinkedIn's job page is keyed by the
 * numeric id and the tracking strings add nothing for scraping.
 */
function canonicalLinkedInUrl(url) {
    const id = extractLinkedInJobId(url);
    if (!id) return null;
    return `https://www.linkedin.com/jobs/view/${id}`;
}

/**
 * Read the URL we should scrape for a row. Prefer `source_url`, then
 * legacy `linkedin_url`, then `job_apply_url` (JobRight pastes often
 * put the only usable link in apply).
 */
function rowSourceUrl(row) {
    if (!row) return null;
    const { leverScrapeUrl, isLeverUrl } = require('./scraper/leverUrl');
    const src = row.source_url ?? row.linkedin_url ?? null;
    if (src && String(src).trim()) {
        const raw = String(src).trim();
        return isLeverUrl(raw) ? (leverScrapeUrl(raw) || raw) : raw;
    }
    const apply = row.job_apply_url;
    if (apply && String(apply).trim()) {
        const raw = String(apply).trim();
        return isLeverUrl(raw) ? (leverScrapeUrl(raw) || raw) : raw;
    }
    return null;
}

/**
 * Candidate scrape URLs for one row (deduped). Greenhouse embeds also
 * get a classic /jobs/<id> variant for the boards API. Lever `/apply`
 * links prefer the posting page (JD lives there, not on the form).
 */
function scrapeUrlCandidates(row) {
    const {
        greenhouseScrapeUrl,
        isGreenhouseUrl
    } = require('./scraper/greenhouseUrl');
    const {
        leverScrapeUrl,
        isLeverUrl
    } = require('./scraper/leverUrl');
    const out = [];
    const push = (u) => {
        const t = String(u || '').trim();
        if (!t) return;
        if (!out.includes(t)) out.push(t);
    };
    push(row.source_url ?? row.linkedin_url);
    push(row.job_apply_url);
    // Prefer ATS JD/posting shapes ahead of apply/form URLs.
    const preferred = [];
    for (const u of out) {
        if (isGreenhouseUrl(u) || greenhouseScrapeUrl(u) !== u) {
            preferred.push(greenhouseScrapeUrl(u));
        }
        if (isLeverUrl(u)) preferred.push(leverScrapeUrl(u));
    }
    for (const u of preferred) push(u);
    // Put posting/classic URLs first when they differ from apply links.
    const ordered = [];
    for (const u of preferred) {
        const t = String(u || '').trim();
        if (t && !ordered.includes(t)) ordered.push(t);
    }
    for (const u of out) {
        if (!ordered.includes(u)) ordered.push(u);
    }
    return ordered;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// DB transactions
// -----------------------------------------------------------------------------
//
// We open a SQL transaction around every fetch_status transition
// so the row's status is durable before/after the HTTP call. The
// HTTP call itself happens OUTSIDE the transaction (sql.js is
// in-memory; we don't want to hold a transaction for 5–30s while
// waiting for the upstream).
//
// Pattern:
//
//   tx(fn)              → BEGIN; fn(); COMMIT    (rollback on throw)
//   claimRowForFetch(id)→ tx: flip to 'fetching', commit
//   recordFetchSuccess  → tx: write fields, set 'success', commit
//   recordFetchFailure  → tx: set 'failed' or 'dead', bump failures, commit
//
// If the process crashes between `claimRowForFetch` and
// `recordFetchSuccess/Failure`, the row stays in 'fetching'. The
// `cleanupStaleFetching()` step (run at cron startup and on every
// poll cycle) flips rows stuck in 'fetching' for more than
// STALE_FETCHING_MS back to 'pending' so they can be retried.

/**
 * Run `fn` inside a SQL transaction. Commits on success, rolls
 * back on any thrown error. The `db` handle is the singleton
 * from `config/database.js`; sql.js auto-commits each `db.run`
 * separately, so we explicitly wrap multiple statements in
 * BEGIN/COMMIT to make them atomic.
 *
 * IMPORTANT: `fn` MUST use `txRunQuery` (not `runQuery`) for any
 * writes. sql.js's `db.export()` (called by `saveDatabase`) ends
 * the active transaction; calling `runQuery` inside a transaction
 * would silently break the BEGIN/COMMIT pair. We call
 * `saveDatabase()` exactly once after COMMIT, so the on-disk file
 * is in sync with the final committed state.
 *
 * We deliberately do NOT pass the `db` handle to `fn` — callers
 * should go through `txRunQuery`/`getOne`/`getAll` (which use the
 * same handle) so the helpers in `config/database.js` stay the
 * single source of truth for SQL execution.
 */
function withTransaction(fn) {
    const db = getDb();
    if (!db) {
        throw new Error('withTransaction: DB not initialized');
    }
    db.run('BEGIN');
    try {
        const result = fn();
        db.run('COMMIT');
        // Persist the committed state to disk. We do this AFTER
        // COMMIT (not during the transaction) so the export
        // doesn't break the BEGIN/COMMIT pair.
        saveDatabase();
        return result;
    } catch (err) {
        try {
            db.run('ROLLBACK');
        } catch (rollbackErr) {
            console.error('[jobLinkScraper] ROLLBACK failed:', rollbackErr.message);
        }
        throw err;
    }
}

/**
 * Atomically flip a row's fetch_status from 'pending' (or 'failed'
 * with elapsed next_retry_at) to 'fetching'. We add a guard
 * clause so we never claim a row that another worker has already
 * claimed — the `WHERE fetch_status IN ('pending', 'failed')`
 * clause returns 0 changes if the row is already 'fetching',
 * 'success', or 'dead'. Returns the row snapshot on success,
 * null on conflict (so the caller can skip).
 *
 * We use a conditional UPDATE inside a transaction — never a
 * SELECT + UPDATE pair — to avoid a TOCTOU race: two workers
 * might both pick up the same row at virtually the same time.
 * The conditional UPDATE serializes the claim.
 */
function claimRowForFetch(rowId) {
    const claimed = getOne(
        `SELECT id, source_url, job_apply_url, consecutive_failures
           FROM job_links
          WHERE id = ?
            AND fetch_status IN ('pending', 'failed')
            AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP)`,
        [rowId]
    );
    if (!claimed) return null;
    withTransaction(() => {
        // Re-issue the UPDATE inside the transaction so the
        // claim is atomic. If another worker grabbed it between
        // our SELECT and BEGIN, the UPDATE affects 0 rows and we
        // throw, which withTransaction rolls back.
        const db = getDb();
        db.run(
            `UPDATE job_links
                SET fetch_status = 'fetching',
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
                AND fetch_status IN ('pending', 'failed')`,
            [rowId]
        );
        if (db.getRowsModified() === 0) {
            throw new Error('row already claimed by another worker');
        }
    });
    return claimed;
}

/**
 * Flip rows stuck in `fetch_status = 'fetching'` for more than
 * STALE_FETCHING_MS back to 'pending'. This is the recovery path
 * for crashes: if the worker dies between `claimRowForFetch` and
 * `recordFetchSuccess`/`recordFetchFailure`, the row stays in
 * 'fetching' forever (the cron's `refreshQueue` excludes
 * 'fetching' rows).
 *
 * We run this at cron startup AND on every poll cycle. The
 * startup call is the important one — it cleans up state from
 * the previous process. The per-cycle call is defense-in-depth
 * for crashes that happen mid-run.
 *
 * Uses SQLite's datetime('now', '-<n> seconds') so the cutoff
 * timestamp is computed in the DB's timezone.
 */
function cleanupStaleFetching() {
    const secs = Math.ceil(STALE_FETCHING_MS / 1000);
    const result = runQuery(
        `UPDATE job_links
            SET fetch_status = 'pending',
                fetch_error = 'Recovered from stale fetching state (worker crash?)',
                updated_at = CURRENT_TIMESTAMP
          WHERE fetch_status = 'fetching'
            AND updated_at <= (SELECT datetime('now', '-${secs} seconds'))`
    );
    const changes = (result && typeof result === 'object' && 'changes' in result)
        ? result.changes
        : 0;
    if (changes > 0) {
        console.log(`[jobLinkScraper] recovered ${changes} stale-fetching row(s)`);
    }
    return changes;
}

// -----------------------------------------------------------------------------
// Row-level worker
// -----------------------------------------------------------------------------

/**
 * Fetch + parse a single row. Delegates the actual scraping to the
 * currently selected provider. Updates the row in place and returns
 * `{ ok, ...result }` for the caller.
 *
 * Three-phase transaction flow:
 *
 *   1. CLAIM (transaction): atomically flip
 *      `fetch_status` from 'pending'/'failed' to 'fetching'.
 *      Uses a conditional UPDATE so two workers can never both
 *      claim the same row. Skips the row if the claim loses the
 *      race or the row's status has moved out from under us.
 *
 *   2. FETCH (no transaction): HTTP call to the provider. This
 *      can take 5–30s; we deliberately don't hold a DB
 *      transaction across it. If the process crashes here, the
 *      row stays 'fetching' and `cleanupStaleFetching` recovers
 *      it on the next cron tick.
 *
 *   3. COMMIT (transaction): write the result — either the
 *      description fields with `fetch_status = 'success'`, or
 *      a failure record with `fetch_status = 'failed'/'dead'`.
 *      Either is atomic; if the commit fails, the row is left
 *      'fetching' and the next cron tick will retry.
 *
 * Provider error handling:
 *   - "service unreachable" errors downgrade the row to 'failed' with
 *     the error message; the next cron tick will try again.
 *   - Successful parses update `job_description`, `company_name`,
 *     `position_title`, `location`. We use COALESCE for the metadata
 *     fields so a partial parse doesn't blank out a name the admin
 *     typed in manually.
 */
/**
 * After a JD is ready (scrape success or skip-with-existing-desc),
 * enqueue CV generation for matching profiles immediately instead of
 * waiting for the next auto-apply cron tick.
 */
function scheduleAutoCvKick(jobLinkId) {
    if (!jobLinkId) return;
    setImmediate(() => {
        Promise.resolve()
            .then(() => {
                const jobMatchService = require('./jobMatchService');
                return jobMatchService.reconcileJobLinkAfterMetadataChange(jobLinkId);
            })
            .then((r) => {
                if (r && r.enqueued > 0) {
                    console.log(
                        `[jobLinkScraper] auto-enqueued ${r.enqueued} CV(s) for job_link=${jobLinkId}`
                    );
                }
            })
            .catch((err) => {
                console.warn(
                    `[jobLinkScraper] auto CV kick failed for job_link=${jobLinkId}:`,
                    err && err.message ? err.message : err
                );
            });
    });
}

async function scrapeRow(row) {
    if (!row) return { ok: false, error: 'Not found' };

    // Some callers historically SELECT'd only source_url. After
    // resolveStoredJobUrls nulls a redundant source, the only scrape
    // target lives on job_apply_url — reload so we don't skip.
    let working = row;
    let sourceUrl = rowSourceUrl(working);
    if (!sourceUrl && working.id) {
        const full = getOne(
            'SELECT id, source_url, job_apply_url, consecutive_failures FROM job_links WHERE id = ?',
            [working.id]
        );
        if (full) {
            working = full;
            sourceUrl = rowSourceUrl(working);
        }
    }
    row = working;

    if (!sourceUrl) {
        // Truly nothing to scrape. Do NOT mark success — that produces
        // the Fetched + JD empty UI state. Fail with a clear error so
        // retry/recovery can surface it instead of looping as "done".
        withTransaction(() => {
            txRunQuery(
                `UPDATE job_links
                 SET fetch_status = 'failed',
                     fetch_error = ?,
                     last_fetched_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                ['No source_url or job_apply_url to scrape', row.id]
            );
        });
        return { ok: false, error: 'No scrape URL', skipped: true };
    }

    // Detect which ATS we're dealing with. The order matters:
    // JobVite/Greenhouse/etc each match a specific path shape;
    // anything that doesn't match falls through to the generic
    // renderer (JSON-LD / OG / Playwright schema.org).
    const linkedinId = extractLinkedInJobId(sourceUrl);
    const isLinkedIn = !!linkedinId;
    // Greenhouse: boards.greenhouse.io or job-boards.greenhouse.io,
    // followed by /<board>/jobs/<id>.
    const isGreenhouse = /(?:^|\/\/)(?:job-boards|boards(?:\.eu)?)\.greenhouse\.io\//i.test(sourceUrl);
    // Lever: lever.co/<company>/...
    const isLever = /lever\.co\//i.test(sourceUrl);
    // Ashby: jobs.ashbyhq.com/<board>/<uuid>
    const isAshby = /jobs\.ashbyhq\.com\//i.test(sourceUrl);
    // iCIMS: *.icims.com/jobs/<id>/...
    const isIcims = /\.icims\.com\/jobs\//i.test(sourceUrl);
    // JobVite: jobs.jobvite.com/<company>/job/<id>
    const isJobvite = /jobs\.jobvite\.com\/[^/]+\/job\//i.test(sourceUrl);
    // MyWorkdayJobs: *.wd[1-5].myworkdayjobs.com/...
    const isWorkday = /(?:wd\d|myworkdayjobs)\.myworkdayjobs\.com\//i.test(sourceUrl);
    // SuccessFactors (used by Gainwell + many others):
    // *.successfactors.com / *.jobs.* / rmkcdn.successfactors.com
    const isSuccessFactors = /successfactors\.com|\/job\/[^/]+\/\d{6,}\/?$/i.test(sourceUrl);
    // Paycom: paycomonline.net/v4/ats/web.php/.../jobs/<id>
    const isPaycom = /paycomonline\.net\/v4\/ats\/web\.php\//i.test(sourceUrl);
    // ApplyToJob: <company>.applytojob.com/apply/<key>/<slug>
    const isApplyToJob = /applytojob\.com\/apply\//i.test(sourceUrl);
    // Rippling ATS: ats.rippling.com/<company>/jobs/<uuid>
    const isRippling = /ats\.rippling\.com\/[^/]+\/jobs\//i.test(sourceUrl);
    // Paylocity: recruiting.paylocity.com/Recruiting/Jobs/Apply/<id>[/<slug>]
    // or /Recruiting/Jobs/Details/<id>. Both shapes are accepted;
    // the Python fetcher rewrites Apply → Details before fetching.
    const isPaylocity = /recruiting\.paylocity\.com\/Recruiting\/Jobs\/(?:Apply|Details)\/\d+/i.test(sourceUrl);

    // Explicit allow-list for ATS-style hosts the generic
    // Playwright renderer (JSON-LD / OG meta / Phenom People /
    // custom career portals) knows how to handle. These are
    // hosts that don't ship their own structured provider but
    // still embed schema.org/JobPosting or OG meta tags, so
    // sending them to the Python generic renderer is worth a
    // try. Anything NOT in this list still gets rejected below
    // so we don't spend 30s on every random URL that lands in
    // the table.
    const GENERIC_ATS_HOSTS = [
        // Aggregators
        'easyapply.co',                      // LinkedIn-via-easyapply wrapper (OG + JSON-LD)
        'adzuna.com',                        // job aggregator (OG meta)
        'www.adzuna.com',
        'dsp.prng.co',                       // DSP click-redirector (resolves to ATS)
        'prng.co',
        // Custom career portals (Phenom People / WordPress /
        // generic SPA). The Python renderer pulls JSON-LD or
        // OG meta from these even though we have no dedicated
        // parser for them.
        'careers.blizzard.com',              // Blizzard — Phenom People
        'careers.nlsnow.com',                // NLSNOW — WordPress careers
        'careers.workopolis.com',
        'jobs.lever.co',
        'jobs.eu.lever.co',
        'jobs.bloomberg.com',
        'jobs.smartrecruiters.com',
        'apply.workable.com',
        'jobs.ashbyhq.com',
        'jobs.bambee.com',
        'jobs.bolt.com',
        'jobs.gem.com',
        'jobs.personio.com',
        'boards.eu.greenhouse.io',
        'applytojob.com',
        'workforcenow.adp.com',              // ADP Workforce Now
        'myjobs.adp.com',
        'careers.smartrecruiters.com',
        'jobs.dayforce.com',
        'recruiting2.ultipro.com',
        'recruiting.paylocity.com',          // already covered above; safe to keep
        'apply.bamboohr.com',
        'teamtailor.com',
        // Anything ending in careers.<corp>.com — broad net
        // for enterprise career portals we haven't seen yet.
        // The regex below matches the literal suffix.
    ];
    const host = (() => {
        try { return new URL(sourceUrl).hostname.toLowerCase(); } catch { return ''; }
    })();
    const isGenericAtsHost =
        GENERIC_ATS_HOSTS.includes(host) ||
        // Anything that looks like a corporate career portal —
        // e.g. `careers.acme.com`, `jobs.acme.com`,
        // `apply.acme.com`. The Python generic renderer will
        // do its best with JSON-LD + OG. This is intentionally
        // conservative: we still reject pure root-domain URLs
        // (e.g. acme.com homepage) because the renderer can't
        // extract job data from those.
        /^(?:careers|jobs|apply|employment|join|board)\.[a-z0-9.-]+\.[a-z]{2,}$/i.test(host);

    // Permissive fallback: if the URL doesn't match any of the
    // dedicated ATS shapes above, but it IS a well-formed http(s)
    // URL with a parseable hostname, we let the Python generic
    // renderer (Playwright + JSON-LD + OG meta) take a crack at
    // it. This is the right default for a worker-driven pipeline:
    // the cost of "trying" is one Playwright render (~5-30s),
    // which is far cheaper than the user manually re-adding the
    // row every time they hit a careers URL we haven't seen
    // before.
    //
    // We still reject URLs that obviously aren't job posts:
    //   - localhost / 127.x / 0.x / private RFC1918 ranges
    //     (someone trying to scrape their own box / an SSRF target)
    //   - non-http(s) schemes (file://, ftp://, etc.)
    //   - missing or empty hostname
    //
    // Anything that passes those basic checks gets handed to the
    // Python generic renderer. If THAT also can't find job data,
    // the row gets `fetch_status='failed'` with a useful
    // `fetch_error` explaining what was tried — the admin can then
    // either fix the URL or accept the failure.
    const isWellFormedHttpUrl = (() => {
        try {
            const u = new URL(sourceUrl);
            if (!/^https?:$/.test(u.protocol)) return false;
            const h = (u.hostname || '').toLowerCase();
            if (!h) return false;
            // SSRF guard — reject obvious local/private targets.
            if (h === 'localhost' || h.endsWith('.localhost')) return false;
            if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(h)) return false;
            if (h.endsWith('.local') || h.endsWith('.internal')) return false;
            return true;
        } catch {
            return false;
        }
    })();

    if (
        !isLinkedIn && !isGreenhouse && !isLever && !isAshby && !isIcims &&
        !isJobvite && !isWorkday && !isSuccessFactors && !isPaycom &&
        !isApplyToJob && !isRippling && !isPaylocity &&
        !isGenericAtsHost &&
        !isWellFormedHttpUrl
    ) {
        const err = 'URL is not a well-formed http(s) URL with a public hostname — refusing to forward it to the generic renderer';
        recordFailure(row.id, err, row.consecutive_failures || 0);
        return { ok: false, error: err };
    }

    const url = isLinkedIn ? canonicalLinkedInUrl(sourceUrl) : sourceUrl;
    const urlCandidates = (() => {
        const list = scrapeUrlCandidates({ ...row, source_url: url || sourceUrl });
        if (url && !list.includes(url)) list.unshift(url);
        return list.length ? list : [url].filter(Boolean);
    })();

    // -------------------------------------------------------------------------
    // Phase 1: CLAIM — atomically flip to 'fetching'
    // -------------------------------------------------------------------------
    // If the row no longer qualifies (e.g. another worker already
    // claimed it, or the user edited it back to 'pending' between
    // the cron requeue and now), bail out cleanly. The cron's
    // `refreshQueue` runs every POLL_INTERVAL_MS so a missed row
    // will be picked up on the next cycle.
    let claimed;
    try {
        claimed = claimRowForFetch(row.id);
    } catch (err) {
        // claimRowForFetch throws on a race conflict. Treat that
        // as a benign skip — the other worker has the row.
        if (err && /already claimed/i.test(err.message)) {
            return { ok: false, error: 'row already claimed by another worker', skipped: true };
        }
        throw err;
    }
    if (!claimed) {
        return { ok: false, error: 'row no longer needs fetching', skipped: true };
    }

    // -------------------------------------------------------------------------
    // Phase 2: FETCH — try source / apply / Greenhouse classic variants
    // -------------------------------------------------------------------------
    let parsed = null;
    let usedUrl = urlCandidates[0] || url;
    let lastFetchError = null;
    for (const candidate of urlCandidates) {
        usedUrl = candidate;
        try {
            parsed = await provider.fetchJobLinkedIn(candidate);
        } catch (err) {
            parsed = { error: formatFetchError(err) };
        }
        if (parsed && !parsed.error && parsed.description
            && String(parsed.description).trim().length >= 80) {
            break;
        }
        if (parsed && parsed.error) {
            lastFetchError = parsed.error;
            // Hard ATS miss — no point trying other Greenhouse variants of same board/id
            if (/greenhouse-job-not-found|ashby-posting-not-found/i.test(parsed.error)) {
                // Inferred company-page boards (ZoomInfo + gh_jid) may
                // 404 on the guessed token — keep trying the original URL.
                const inferredCompanyGh =
                    /greenhouse-job-not-found/i.test(parsed.error)
                    && !/greenhouse\.io/i.test(sourceUrl || '');
                if (!inferredCompanyGh) break;
            }
            parsed = { error: parsed.error };
            continue;
        }
        // Thin / empty — try next candidate
        lastFetchError = 'scrape-empty: no usable job description extracted from page';
        parsed = { error: lastFetchError };
    }
    lastAttemptAt = new Date().toISOString();

    async function tryGeminiRescue(priorError) {
        const gemini = require('./geminiScrapeService');
        const rescued = await gemini.rescueFailedScrape(usedUrl, priorError);
        if (rescued && rescued.ok && rescued.description) {
            return {
                ok: true,
                parsed: {
                    title: rescued.title,
                    company: rescued.company,
                    location: rescued.location,
                    description: rescued.description,
                    gemini: { slot: rescued.slot, model: rescued.model }
                }
            };
        }
        return { ok: false, rescued };
    }

    if (parsed && parsed.error) {
        // ---------------------------------------------------------------------
        // Gemini rescue (optional): skipped when disabled / geo-blocked
        // ---------------------------------------------------------------------
        try {
            const result = await tryGeminiRescue(parsed.error);
            if (result.ok) {
                parsed = result.parsed;
            } else {
                const rescued = result.rescued;
                const msg = rescued?.skippedGemini
                    ? (rescued.error || parsed.error)
                    : `${parsed.error}${rescued?.error ? ` | gemini:${rescued.error}` : ''}`;
                recordFailure(row.id, msg, row.consecutive_failures || 0);
                if (provider === pythonService || /unreachable|ECONN|ETIMEDOUT/i.test(String(parsed.error))) {
                    provider = await selectProvider();
                }
                return { ok: false, error: msg, geminiError: rescued?.error };
            }
        } catch (rescueErr) {
            recordFailure(row.id, parsed.error, row.consecutive_failures || 0);
            if (provider === pythonService || /unreachable|ECONN|ETIMEDOUT/i.test(String(parsed.error))) {
                provider = await selectProvider();
            }
            return { ok: false, error: parsed.error, geminiError: rescueErr.message };
        }
    }

    // Treat thin/empty scrapes as failure unless Gemini already filled description above.
    let hasDesc = !!(parsed && parsed.description && String(parsed.description).trim().length >= 80);
    if (!hasDesc) {
        try {
            const result = await tryGeminiRescue('scrape-empty');
            if (result.ok) {
                parsed = {
                    title: result.parsed.title || parsed?.title,
                    company: result.parsed.company || parsed?.company,
                    location: result.parsed.location || parsed?.location,
                    description: result.parsed.description,
                    gemini: result.parsed.gemini
                };
                hasDesc = true;
            } else {
                const rescued = result.rescued;
                const emptyErr = rescued?.skippedGemini
                    ? (rescued.error || 'scrape-empty: no usable job description extracted from page')
                    : `scrape-empty: no usable job description | gemini:${rescued?.error || 'no_rescue'}`;
                recordFailure(row.id, emptyErr, row.consecutive_failures || 0);
                return { ok: false, error: emptyErr };
            }
        } catch (rescueErr) {
            const emptyErr = 'scrape-empty: no usable job description extracted from page';
            recordFailure(row.id, emptyErr, row.consecutive_failures || 0);
            return { ok: false, error: emptyErr, geminiError: rescueErr.message };
        }
    }

    // -------------------------------------------------------------------------
    // Phase 3b: COMMIT success
    // -------------------------------------------------------------------------
    // Success — overwrite description and use COALESCE for the
    // metadata fields so a partial parse doesn't blank out a name
    // the admin typed in manually.
    //
    // Clearance auto-disable: if the description references a
    // security clearance (TS/SCI, Top Secret, Secret, Public Trust,
    // etc.) we flip is_available=0 and write the label to
    // clearance_required. This keeps the auto-apply pipeline from
    // targeting roles that most candidates on this platform can't
    // accept. The admin can always override by re-enabling the row
    // in the UI, but they need to do it explicitly so they're aware
    // of the requirement.
    //
    // For rows WITHOUT clearance language, we preserve the admin's
    // current `is_available` value via COALESCE — a successful
    // fetch shouldn't be interpreted as "re-enable this row". The
    // admin's manual disable wins.
    const normalizedDesc = normalizeDescription(parsed.description) || null;
    const clearance = detectClearanceRequirement(normalizedDesc);
    const availableAfterScrape = clearance ? 0 : null;  // null → COALESCE keeps existing value

    // Prefer a Greenhouse embed apply URL so Auto Bidder opens the form, not JD-only.
    // Also strip JobRight tracking and drop a redundant source_url when it is
    // the same posting as apply (Lever …/uuid vs …/uuid/apply?utm=…).
    let applyUrlPatch = null;
    let sourceUrlPatch = null;
    let clearRedundantSource = false;
    try {
        const {
            canonicalizeGreenhouseApplyUrl,
            isGreenhouseUrl,
            parseGreenhouseBoardAndJob
        } = require('./scraper/greenhouseUrl');
        const {
            resolveStoredJobUrls,
            urlsReferToSameJob
        } = require('./scraper/jobLinkUrl');
        const seed = usedUrl || row.job_apply_url || sourceUrl;
        const resolved = resolveStoredJobUrls(row.source_url, row.job_apply_url || seed);
        if (resolved.apply && resolved.apply !== row.job_apply_url) {
            applyUrlPatch = resolved.apply;
        } else if (isGreenhouseUrl(seed)) {
            const canon = canonicalizeGreenhouseApplyUrl(seed);
            if (canon && canon !== row.job_apply_url) {
                applyUrlPatch = canon;
            }
        }
        if (resolved.source && resolved.source !== row.source_url) {
            sourceUrlPatch = resolved.source;
        }
        const nextApply = applyUrlPatch || row.job_apply_url;
        const { isLeverUrl } = require('./scraper/leverUrl');
        // Never drop Lever source — that posting URL (no /apply) is
        // what scrape needs. Apply stays on …/uuid/apply for the bidder.
        const companyGh = parseGreenhouseBoardAndJob(row.source_url);
        if (
            !isLeverUrl(nextApply || row.source_url)
            && row.source_url
            && nextApply
            && urlsReferToSameJob(row.source_url, nextApply)
            && !(companyGh && companyGh.shape === 'company_gh_jid')
        ) {
            clearRedundantSource = true;
        }
        if (!isLeverUrl(nextApply || row.source_url) && resolved.source === null && row.source_url) {
            clearRedundantSource = true;
        }
    } catch (_) { /* ignore */ }

    try {
        withTransaction(() => {
            if (applyUrlPatch || sourceUrlPatch || clearRedundantSource) {
                txRunQuery(
                    `UPDATE job_links
                     SET job_description = ?,
                         company_name = COALESCE(?, company_name),
                         position_title = COALESCE(?, position_title),
                         location = COALESCE(?, location),
                         job_apply_url = COALESCE(?, job_apply_url),
                         source_url = CASE WHEN ? THEN NULL ELSE COALESCE(?, source_url) END,
                         is_available = COALESCE(?, is_available),
                         clearance_required = COALESCE(?, clearance_required),
                         fetch_status = 'success',
                         fetch_error = NULL,
                         consecutive_failures = 0,
                         next_retry_at = NULL,
                         last_fetched_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        normalizedDesc,
                        parsed.company || null,
                        parsed.title || null,
                        parsed.location || null,
                        applyUrlPatch,
                        clearRedundantSource ? 1 : 0,
                        sourceUrlPatch,
                        availableAfterScrape,
                        clearance || null,
                        row.id
                    ]
                );
            } else {
                txRunQuery(
                    `UPDATE job_links
                     SET job_description = ?,
                         company_name = COALESCE(?, company_name),
                         position_title = COALESCE(?, position_title),
                         location = COALESCE(?, location),
                         is_available = COALESCE(?, is_available),
                         clearance_required = COALESCE(?, clearance_required),
                         fetch_status = 'success',
                         fetch_error = NULL,
                         consecutive_failures = 0,
                         next_retry_at = NULL,
                         last_fetched_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        normalizedDesc,
                        parsed.company || null,
                        parsed.title || null,
                        parsed.location || null,
                        availableAfterScrape,
                        clearance || null,
                        row.id
                    ]
                );
            }
        });
    } catch (err) {
        // Commit failed. The row stays 'fetching' and the cron
        // will eventually recover it via cleanupStaleFetching.
        console.error(`[jobLinkScraper] commit success failed for row ${row.id}:`, err.message);
        throw err;
    }

    if (clearance) {
        console.log(`[jobLinkScraper] row ${row.id} disabled — requires ${clearance}`);
    }

    // Kick CV generation as soon as the JD lands — don't wait for cron.
    scheduleAutoCvKick(row.id);

    return { ok: true, ...parsed, clearance_required: clearance || null, is_available: availableAfterScrape };
}

/**
 * Record a scrape failure for a row. Bumps `consecutive_failures`,
 * sets `next_retry_at` to an exponentially-distant future time, and
 * flips the row to `dead` once the failure count exceeds
 * MAX_FAILURES so the cron stops retrying it.
 *
 * Backoff schedule (with BACKOFF_BASE_MS = 5min, MAX_FAILURES = 6):
 *   failure #1 → retry in  5 minutes
 *   failure #2 → retry in 10 minutes
 *   failure #3 → retry in 20 minutes
 *   failure #4 → retry in 40 minutes
 *   failure #5 → retry in 80 minutes
 *   failure #6 → row goes DEAD, terminal until a human intervenes
 */
function recordFailure(rowId, errorMessage, currentFailures) {
    const newFailures = (currentFailures || 0) + 1;
    const capped = Math.min(newFailures, MAX_FAILURES);
    const isDead = capped >= MAX_FAILURES;

    let nextRetryAt;
    if (isDead) {
        // No next retry — set a far-future timestamp so even if the
        // status is accidentally flipped back to 'failed' the row
        // won't be retried for a long time.
        nextRetryAt = null;
    } else {
        // 5 min × 2^(failures-1), capped at 24h.
        const ms = Math.min(BACKOFF_BASE_MS * Math.pow(2, capped - 1), 24 * 60 * 60 * 1000);
        // We let SQLite compute the future timestamp via
        // datetime('now', '+<n> seconds') so the calculation is
        // done in the DB's timezone.
        const secs = Math.ceil(ms / 1000);
        nextRetryAt = `(SELECT datetime('now', '+${secs} seconds'))`;
    }

    // Wrap the failure record in a transaction so the status +
    // counter + next_retry_at + error message are written atomically.
    // A partial write (e.g. status updated but counter not) would
    // give the cron a wrong view of the row's state.
    try {
        withTransaction(() => {
            txRunQuery(
                `UPDATE job_links
                 SET fetch_status = ?,
                     fetch_error = ?,
                     consecutive_failures = ?,
                     next_retry_at = ${nextRetryAt || 'NULL'},
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [
                    isDead ? 'dead' : 'failed',
                    String(errorMessage).slice(0, 1000),
                    capped,
                    rowId,
                ]
            );
        });
    } catch (err) {
        console.error(`[jobLinkScraper] recordFailure commit failed for row ${rowId}:`, err.message);
        throw err;
    }

    if (isDead) {
        console.warn(
            `[jobLinkScraper] row ${rowId} marked dead after ${capped} failures`
        );
    }
}

// -----------------------------------------------------------------------------
// Cron worker
// -----------------------------------------------------------------------------

/**
 * Drain the in-memory queue. One row is shifted, fetched, then we
 * honour `SCRAPE_INTERVAL_MS` so the cron keeps its 2/s cap even
 * across failed rows. The loop exits once the queue is empty,
 * letting the outer `cronLoop` re-poll the DB and re-fill.
 */
async function drainQueue() {
    while (!shuttingDown && queue.length > 0) {
        const id = queue.shift();
        const row = getOne(
            'SELECT id, source_url, job_apply_url, consecutive_failures FROM job_links WHERE id = ?',
            [id]
        );
        if (!row) {
            // Row was deleted while sitting in the queue.
            continue;
        }
        try {
            const result = await scrapeRow(row);
            if (!result.ok) {
                console.warn(`[jobLinkScraper] row ${row.id} scrape failed:`, result.error);
            }
        } catch (err) {
            console.error(`[jobLinkScraper] row ${row.id} unhandled error:`, err);
            lastError = err.message;
        }
        await sleep(SCRAPE_INTERVAL_MS);
    }
    if (queue.length === 0) {
        await sleep(IDLE_QUIET_MS);
    }
}

/**
 * Refresh the queue from the DB. Picks rows that are pending or
 * previously failed (whose `next_retry_at` has elapsed), up to
 * MAX_BATCH per pass. `dead` rows are excluded — they're terminal
 * until a human edits them. `fetching` rows are excluded so we don't
 * double-scrape.
 */
function refreshQueue() {
    // Pick up rows that are ready to be retried now:
    //
    //   - `pending` rows — first attempt
    //   - `failed` rows — whose `next_retry_at` has elapsed (or is
    //     NULL — the column starts NULL on a freshly inserted row
    //     and the backoff UPDATE sets it for subsequent retries).
    //
    // We deliberately exclude rows with fetch_status = 'dead' — those
    // are terminal until a human edits them. We deliberately exclude
    // 'fetching' rows so we don't double-scrape.
    //
    // Ordering: pending first (so a brand-new row beats the queue of
    // retried failures), then failures by `next_retry_at ASC` (oldest
    // eligible first). `MAX_BATCH` caps the per-pass queue size.
    const candidates = getAll(
        `SELECT id FROM job_links
         WHERE (
                fetch_status = 'pending'
                OR (fetch_status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP))
              )
           AND source_url IS NOT NULL AND TRIM(source_url) <> ''
         ORDER BY (fetch_status = 'pending') DESC, next_retry_at ASC, updated_at ASC
         LIMIT ?`,
        [MAX_BATCH]
    );
    queue = candidates.map((r) => r.id);
}

/**
 * IDs due for scrape/retry (pending or failed past next_retry_at).
 * Used by jobDetailFetchService retry scheduler.
 */
function listDueJobLinkIds(limit = MAX_BATCH) {
    const rows = getAll(
        `SELECT id FROM job_links
         WHERE (
                fetch_status = 'pending'
                OR (fetch_status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP))
              )
           AND source_url IS NOT NULL AND TRIM(source_url) <> ''
         ORDER BY (fetch_status = 'pending') DESC, next_retry_at ASC, updated_at ASC
         LIMIT ?`,
        [Math.min(Math.max(parseInt(limit, 10) || MAX_BATCH, 1), 200)]
    );
    return rows.map((r) => r.id);
}

async function cronLoop() {
    while (!shuttingDown) {
        try {
            // Defense-in-depth: any rows stuck in 'fetching' from
            // a previous process crash get moved back to 'pending'
            // before we re-queue. Cheap enough to run every cycle.
            cleanupStaleFetching();
            refreshQueue();
            lastRunAt = new Date().toISOString();
            if (queue.length > 0) {
                workerRunning = true;
                await drainQueue();
            }
        } catch (err) {
            console.error('[jobLinkScraper] cron loop error:', err);
            lastError = err.message;
        } finally {
            workerRunning = false;
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Initialise the scraper provider. Idempotent — calling twice is a
 * no-op. The actual fetching work is driven by the RabbitMQ worker
 * in `services/jobDetailFetchService.js`; this just picks which
 * backend (pythonService vs nodeBuiltin) to talk to.
 *
 * Also runs the one-time startup recovery: any rows stuck in
 * `fetching` from a previous (crashed) process get flipped back to
 * `pending` and re-enqueued, so a fresh boot never silently drops
 * work.
 */
async function initProvider() {
    if (provider) return provider;
    try {
        provider = await selectProvider();
    } catch (err) {
        console.error('[jobLinkScraper] provider selection failed:', err);
        provider = require('./scraper/providers').nodeBuiltin;
    }
    // Recover rows from the previous process. If anything was
    // stuck in 'fetching' when the previous run died (crash,
    // SIGKILL, etc.), flip it back to 'pending' so the new
    // process can pick it up.
    try {
        const recovered = cleanupStaleFetching();
        if (recovered > 0) {
            console.log(`[jobLinkScraper] startup: recovered ${recovered} stale-fetching row(s) from previous process`);
        }
        // After recovery, find any rows still in `pending` (those
        // recovered above + any rows added while the broker was
        // down) and re-enqueue them so they don't sit forever.
        // Also heal false "success" with empty JD (bug: scrape marked
        // done without loading job_apply_url after source_url was nulled).
        const pending = getAll(
            `SELECT id FROM job_links
              WHERE (
                    fetch_status IN ('pending', 'failed')
                 OR (
                        fetch_status = 'success'
                    AND (job_description IS NULL OR TRIM(job_description) = '')
                    AND (
                           (source_url IS NOT NULL AND TRIM(source_url) <> '')
                        OR (job_apply_url IS NOT NULL AND TRIM(job_apply_url) <> '')
                    )
                 )
              )
                AND consecutive_failures < ?
              ORDER BY last_fetched_at IS NULL DESC, last_fetched_at ASC, id ASC
              LIMIT 200`,
            [MAX_FAILURES]
        );
        if (pending.length > 0) {
            // Reset false-success empty-JD rows so claimRowForFetch accepts them.
            withTransaction(() => {
                for (const p of pending) {
                    txRunQuery(
                        `UPDATE job_links
                            SET fetch_status = 'pending',
                                fetch_error = NULL,
                                updated_at = CURRENT_TIMESTAMP
                          WHERE id = ?
                            AND fetch_status = 'success'
                            AND (job_description IS NULL OR TRIM(job_description) = '')`,
                        [p.id]
                    );
                }
            });
            const jobDetailFetch = require('./jobDetailFetchService');
            for (const p of pending) {
                try {
                    await jobDetailFetch.enqueueJobDetailFetch(p.id, { source: 'recovery' });
                } catch (err) {
                    console.warn(`[jobLinkScraper] recovery enqueue failed for job_link=${p.id}:`, err.message);
                }
            }
            console.log(`[jobLinkScraper] startup: re-enqueued ${pending.length} pending job_link(s)`);
        }
    } catch (err) {
        console.warn('[jobLinkScraper] startup cleanup failed:', err.message);
    }
    console.log(`[jobLinkScraper] provider initialised: ${provider.name}`);
    return provider;
}

async function shutdownProvider() {
    provider = null;
}

/**
 * Fetch a single row by id. The cron also owns scraping, but this
 * direct entrypoint is useful for tests and for the admin
 * scrape-now endpoint (`POST /admin/job-links/:id/scrape`).
 *
 * The endpoint goes through the same transactional flow as the
 * cron path: `scrapeRow` calls `claimRowForFetch` to atomically
 * flip the row to 'fetching', runs the HTTP call, then commits
 * the result. The admin button is just a manual "do this now"
 * — it shares the same queue semantics as the cron.
 */
async function scrapeJobLinkById(id) {
    if (!provider) {
        provider = await selectProvider();
    }
    const row = getOne(
        'SELECT id, source_url, job_apply_url, consecutive_failures FROM job_links WHERE id = ?',
        [id]
    );
    if (!row) return { ok: false, error: 'Not found' };
    return scrapeRow(row);
}

/**
 * Observability for the UI: which provider is currently active, and
 * the per-row fetch tunables. The cron-loop fields (queueSize,
 * workerRunning, lastRunAt) are no longer meaningful — fetching is
 * now driven by the RabbitMQ worker in
 * `services/jobDetailFetchService.js`. The route layer reads that
 * status from the queue service instead.
 */
function getCronStatus() {
    let gemini = null;
    try {
        gemini = require('./geminiScrapeService').getStatus();
    } catch (_) { /* ignore */ }
    return {
        provider: provider ? provider.name : 'pending',
        authReady: provider && provider.name === 'pythonService'
            ? Boolean(process.env.LINKEDIN_LI_AT)
            : false,
        scrapeIntervalMs: SCRAPE_INTERVAL_MS,
        maxBatch: MAX_BATCH,
        queueSize: 0,
        workerRunning: false,
        lastRunAt: null,
        lastAttemptAt: null,
        lastError: null,
        gemini
    };
}

module.exports = {
    initProvider,
    shutdownProvider,
    scrapeJobLinkById,
    extractLinkedInJobId,
    canonicalLinkedInUrl,
    getCronStatus,
    // Re-exported for the recovery pass at boot and for tests.
    cleanupStaleFetching,
    listDueJobLinkIds
};
