/**
 * Greenhouse URL helpers shared by the Node scraper and bidder open_url path.
 *
 * Supported shapes:
 *   boards[.eu].greenhouse.io/<board>/jobs/<id>
 *   job-boards.greenhouse.io/<board>/jobs/<id>
 *   job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>   (JobRight)
 *   any greenhouse.io host with ?for=&token= / ?gh_jid=
 *   company career pages that embed Greenhouse via ?gh_jid= (ZoomInfo, etc.)
 */
'use strict';

/** Hosts whose first label is the Greenhouse board token. */
const GREENHOUSE_HOST_BOARDS = {
    'zoominfo.com': 'zoominfo'
};

const CAREER_SUBDOMAINS = new Set([
    'www', 'careers', 'jobs', 'apply', 'recruiting', 'talent', 'boards', 'go'
]);

function normalizeGreenhouseJobId(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/\D/g, '');
    return /^\d{5,}$/.test(digits) ? digits : null;
}

function inferGreenhouseBoardFromHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || /(?:^|\.)greenhouse\.io$/i.test(host)) return null;
    if (GREENHOUSE_HOST_BOARDS[host]) return GREENHOUSE_HOST_BOARDS[host];
    const noWww = host.replace(/^www\./, '');
    if (GREENHOUSE_HOST_BOARDS[noWww]) return GREENHOUSE_HOST_BOARDS[noWww];
    const parts = noWww.split('.');
    if (parts.length < 2) return null;
    if (CAREER_SUBDOMAINS.has(parts[0]) && parts.length >= 3) {
        return parts[1];
    }
    return parts[0] || null;
}

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
        const isGhHost = /(?:^|\.)greenhouse\.io$/i.test(host);

        let board =
            u.searchParams.get('for')
            || u.searchParams.get('board')
            || null;
        let jobId = normalizeGreenhouseJobId(
            u.searchParams.get('token')
            || u.searchParams.get('gh_jid')
            || u.searchParams.get('job_id')
            || u.searchParams.get('jobid')
        );

        if (!jobId && isGhHost) {
            const m = u.pathname.match(/\/jobs\/(\d+)/i);
            if (m) jobId = m[1];
        }
        if (!board && isGhHost) {
            const segs = u.pathname.split('/').filter(Boolean);
            if (
                segs.length >= 2
                && segs[0].toLowerCase() !== 'embed'
                && segs[1].toLowerCase() === 'jobs'
            ) {
                board = segs[0];
            }
        }
        if (!board && !isGhHost && jobId) {
            board = inferGreenhouseBoardFromHost(host);
        }

        if (board && jobId && /^\d+$/.test(jobId)) {
            return {
                board,
                jobId,
                shape: isGhHost ? 'embed_or_query' : 'company_gh_jid'
            };
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

function isGreenhouseIoHost(url) {
    return /(?:^|\/\/)(?:[^/]*\.)?greenhouse\.io\b/i.test(String(url || ''));
}

/** True for greenhouse.io hosts and company pages that carry a Greenhouse job id. */
function isGreenhouseUrl(url) {
    return isGreenhouseIoHost(url) || !!parseGreenhouseBoardAndJob(url);
}

module.exports = {
    parseGreenhouseBoardAndJob,
    greenhouseJobsPageUrl,
    canonicalizeGreenhouseApplyUrl,
    greenhouseScrapeUrl,
    isGreenhouseUrl,
    isGreenhouseIoHost,
    normalizeGreenhouseJobId,
    inferGreenhouseBoardFromHost
};
