/**
 * Auto Bidder eligibility rules — **per candidate profile only**.
 * Another profile (or another user on a different profile) may still bid
 * the same company / job. Never keyed by user_id.
 *
 * 1. Never bid a different main stack at a company this profile already applied to.
 * 2. Never re-bid the same job (same title + same JD) for this profile at that company.
 * 3. Different JD + same stack at same company is allowed — but only outside the cooldown.
 * 4. Within COMPANY_COOLDOWN_DAYS of any applied bid by this profile at that company → block.
 *
 * Prompt analysis / industry note: a hard N-day company ban conflicts with
 * “apply 2–3 related roles in a short window.” We enforce both as layered
 * gates; change COMPANY_COOLDOWN_DAYS to 0 to allow same-day multi-role bids.
 */

'use strict';

const COMPANY_COOLDOWN_DAYS = 3;
const COMPANY_COOLDOWN_MS = COMPANY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function normalizeCompany(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|tech)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeTitle(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[|/·•—–-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Strip HTML / collapse whitespace so scrape noise does not fake a “new” JD. */
function normalizeJd(jd) {
    return String(jd || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveStack(row = {}) {
    const raw = row.techstack
        || row.link_techstack
        || row.job_techstack
        || row.core_skills
        || '';
    const s = String(raw).toLowerCase().trim();
    if (!s) return '';
    // core_skills on auto-apply rows is the job_links.techstack enum.
    if (/^(python|java|dotnet|golang|nodejs|frontend)$/i.test(s)) return s;
    // If free-form skills were stored, take first token-ish stack label.
    const m = s.match(/\b(python|java|dotnet|golang|nodejs|frontend|react|node)\b/i);
    if (!m) return s.slice(0, 32);
    const t = m[1].toLowerCase();
    if (t === 'react') return 'frontend';
    if (t === 'node') return 'nodejs';
    return t;
}

function priorAppliedAt(prev) {
    const raw = prev.applied_at || prev.updated_at || prev.created_at || null;
    if (raw == null) return NaN;
    if (typeof raw === 'number') return raw;
    const s = String(raw).trim();
    // SQLite CURRENT_TIMESTAMP often "YYYY-MM-DD HH:MM:SS" (UTC-ish).
    const ms = Date.parse(/T/.test(s) ? s : s.replace(' ', 'T') + ( /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? '' : 'Z'));
    return Number.isFinite(ms) ? ms : NaN;
}

function sameCompany(a, b) {
    const ca = normalizeCompany(a.company_name || a.company);
    const cb = normalizeCompany(b.company_name || b.company);
    return !!ca && ca === cb;
}

/**
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function evaluateBidEligibility(candidate, priorApplied = [], { now = Date.now() } = {}) {
    const company = normalizeCompany(candidate.company_name);
    if (!company) return { ok: true };

    const candStack = resolveStack(candidate);
    const candTitle = normalizeTitle(candidate.job_role || candidate.position_title);
    const candJd = normalizeJd(candidate.job_description);
    const candId = Number(candidate.id || 0);

    const companyPriors = (Array.isArray(priorApplied) ? priorApplied : [])
        .filter((p) => Number(p.id || 0) !== candId && sameCompany(candidate, p));

    if (!companyPriors.length) return { ok: true };

    // (2) Identical title + JD at this company — never.
    if (candTitle && candJd) {
        const dup = companyPriors.find((p) => (
            normalizeTitle(p.job_role || p.position_title) === candTitle
            && normalizeJd(p.job_description) === candJd
        ));
        if (dup) {
            return {
                ok: false,
                code: 'same_job',
                message: 'Already applied to the same title + JD at this company'
            };
        }
    }

    // (1) Different main stack at this company — never.
    if (candStack) {
        const clash = companyPriors.find((p) => {
            const prevStack = resolveStack(p);
            return prevStack && prevStack !== candStack;
        });
        if (clash) {
            return {
                ok: false,
                code: 'different_stack',
                message: `Already applied at this company with stack "${resolveStack(clash)}" (not "${candStack}")`
            };
        }
    }

    // (4) Any applied bid at this company within cooldown — block
    // (including same-stack / different-JD which rule 3 would otherwise allow).
    const recent = companyPriors.find((p) => {
        const at = priorAppliedAt(p);
        return Number.isFinite(at) && (now - at) < COMPANY_COOLDOWN_MS;
    });
    if (recent) {
        const at = priorAppliedAt(recent);
        const hoursLeft = Math.max(1, Math.ceil((COMPANY_COOLDOWN_MS - (now - at)) / 3600000));
        return {
            ok: false,
            code: 'company_cooldown',
            message: `Same company within ${COMPANY_COOLDOWN_DAYS} days (wait ~${hoursLeft}h)`
        };
    }

    // (3) Same stack + different JD + outside cooldown → allowed.
    return { ok: true };
}

/**
 * Filter ready-queue rows. `priorsByProfileId` maps profile_id → applied rows
 * (with company_name, job_role, job_description, core_skills/techstack, timestamps).
 */
function filterEligibleReadyApps(candidates, priorsByProfileId, opts = {}) {
    const out = [];
    const skipped = [];
    for (const row of candidates || []) {
        const priors = priorsByProfileId.get(Number(row.profile_id)) || [];
        const verdict = evaluateBidEligibility(row, priors, opts);
        if (verdict.ok) out.push(row);
        else skipped.push({ id: row.id, company_name: row.company_name, ...verdict });
    }
    return { items: out, skipped };
}

module.exports = {
    COMPANY_COOLDOWN_DAYS,
    COMPANY_COOLDOWN_MS,
    normalizeCompany,
    normalizeTitle,
    normalizeJd,
    resolveStack,
    sameCompany,
    priorAppliedAt,
    evaluateBidEligibility,
    filterEligibleReadyApps
};
