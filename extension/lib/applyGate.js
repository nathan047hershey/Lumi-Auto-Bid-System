/**
 * Apply-gate helpers — click Apply on JD pages, optional account create,
 * and host-level lessons learned from successful bids.
 */
'use strict';

/** Labels that mean “start the application”, not withdraw/share. */
export function isApplyButtonLabel(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 72) return false;
    if (/withdraw|cancel|delete|unsubscribe|share|save\s*job|sign\s*in|log\s*in|decline|accept\s*cookie|already\s*applied/i.test(t)) {
        return false;
    }
    if (/^(apply|apply\s*now|apply\s*online|apply\s*for\s*this\s*job(?:\s*online)?|apply\s*for\s*this\s*position|apply\s*for\s*this\s*role|start\s*application|begin\s*application|continue\s*application|submit\s*application)$/i.test(t)) {
        return true;
    }
    // Greenhouse / Lever / Ashby variants: "Apply for this job online"
    if (/^apply\b/i.test(t) && t.length <= 48) return true;
    if (/\bapply\s+for\s+this\s+job\b/i.test(t) && t.length <= 56) return true;
    if (/\bapply\s+online\b/i.test(t) && t.length <= 40) return true;
    return false;
}

export function scoreApplyLabel(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!isApplyButtonLabel(t)) return 0;
    let score = 10;
    if (/apply for this job online/.test(t)) score += 20;
    else if (/apply for this job/.test(t)) score += 16;
    else if (/apply now|apply online/.test(t)) score += 12;
    else if (/^apply$/.test(t)) score += 8;
    if (/start application|begin application/.test(t)) score += 10;
    return score;
}

/** Detect create-account / register wall copy (not a filled apply form). */
export function looksLikeCreateAccountPage(text) {
    const t = String(text || '').toLowerCase().slice(0, 8000);
    if (!t) return false;
    if (/\b(create\s+(an?\s+)?account|sign\s*up|register\s+(to\s+)?apply|new\s+user|set\s+a\s+password|confirm\s+password)\b/.test(t)) {
        // Prefer true when password fields are implied by copy
        return true;
    }
    return false;
}

export function generateAtsPassword(host = '') {
    const base = String(host || 'lumi').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'lumi';
    const rand = Math.random().toString(36).slice(2, 8);
    // Meet common ATS rules: upper, lower, digit, symbol
    return `Lm$${base.slice(0, 4)}${rand}9A!`;
}

/**
 * Merge a successful Apply lesson for a host (selector / label).
 * Pure — storage write happens in background.
 */
export function upsertApplyLesson(lessons, { host, label, selector, href, outcome = 'form_ok' }) {
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    if (!h) return Array.isArray(lessons) ? lessons : [];
    const list = Array.isArray(lessons) ? [...lessons] : [];
    const key = `${h}|${String(selector || '').slice(0, 120)}|${String(label || '').slice(0, 64)}`;
    const idx = list.findIndex((x) => `${x.host}|${x.selector || ''}|${x.label || ''}` === key
        || (x.host === h && x.label && label && String(x.label).toLowerCase() === String(label).toLowerCase()));
    const row = {
        host: h,
        label: String(label || '').slice(0, 80),
        selector: String(selector || '').slice(0, 200),
        href: String(href || '').slice(0, 300),
        outcome: String(outcome || 'form_ok').slice(0, 40),
        hits: (idx >= 0 ? Number(list[idx].hits) || 0 : 0) + 1,
        updatedAt: Date.now()
    };
    if (idx >= 0) list[idx] = { ...list[idx], ...row };
    else list.push(row);
    // Cap per host
    const byHost = list.filter((x) => x.host === h).sort((a, b) => (b.hits || 0) - (a.hits || 0));
    const others = list.filter((x) => x.host !== h);
    return [...others, ...byHost.slice(0, 12)].slice(-200);
}

export function lessonsForHost(lessons, host) {
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    return (Array.isArray(lessons) ? lessons : [])
        .filter((x) => x.host === h)
        .sort((a, b) => (b.hits || 0) - (a.hits || 0));
}
