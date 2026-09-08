/**
 * Greenhouse URL helpers shared by the Node scraper and bidder open_url path.
 *
 * Supported shapes:
 *   boards[.eu].greenhouse.io/<board>/jobs/<id>
 *   job-boards.greenhouse.io/<board>/jobs/<id>
 *   job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>   (JobRight)
 *   any greenhouse.io host with ?for=&token= / ?gh_jid=
 */
'use strict';

function parseGreenhouseBoardAndJob(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;

    const classic = raw.match(
        /\/(?:boards(?:\.eu)?|job-boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i
    );
    if (classic && classic[1].toLowerCase() !== 'embed') {
        return { board: classic[1], jobId: classic[2], shape: 'classic' };
    }

    try {
        const u = new URL(raw);
        const host = (u.hostname || '').toLowerCase();
        if (!/(?:^|\.)greenhouse\.io$/i.test(host)) return null;

        let board =
            u.searchParams.get('for')
            || u.searchParams.get('board')
            || null;
        let jobId =
            u.searchParams.get('token')
            || u.searchParams.get('gh_jid')
            || u.searchParams.get('job_id')
            || null;

        if (!jobId) {
            const m = u.pathname.match(/\/jobs\/(\d+)/i);
            if (m) jobId = m[1];
        }
        if (!board) {
            const segs = u.pathname.split('/').filter(Boolean);
            if (
                segs.length >= 2
                && segs[0].toLowerCase() !== 'embed'
                && segs[1].toLowerCase() === 'jobs'
            ) {
                board = segs[0];
            }
        }

        if (board && jobId && /^\d+$/.test(jobId)) {
            return { board, jobId, shape: 'embed_or_query' };
        }
    } catch (_) {
        /* ignore */
    }
    return null;
}

/** Classic job page — good for boards-api lookup. */
function greenhouseJobsPageUrl(parsedOrUrl) {
    const p = typeof parsedOrUrl === 'string'
        ? parseGreenhouseBoardAndJob(parsedOrUrl)
        : parsedOrUrl;
    if (!p) return null;
    return `https://job-boards.greenhouse.io/${p.board}/jobs/${p.jobId}`;
}

/**
 * Canonical apply/form URL for Auto Bidder open + fill.
 * Embed job_app is the live application form JobRight uses.
 */
function canonicalizeGreenhouseApplyUrl(url) {
    const p = parseGreenhouseBoardAndJob(url);
    if (!p) return url || null;
    const q = new URLSearchParams({ for: p.board, token: String(p.jobId) });
    return `https://job-boards.greenhouse.io/embed/job_app?${q.toString()}`;
}

/** Prefer classic jobs URL for structured API scrape; fall back to original. */
function greenhouseScrapeUrl(url) {
    return greenhouseJobsPageUrl(url) || url;
}

function isGreenhouseUrl(url) {
    return /(?:^|\/\/)(?:[^/]*\.)?greenhouse\.io\b/i.test(String(url || ''));
}

module.exports = {
    parseGreenhouseBoardAndJob,
    greenhouseJobsPageUrl,
    canonicalizeGreenhouseApplyUrl,
    greenhouseScrapeUrl,
    isGreenhouseUrl
};
