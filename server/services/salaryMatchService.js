/**
 * Pick an expected-salary value from the JD range (and optional profile range).
 * Used by application answer drafting and mirrored in the Chrome fill script.
 */

const MONEY_TOKEN =
    /(?:\$|USD|CAD|EUR|GBP|£|€)?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|K|m|M)?/g;

function toAnnualNumber(raw, suffix, nearbyText = '') {
    let n = parseFloat(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    const suf = (suffix || '').toLowerCase();
    if (suf === 'k') n *= 1000;
    if (suf === 'm') n *= 1000000;
    const ctx = String(nearbyText || '').toLowerCase();
    // Hourly → rough annual (2080 hrs). Only if clearly hourly and small.
    if (/\b(per\s*hour|\/\s*hr|\/\s*hour|hourly)\b/.test(ctx) && n < 500) {
        n = Math.round(n * 2080);
    }
    // Treat bare small numbers near "k" context already handled; 50–500 often means thousands in salary copy.
    if (!suf && n >= 40 && n <= 500 && /\b(salary|compensation|base|pay|ctc|range|usd|\$)\b/i.test(ctx)) {
        n *= 1000;
    }
    return Math.round(n);
}

function extractMoneyAmounts(text) {
    const src = String(text || '');
    const amounts = [];
    MONEY_TOKEN.lastIndex = 0;
    let m;
    while ((m = MONEY_TOKEN.exec(src)) !== null) {
        const start = Math.max(0, m.index - 40);
        const end = Math.min(src.length, m.index + m[0].length + 40);
        const nearby = src.slice(start, end);
        const n = toAnnualNumber(m[1], m[2], nearby);
        if (n && n >= 15000 && n <= 2000000) {
            amounts.push({ value: n, index: m.index });
        }
    }
    return amounts;
}

function parseRangeFromText(text) {
    const src = String(text || '');
    if (!src.trim()) return null;

    // Prefer explicit "A - B" / "A to B" patterns near salary wording.
    const rangeRes = [
        /(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?\s*(?:-|–|—|to|and)\s*(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?/gi,
        /between\s+(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?\s+and\s+(?:\$|USD)?\s*([\d,.]+)\s*(k|K)?/gi
    ];

    const candidates = [];
    for (const re of rangeRes) {
        let m;
        while ((m = re.exec(src)) !== null) {
            const nearby = src.slice(Math.max(0, m.index - 60), Math.min(src.length, m.index + m[0].length + 60));
            const a = toAnnualNumber(m[1], m[2], nearby);
            const b = toAnnualNumber(m[3], m[4], nearby);
            if (a && b) {
                const lo = Math.min(a, b);
                const hi = Math.max(a, b);
                if (hi > lo && hi / lo < 8) {
                    candidates.push({ min: lo, max: hi, score: /salary|compensation|pay|ctc|base|range/i.test(nearby) ? 2 : 1 });
                }
            }
        }
    }

    if (candidates.length) {
        candidates.sort((x, y) => y.score - x.score || (y.max - y.min) - (x.max - x.min));
        return { min: candidates[0].min, max: candidates[0].max };
    }

    // Fallback: two money amounts close together in a salary-ish paragraph.
    const amounts = extractMoneyAmounts(src);
    for (let i = 0; i < amounts.length - 1; i++) {
        const a = amounts[i];
        const b = amounts[i + 1];
        if (Math.abs(b.index - a.index) > 80) continue;
        const lo = Math.min(a.value, b.value);
        const hi = Math.max(a.value, b.value);
        if (hi > lo && hi / lo < 5) {
            return { min: lo, max: hi };
        }
    }

    if (amounts.length === 1) {
        const v = amounts[0].value;
        return { min: v, max: v };
    }

    return null;
}

function formatSalary(n, { currency = 'USD', style = 'usd' } = {}) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 15000) return '';
    const rounded = Math.round(num / 1000) * 1000;
    if (style === 'number') return String(rounded);
    if (style === 'k') return `${Math.round(rounded / 1000)}k`;
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency,
            maximumFractionDigits: 0
        }).format(rounded);
    } catch {
        return `$${rounded.toLocaleString('en-US')}`;
    }
}

/**
 * When the JD has no $ range, infer a band from role / seniority / location
 * so compensation is job-aware instead of always the same profile number.
 */
function inferJobSalaryBand({ jobDescription = '', jobRole = '', companyName = '' } = {}) {
    const hay = `${jobRole || ''} ${companyName || ''} ${String(jobDescription || '').slice(0, 4000)}`.toLowerCase();
    let mid = 145000;
    if (/\b(intern|internship|co[\s-]?op)\b/.test(hay)) mid = 75000;
    else if (/\b(junior|entry[\s-]?level|associate|new grad|graduate)\b/.test(hay)) mid = 105000;
    else if (/\b(distinguished|fellow|vp\b|vice president|head of)\b/.test(hay)) mid = 240000;
    else if (/\b(principal|staff)\b/.test(hay)) mid = 215000;
    else if (/\b(senior|sr\.?|lead)\b/.test(hay)) mid = 175000;
    else if (/\b(manager|director)\b/.test(hay)) mid = 190000;
    else if (/\b(mid[\s-]?level|ii\b|2\b)\b/.test(hay)) mid = 140000;

    if (/\b(machine learning|ml engineer|ai engineer|security|cryptograph|platform|sre|devops|infrastructure|data engineer)\b/.test(hay)) {
        mid = Math.round(mid * 1.08);
    }
    if (/\b(frontend|react|ui engineer|support|qa|quality assurance|manual test)\b/.test(hay)) {
        mid = Math.round(mid * 0.95);
    }
    if (/\b(san francisco|bay area|nyc|new york city|seattle|redmond|cupertino|palo alto|mountain view)\b/.test(hay)) {
        mid = Math.round(mid * 1.1);
    } else if (/\b(remote|anywhere|midwest|texas|florida|ohio|georgia|north carolina)\b/.test(hay)) {
        mid = Math.round(mid * 0.94);
    }

    mid = Math.max(70000, Math.min(350000, mid));
    // Light job-hash jitter so two different postings with no range don't always get the identical figure.
    let hash = 0;
    const key = `${jobRole}|${companyName}|${String(jobDescription || '').slice(0, 240)}`;
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    const jitter = ((Math.abs(hash) % 11) - 5) * 1000; // -5k … +5k
    mid = Math.max(70000, mid + jitter);
    const spread = Math.round(mid * 0.1);
    return { min: mid - spread, max: mid + spread };
}

