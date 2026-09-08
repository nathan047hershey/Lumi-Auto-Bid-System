/**
 * Lever URL helpers for JD scrape vs apply-form open.
 *
 * Supported shapes:
 *   jobs.lever.co/<company>/<uuid>
 *   jobs.lever.co/<company>/<uuid>/apply
 *   jobs.lever.co/<company>/<uuid>/apply?...   (JobRight, utm_*)
 *
 * Apply pages are mostly the form (no `.posting-description`).
 * Strip trailing `/apply` (+ query/hash) to hit the posting JD page.
 */
'use strict';

function isLeverUrl(url) {
    return /(?:^|\/\/)(?:[^/]*\.)?lever\.co\b/i.test(String(url || ''));
}

function parseLeverCompanyAndId(url) {
    const raw = String(url || '').trim();
    if (!raw || !isLeverUrl(raw)) return null;

    try {
        const u = new URL(raw);
        const segs = u.pathname.split('/').filter(Boolean);
        // jobs.lever.co/<company>/<uuid>[/apply[/...]]
        if (segs.length < 2) return null;
        const company = segs[0];
        const postingId = segs[1];
        if (!company || !/^[0-9a-f-]{36,}$/i.test(postingId)) return null;
        const isApply = segs.some((s) => /^apply$/i.test(s));
        return { company, postingId, isApply, host: u.host };
    } catch (_) {
        const m = raw.match(/lever\.co\/([^/?#]+)\/([0-9a-f-]{36,})/i);
        if (!m) return null;
        return {
            company: m[1],
            postingId: m[2],
            isApply: /\/apply(?:[/?#]|$)/i.test(raw),
            host: 'jobs.lever.co'
        };
    }
}

/**
 * Posting / JD page URL — strip trailing `/apply` and tracking query.
 * Returns null if not a Lever posting URL.
 */
function leverPostingUrl(url) {
    const p = parseLeverCompanyAndId(url);
    if (!p) return null;
    const host = p.host || 'jobs.lever.co';
    return `https://${host}/${p.company}/${p.postingId}`;
}

/** Prefer posting URL for HTML / structured scrape; fall back to original. */
function leverScrapeUrl(url) {
    return leverPostingUrl(url) || url;
}

/**
 * Canonical apply URL (posting + /apply). Keeps bidder on the form.
 */
function canonicalizeLeverApplyUrl(url) {
    const posting = leverPostingUrl(url);
    if (!posting) return url || null;
    return `${posting}/apply`;
}

module.exports = {
    isLeverUrl,
    parseLeverCompanyAndId,
    leverPostingUrl,
    leverScrapeUrl,
    canonicalizeLeverApplyUrl
};
