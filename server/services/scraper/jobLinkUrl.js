/**
 * Shared job-link URL normalize / identity helpers.
 *
 * JobRight and aggregators append tracking (?utm_source=jobright&jr_id=…)
 * and Lever often has both …/uuid and …/uuid/apply. Those must collapse
 * to one stored row and one displayed link.
 */
'use strict';

const {
    parseGreenhouseBoardAndJob,
    canonicalizeGreenhouseApplyUrl,
    isGreenhouseUrl,
    isGreenhouseIoHost
} = require('./greenhouseUrl');
const {
    leverPostingUrl,
    canonicalizeLeverApplyUrl,
    isLeverUrl
} = require('./leverUrl');

/** Query keys that never identify a posting — strip on save. */
const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|gclsrc$|dclid$|msclkid$|li_fat_id$|mc_cid$|mc_eid$|jr_id$|spm$|trk$|trackingid$|ref$|referrer$|igshid$|si$|feature$|ved$|ei$)/i;

/** Greenhouse (and similar) query keys that *do* identify the job. */
const KEEP_QUERY_KEYS = new Set([
    'for', 'token', 'gh_jid', 'board', 'job_id', 'jobid'
]);

function extractLinkedInJobId(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/linkedin\.com\/jobs\/view\/(\d+)/i)
        || url.match(/[?&]currentJobId=(\d+)/i);
    return m ? m[1] : null;
}

/**
 * Strip tracking/hash noise. Preserve ATS-significant query params
 * (Greenhouse for/token, etc.).
 */
function stripTrackingParams(url) {
    const raw = String(url || '').trim();
    if (!raw) return null;
    try {
        const u = new URL(raw);
        u.hash = '';
        const keep = new URLSearchParams();
        for (const [k, v] of u.searchParams.entries()) {
            if (KEEP_QUERY_KEYS.has(k.toLowerCase())) {
                keep.append(k, v);
                continue;
            }
            if (TRACKING_PARAM_RE.test(k)) continue;
            // Drop unknown marketing-ish keys; keep anything else that
            // might be required by an ATS path we don't special-case.
            if (/^(utm_|fbclid|gclid|jr_id)/i.test(k)) continue;
            keep.append(k, v);
        }
        u.search = keep.toString() ? `?${keep.toString()}` : '';
        // Trim trailing slash on non-root paths (…/uuid/ vs …/uuid).
        if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
            u.pathname = u.pathname.replace(/\/+$/, '');
        }
        return u.toString();
    } catch (_) {
        return raw;
    }
}

function normalizeUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    return stripTrackingParams(trimmed) || trimmed;
}

function ashbyPostingKey(url) {
    const m = String(url || '').match(
        /ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{8,})/i
    );
    if (!m) return null;
    return `ashby://${m[1].toLowerCase()}/${m[2].toLowerCase()}`;
}

/**
 * Identity key for dedupe. Two URLs with the same key are the same job.
 */
function canonicalJobLinkUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const linkedInId = extractLinkedInJobId(url);
    if (linkedInId) {
        return `https://www.linkedin.com/jobs/view/${linkedInId}`;
    }
    try {
        const gh = parseGreenhouseBoardAndJob(url);
        if (gh) {
            return `greenhouse://${gh.board.toLowerCase()}/jobs/${gh.jobId}`;
        }
    } catch (_) { /* ignore */ }
    try {
        if (isLeverUrl(url)) {
            const posting = leverPostingUrl(url);
            if (posting) {
                const u = new URL(posting);
                return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}`;
            }
        }
    } catch (_) { /* ignore */ }
    const ashby = ashbyPostingKey(url);
    if (ashby) return ashby;
    try {
        const u = new URL(String(url).trim());
        let path = u.pathname || '';
        // Common apply suffixes that don't change posting identity.
        path = path.replace(/\/(apply|application|job)\/?$/i, '');
        if (path.length > 1 && path.endsWith('/')) {
            path = path.replace(/\/+$/, '');
        }
        return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
    } catch (_) {
        return String(url).trim();
    }
}

function urlsReferToSameJob(a, b) {
    const ca = canonicalJobLinkUrl(a);
    const cb = canonicalJobLinkUrl(b);
    if (ca && cb && ca === cb) return true;
    const na = normalizeUrl(a);
    const nb = normalizeUrl(b);
    if (na && nb && na === nb) return true;
    return false;
}

/**
 * Clean apply URL for storage (form URL when we know the ATS).
 * Strips JobRight tracking; Lever → …/uuid/apply; Greenhouse → embed.
 */
function canonicalizeStoredApplyUrl(url) {
    const cleaned = normalizeUrl(url);
    if (!cleaned) return null;
    try {
        if (isGreenhouseUrl(cleaned)) {
            return canonicalizeGreenhouseApplyUrl(cleaned) || cleaned;
        }
        if (isLeverUrl(cleaned)) {
            return canonicalizeLeverApplyUrl(cleaned) || cleaned;
        }
    } catch (_) { /* ignore */ }
    return cleaned;
}

/**
 * Decide what to persist for source_url + job_apply_url.
 * Drops a redundant source when it is the same posting as apply
 * (e.g. Lever posting + Lever apply?utm_source=jobright).
 */
function resolveStoredJobUrls(sourceRaw, applyRaw) {
    const rawGh = parseGreenhouseBoardAndJob(sourceRaw)
        || parseGreenhouseBoardAndJob(applyRaw);
    const apply = canonicalizeStoredApplyUrl(applyRaw || sourceRaw);
    let source = normalizeUrl(sourceRaw);
    if (!apply && !source) {
        return { source: null, apply: null };
    }
    // Lever /apply is the form only. Keep source as the posting page
    // (no /apply) so scrape hits jobs.eu.lever.co/…/uuid, not the form.
    const leverHint = apply || source;
    if (isLeverUrl(leverHint)) {
        const posting = leverPostingUrl(leverHint);
        return {
            source: posting || source || null,
            apply: apply || (posting ? `${posting}/apply` : null)
        };
    }
    if (rawGh && rawGh.shape === 'company_gh_jid') {
        // Keep the company career page as source (what the user pasted)
        // and store the Greenhouse embed as the apply/form URL.
        return {
            source: source || normalizeUrl(applyRaw) || null,
            apply: canonicalizeGreenhouseApplyUrl(sourceRaw || applyRaw) || apply
        };
    }
    if (!apply) {
        return { source: source || null, apply: null };
    }
    if (source && urlsReferToSameJob(source, apply)) {
        // Drop redundant greenhouse.io variants (classic vs embed).
        // Do not drop a company career page that only shares a gh_jid.
        if (isGreenhouseIoHost(source) || !rawGh) {
            source = null;
        }
    }
    return { source, apply };
}

module.exports = {
    extractLinkedInJobId,
    stripTrackingParams,
    normalizeUrl,
    canonicalJobLinkUrl,
    urlsReferToSameJob,
    canonicalizeStoredApplyUrl,
    resolveStoredJobUrls
};