/**
 * Choose a salary that matches the job when possible.
 * Always prefers JD range; if none, uses a job-inferred band (optionally blended with profile).
 * Still always returns a fillable value when any signal exists.
 * @returns {{ value: number, formatted: string, jdRange: object|null, profileRange: object|null, source: string }|null}
 */
function pickSalaryExpectation({
    jobDescription,
    profileSalaryRange,
    fieldLabel = '',
    jobRole = '',
    companyName = ''
} = {}) {
    const jdRange = parseRangeFromText(jobDescription);
    const profileRange = parseRangeFromText(profileSalaryRange);
    const jobBand = (!jdRange)
        ? inferJobSalaryBand({ jobDescription, jobRole, companyName })
        : null;

    let min;
    let max;
    let source;

    if (jdRange && profileRange) {
        const lo = Math.max(jdRange.min, profileRange.min);
        const hi = Math.min(jdRange.max, profileRange.max);
        if (lo <= hi) {
            min = lo;
            max = hi;
            source = 'jd_profile_overlap';
        } else {
            // Profile outside JD band — stay inside JD at mid-low, never JD max.
            min = jdRange.min;
            max = jdRange.max;
            source = 'jd_mid_low';
        }
    } else if (jdRange) {
        min = jdRange.min;
        max = jdRange.max;
        source = 'jd_only';
    } else if (jobBand && profileRange) {
        // No JD $ — blend job-inferred band with profile so value tracks the posting, not a fixed profile-only number.
        const lo = Math.min(jobBand.min, profileRange.min);
        const hi = Math.max(jobBand.max, profileRange.max);
        // Prefer the job band center; clamp toward profile if wildly off.
        min = jobBand.min;
        max = jobBand.max;
        const jobMid = (jobBand.min + jobBand.max) / 2;
        const profMid = (profileRange.min + profileRange.max) / 2;
        if (Math.abs(jobMid - profMid) > 80000) {
            min = Math.round((jobBand.min + profileRange.min) / 2);
            max = Math.round((jobBand.max + profileRange.max) / 2);
        }
        if (lo > 0 && hi > lo) {
            /* keep job-first band */
        }
        source = 'job_inferred_blend';
    } else if (jobBand) {
        min = jobBand.min;
        max = jobBand.max;
        source = 'job_inferred';
    } else if (profileRange) {
        min = profileRange.min;
        max = profileRange.max;
        source = 'profile_only';
    } else if (profileSalaryRange && String(profileSalaryRange).trim()) {
        // Unparseable profile string — use as-is for free-text fields.
        return {
            value: null,
            formatted: String(profileSalaryRange).trim(),
            jdRange: null,
            profileRange: null,
            source: 'profile_raw'
        };
    } else {
        // Last resort — still fill so required fields are not blank.
        min = 120000;
        max = 160000;
        source = 'default_mid';
    }

    // Mid-low of band (~35%) — competitive but not anchoring the top of the posting.
    const value = Math.round(min + (max - min) * 0.35);
    if (!Number.isFinite(value) || value < 15000) return null;
    const label = String(fieldLabel || '').toLowerCase();
    let style = 'usd';
    if (/\b(k|thousand)\b/.test(label)) style = 'k';
    if (/\b(amount|number|usd\s*only|numeric)\b/.test(label)) style = 'number';

    const formatted = formatSalary(value, { style });
    if (!formatted || /^\$?0+$/.test(String(formatted).replace(/[,\s]/g, ''))) return null;

    return {
        value,
        formatted,
        jdRange,
        profileRange,
        jobBand,
        source
    };
}

/**
 * Given <select> option texts/values, pick the best matching option for a chosen salary.
 */
function matchSalaryOption(options, pick) {
    if (!pick || !Array.isArray(options) || !options.length) return null;
    const target = pick.value;
    let best = null;
    let bestScore = -Infinity;

    for (const opt of options) {
        const text = String(opt.text || opt.label || opt.value || '');
        const range = parseRangeFromText(text) || parseRangeFromText(String(opt.value || ''));
        let score = -1000;
        if (range && target != null) {
            if (target >= range.min && target <= range.max) {
                score = 1000 - Math.abs(((range.min + range.max) / 2) - target);
            } else {
                score = -Math.min(Math.abs(target - range.min), Math.abs(target - range.max));
            }
        } else if (target != null) {
            const amounts = extractMoneyAmounts(text);
            if (amounts.length) {
                const v = amounts[0].value;
                score = -Math.abs(v - target);
            }
        }
        if (score > bestScore) {
            bestScore = score;
            best = opt;
        }
    }

    return bestScore > -500 ? best : null;
}

module.exports = {
    parseRangeFromText,
    pickSalaryExpectation,
    matchSalaryOption,
    formatSalary,
    extractMoneyAmounts,
    inferJobSalaryBand
};
