/**
 * URL-first ATS detection for Auto Bidder routing (background service worker).
 * Page DOM can false-positive as Greenhouse (#application_form); job URL wins.
 */

export function detectAtsFromUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return { id: 'generic', label: 'Generic / custom ATS' };
    if (/greenhouse\.io/i.test(u) || /[?&]gh_jid=/i.test(u)) {
        return { id: 'greenhouse', label: 'Greenhouse' };
    }
    if (/oraclecloud\.com|\.oracle\.com\/hcm|fa\.[a-z0-9]+\.oraclecloud/i.test(u)) {
        return { id: 'oracle', label: 'Oracle Cloud HCM' };
    }
    if (/myworkdayjobs\.com|workdayjobs\.com|\/workday/i.test(u)) return { id: 'workday', label: 'Workday' };
    if (/lever\.co/i.test(u)) return { id: 'lever', label: 'Lever' };
    if (/ashbyhq\.com/i.test(u)) return { id: 'ashby', label: 'Ashby' };
    if (/jobs\.gem\.com/i.test(u)) return { id: 'gem', label: 'Gem' };
    if (/linkedin\.com/i.test(u)) return { id: 'linkedin', label: 'LinkedIn' };
    if (/icims\.com/i.test(u)) return { id: 'icims', label: 'iCIMS' };
    if (/smartrecruiters\.com/i.test(u)) return { id: 'smartrecruiters', label: 'SmartRecruiters' };
    if (/bamboohr\.com/i.test(u)) return { id: 'bamboohr', label: 'BambooHR' };
    if (/rippling\.com/i.test(u)) return { id: 'rippling', label: 'Rippling' };
    return { id: 'generic', label: 'Generic / custom ATS' };
}

/** Ashby JD posting URL (board + uuid) that is not already /application. */
export function isAshbyJobDescriptionUrl(url) {
    const u = String(url || '');
    if (!/ashbyhq\.com/i.test(u)) return false;
    if (/\/application\/?($|\?|#)/i.test(u)) return false;
    return /ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{8,}/i.test(u);
}

/** Map Ashby JD URL → application form URL. */
export function ashbyApplicationUrl(url) {
    try {
        const u = new URL(url);
        if (/\/application\/?$/i.test(u.pathname)) return u.toString();
        u.pathname = `${u.pathname.replace(/\/$/, '')}/application`;
        return u.toString();
    } catch {
        return `${String(url || '').replace(/\/?([?#].*)?$/, '')}/application`;
    }
}

export function isGreenhouseUrl(url) {
    const u = String(url || '');
    return /greenhouse\.io/i.test(u) || /[?&]gh_jid=/i.test(u);
}

/**
 * Pick ATS for bidder fill routing. Job/tab URL beats page DOM hints.
 */
export function resolveBidderAts({ applyUrl, tabUrl, formAts }) {
    const fromApply = detectAtsFromUrl(applyUrl);
    const fromTab = tabUrl ? detectAtsFromUrl(tabUrl) : fromApply;

    const urlKnown = (id) => id && id !== 'generic' && id !== 'other';

    if (fromTab.id === 'linkedin' || fromApply.id === 'linkedin' || formAts === 'linkedin') {
        return 'linkedin';
    }

    if (isGreenhouseUrl(tabUrl) || isGreenhouseUrl(applyUrl)) {
        return 'greenhouse';
    }

    if (urlKnown(fromTab.id)) return fromTab.id;
    if (urlKnown(fromApply.id)) return fromApply.id;

    // DOM-only "greenhouse" on non-Greenhouse hosts is a common false positive (#application_form).
    if (formAts === 'greenhouse') return 'generic';

    return formAts || fromTab.id || fromApply.id || 'generic';
}
