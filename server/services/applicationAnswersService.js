/**
 * Draft application-form answers from a job description + generated CV.
 * Used by the Chrome extension autofill (Mode 1) and Mode 2 prepare step.
 */
const axios = require('axios');
const { getAnswersProviderConfig, getAlternateMinimaxConfig, isMinimaxUnavailableError, promoteMinimaxSlot, getAlternateGroqConfig, isGroqQuotaError, isGroqAuthError, promoteGroqSlot, getAnswersGroqRescueConfig, getProviderConfig } = require('./settingsService');
const { pickSalaryExpectation } = require('./salaryMatchService');
const { getAll } = require('../config/database');
const questionMemory = require('./questionMemoryService');

const SALARY_RE = /\b(salary|compensation|pay|ctc|base\s*pay|expected\s*comp|wage|remuneration)\b/i;

/** Yes/No "ok with the posted salary?" — NOT a numeric salary expectation field. */
function isSalaryComfortYesNo(hay) {
    const h = String(hay || '');
    if (!/\b(salary|compensation|pay|wage|remuneration)\b/i.test(h)) return false;
    return (
        /\bcomfortable\b/i.test(h)
        || /\boutlined\b/i.test(h)
        || (/\b(agree|accept|okay with|ok with)\b/i.test(h)
            && /\b(range|posted|listed|job description|\bjd\b)\b/i.test(h))
        || (/\bwilling\b/i.test(h) && /\binterview/i.test(h))
    );
}

function optionsAreYesNoOnly(options) {
    if (!Array.isArray(options) || options.length < 2) return false;
    const labels = options
        .map((o) => String(typeof o === 'string' ? o : (o?.label || o?.value || '')).trim())
        .filter(Boolean);
    if (labels.length < 2) return false;
    const yn = labels.filter((t) => /^(yes|no)\b/i.test(t));
    return yn.length >= 2 && yn.length === labels.length;
}

const FIXED_FIELD_RE = {
    gender: /\b(gender|sex)\b/i,
    work_authorization: /\b(work[\s_-]*auth|authoriz(ed|ation)|legally[\s_-]*authorized|eligible[\s_-]*to[\s_-]*work|right[\s_-]*to[\s_-]*work|where this job is located|job is located|this role is located|working from this state|consistently be working|able to work remotely|work remotely|free from distractions)\b/i,
    requires_sponsorship: /\b(sponsor|sponsorship|visa[\s_-]*support|require.*visa|need.*visa|employment[\s_-]*visa|h-?1b|visa[\s_-]*status|will you.{0,60}require.{0,40}(sponsor|visa))\b/i,
    disability_status: /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i,
    veteran_status: /\b(veteran|military[\s_-]*status|armed[\s_-]*forces)\b/i,
    race_ethnicity: /\b(race|ethnicity|ethnic)\b/i,
    birthdate: /\b(birth[\s_-]*date|date[\s_-]*of[\s_-]*birth|\bdob\b)\b/i,
    todays_date: /^(date|date\s*\*?)$|\b(today'?s?\s*date|signature\s*date|date\s*signed|application\s*date)\b/i,
    hispanic_latino: /\b(hispanic|latino|latina|latinx)\b/i,
    website_url: /\b(website|personal[\s_-]*site|homepage)\b/i,
    portfolio_url: /\b(portfolio|behance|dribbble)\b/i,
    preferred_name: /\b(preferred[\s_-]*name|nickname|goes[\s_-]*by)\b/i,
    over_18: /\b(18[\s_-]*or[\s_-]*older|over[\s_-]*18|at[\s_-]*least[\s_-]*18)\b/i,
    willing_to_relocate: /\b(relocat\w*|willing[\s_-]*to[\s_-]*move)\b/i,
    willing_to_travel: /\b(willing[\s_-]*to[\s_-]*travel|percent[\s_-]*travel|\btravel\b)/i,
    earliest_start_date: /\b(start[\s_-]*date|earliest[\s_-]*start|available[\s_-]*to[\s_-]*start|when[\s_-]*can[\s_-]*you[\s_-]*start)\b/i,
    notice_period: /\b(notice[\s_-]*period|notice[\s_-]*time)\b/i,
    how_heard: /\b(how[\s_-]*did[\s_-]*you[\s_-]*(hear|find)|hear[\s_-]*about|find[\s_-]*this[\s_-]*(position|role|job)|referral[\s_-]*source)\b/i,
    years_of_experience: /\b((total\s+)?years?[\s_-]*of[\s_-]*experience|total[\s_-]*experience)\b/i,
    education_level: /\b(highest[\s_-]*(degree|education)|education[\s_-]*level|degree[\s_-]*level)\b/i,
    school: /\b(school|university|college|institution)\b/i,
    degree: /\b(^|\b)degree\b/i,
    discipline: /\b(discipline|major|field[\s_-]*of[\s_-]*study|concentration)\b/i,
    security_clearance: /\b(security[\s_-]*clearance|clearance[\s_-]*level)\b/i,
    // Location selects — never send to LLM (profile city/state only)
    city: /\b(where (?:are|do) you (?:located|currently reside|live)|where are you located|current[\s_-]*location|where do you currently reside)\b/i,
    state: /\b(^|\b)(state|province)\b(?![\s_-]*while)/i,
    current_company: /\b(current[\s_-]*company|current[\s_-]*employer|present[\s_-]*employer|^company$)\b/i
};

/** Fixed answers that never go to the LLM (not profile columns). */
const FIXED_CONSTANT_RE = {
    // Company / employer / related company-or-role → always No (checked before skill Yes).
    previous_employer_no:
        /\b(are you a former\b|former\b.{0,48}\bemployee|employed by\b|ever been employed|have (?:you )?ever been employed|been employed by\b|worked\s+(?:before\s+)?(?:at|for|with)\s+(us|this|our|the\s+company|here)|ever\s+worked\s+(?:before\s+)?(?:at|for|with)\s+(us|this|our|here)|previously\s+worked\s+(at|for|here|with\s+(us|this|our)|before)|have you (?:ever )?worked\s+(?:before\s+)?(?:(?:at|for|with)\s+)?(?:this|our|the)\s+(?:company|employer|organization|firm)|(?:related|affiliate|subsidiary|sister|parent|associated)\s+(?:company|companies|employer|entity|role|position)|(?:company|employer).{0,40}\brelated\b|related\s+(?:company|role|position|employer)|same\s+(?:company|employer)|internal (?:candidate|employee)|applied (?:here|to (?:us|this)|before)|permanent or temporary employee|(?:currently|previously)\s+(?:\([^)]*\)\s*)?working\s+for|working\s+for\b.{0,80}\b(contractor|contingent)|contractor or contingent|contingent worker|as an?\s+(employee|contractor|contingent)|employee or (?:a )?contractor|employed by .{0,40} before)\b/i,
    // Stack / tech / tool experience → Yes (not company employment).
    skill_experience_yes:
        /\b((do you have|have you)\b.{0,120}\b(deep\s+)?(hands[\s-]*on\s+)?(experience|worked with|familiar|proficien|knowledge|expertise)\b.{0,120}\b(using|with|in|of)?\b.{0,80}\b(python|java|javascript|typescript|react|node|golang|\.net|c\+\+|sql|aws|azure|gcp|kubernetes|docker|linux|api|rest|graphql|certificate|pki|x\.?509|machine identity|lifecycle|security|infrastructure|devops|terraform|ansible|spark|kafka|redis|mongo|postgres|ml|ai|llm|chatgpt)|experience\b.{0,60}\b(using|with|in)\b.{0,40}\b(python|java|javascript|typescript|react|sql|aws|certificate|pki|x\.?509|security|api|rest)|hands[\s-]*on.{0,40}\b(engineering|experience).{0,80}\b(certificate|pki|python|java|security|infrastructure))\b/i,
    onsite_hub_yes:
        /\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|\b\d+\s+days?\b.{0,60}\b(office|hub)|office hubs?\b/i,
    us_person_yes:
        /\bU\.?\s*S\.?\s*person\b|whether you are a\s*["“']?U\.?\s*S\.?\s*person/i,
    export_control_us_citizen:
        /\b(export[\s_-]*control|EAR\s*\/?\s*ITAR|U\.?\s*S\.?\s*laws concerning the export|confirm I am one of the following)\b/i,
    immigration_na_if_citizen:
        /\b(immigration\s*status|none of the above.{0,40}immigration)\b/i,
    sanctioned_countries_no:
        /\b(cuba|iran|north\s*korea|syria|crimea|luhansk|donetsk).{0,40}(reside|residence|permanent)\b|\breside.{0,80}(cuba|iran|north\s*korea|syria)\b/i,
    // "Comfortable interviewing for the salary outlined…?" — Yes/No, NOT a $ amount.
    salary_comfort_yes:
        /\b(comfortable|willing)\b.{0,80}\b(salary|compensation|pay)\b|\b(salary|compensation)\b.{0,40}\boutlined\b|\b(agree|accept)\b.{0,60}\b(salary|compensation)\b.{0,40}\b(range|outlined|posted|listed|job\s*description)\b/i,
    background_check_yes:
        /\b(background\s*check|background\s*investigation|criminal\s*background)\b/i,
    non_compete_no:
        /\b(non[\s_-]*compete|noncompete|restrictive\s*covenant)\b/i
};

const FIXED_CONSTANT_VALUE = {
    previous_employer_no: 'No',
    skill_experience_yes: 'Yes',
    onsite_hub_yes: 'Yes',
    us_person_yes: 'Yes',
    export_control_us_citizen: 'U.S. Citizen',
    immigration_na_if_citizen: 'N/A',
    sanctioned_countries_no: 'No',
    salary_comfort_yes: 'Yes',
    background_check_yes: 'Yes',
    non_compete_no: 'No'
};

function stripReasoning(text) {
    let s = String(text || '');
    // Prefer content after a closed think block (MiniMax-M2.7 etc.).
    const closed = s.match(/<\/think>\s*([\s\S]*)$/i);
    if (closed) s = closed[1];
    else {
        s = s
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
        // Unclosed think: drop everything through the last think opener.
        s = s.replace(/^[\s\S]*<think>/i, '');
    }
    return s.replace(/```(?:json)?/gi, '').trim();
}

/** Famous employers often hallucinated — only allowed if present in resume/work history. */
const FAMOUS_EMPLOYERS = [
    'Google', 'Alphabet', 'YouTube', 'Meta', 'Facebook', 'Amazon', 'AWS', 'Apple',
    'Microsoft', 'Netflix', 'Uber', 'Airbnb', 'Twitter', 'X Corp', 'LinkedIn',
    'Stripe', 'Shopify', 'Salesforce', 'Oracle', 'IBM', 'Intel', 'NVIDIA',
    'OpenAI', 'Anthropic', 'Whatnot', 'TikTok', 'ByteDance', 'Snap', 'Snapchat'
];

function extractAllowedEmployers(text) {
    const hay = String(text || '');
    const found = [];
    for (const name of FAMOUS_EMPLOYERS) {
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(hay)) found.push(name);
    }
    // Also "at CompanyName" patterns from work_experience lines
    const atRe = /\bat\s+([A-Z][A-Za-z0-9&.''\- ]{1,40}?)(?:\s+in\s+|\s+—|\s+-|\s*$)/g;
    let m;
    while ((m = atRe.exec(hay)) !== null) {
        const co = m[1].trim().replace(/\s+/g, ' ');
        if (co.length >= 2 && co.length <= 40 && !found.some((f) => f.toLowerCase() === co.toLowerCase())) {
            found.push(co);
        }
    }
    return found;
}

function stripInventedEmployers(answer, allowed) {
    let t = String(answer || '');
    if (!t) return t;
    const allowLower = new Set((allowed || []).map((a) => a.toLowerCase()));
    for (const name of FAMOUS_EMPLOYERS) {
        if (allowLower.has(name.toLowerCase())) continue;
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        if (!re.test(t)) continue;
        // Remove "at Google," / "At Google," clauses; replace bare name with "a prior role"
        t = t
            .replace(new RegExp(`\\bat\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[,:]?`, 'gi'), 'in a prior role')
            .replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'a prior company');
    }
    t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trim();
    return t;
}

/**
 * Snap a free-text model answer onto an exact multiple-choice option.
 * Returns the best option string, or '' if nothing scores well.
 */
function parseYearsWanted(answer) {
    const raw = String(answer || '').trim().toLowerCase();
    if (!raw) return NaN;
    let m = raw.match(/(\d+)\s*\+/) || raw.match(/(\d+)\s*or more/) || raw.match(/more than\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
    m = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m) return parseInt(m[2], 10); // use upper bound of wanted band
    m = raw.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : NaN;
}

/** Parse ATS YoE option into {min,max}. "10+" → max Infinity; "0-2" → 0..2. */
function parseYearsOptionRange(optionText) {
    const t = String(optionText || '').toLowerCase().replace(/\s+/g, ' ');
    if (!t) return null;
    let m = t.match(/(\d+)\s*\+/) || t.match(/(\d+)\s*or more/) || t.match(/more than\s*(\d+)/) || t.match(/at least\s*(\d+)/);
    if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) return { min: n, max: Infinity };
    }
    m = t.match(/(\d+)\s*[-–]\s*(\d+)/);
    if (m) {
        return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
    }
    m = t.match(/less than\s*(\d+)/);
    if (m) return { min: 0, max: Math.max(0, parseInt(m[1], 10) - 1) };
    m = t.match(/(\d+)\s*\+?\s*years?/);
    if (m) {
        const n = parseInt(m[1], 10);
        return { min: n, max: n };
    }
    return null;
}

function scoreYearsOption(wantYears, optionText) {
    if (!Number.isFinite(wantYears) || wantYears < 0) return -1;
    const range = parseYearsOptionRange(optionText);
    if (!range) return -1;
    // Never pick a band whose ceiling is below the profile years (e.g. 15 → not 0-2).
    if (Number.isFinite(range.max) && wantYears > range.max) return -1;
    if (wantYears >= range.min && wantYears <= range.max) {
        // Prefer tighter / higher bands when several fit (e.g. 10+ over 5-8 for want 12).
        if (range.max === Infinity) return 98;
        return 92;
    }
    // High experience → always prefer open-ended 10+ / 8+ style options.
    if (wantYears >= 10 && range.max === Infinity && range.min >= 8) return 96;
    if (wantYears >= 10 && range.max === Infinity) return 94;
    return -1;
}

function pickBestYearsOption(wantYearsOrLabel, options) {
    const opts = (options || [])
        .map((o) => String(typeof o === 'string' ? o : (o?.label || o?.value || '')).trim())
        .filter(Boolean);
    if (!opts.length) return '';
    const wantYears = typeof wantYearsOrLabel === 'number'
        ? wantYearsOrLabel
        : parseYearsWanted(wantYearsOrLabel);
    let best = '';
    let bestScore = -1;
    for (const o of opts) {
        const score = scoreYearsOption(wantYears, o);
        if (score > bestScore) {
            bestScore = score;
            best = o;
        }
    }
    // Profile years unknown — still never default to the lowest band; prefer 10+ / highest.
    if (!best && !Number.isFinite(wantYears)) {
        best = opts.find((o) => /10\s*\+|10\s*or more|more than\s*10/i.test(o))
            || opts.find((o) => parseYearsOptionRange(o)?.max === Infinity)
            || '';
    }
    if (!best && Number.isFinite(wantYears) && wantYears >= 10) {
        best = opts.find((o) => /10\s*\+|10\s*or more|more than\s*10/i.test(o))
            || opts.find((o) => parseYearsOptionRange(o)?.max === Infinity)
            || '';
    }
    return best;
}

function snapAnswerToOptions(answer, options) {
    const opts = (options || [])
        .map((o) => String(typeof o === 'string' ? o : (o?.label || o?.value || '')).trim())
        .filter(Boolean);
    if (!opts.length) return String(answer || '').trim();
    const raw = String(answer || '').trim();
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const looksDisability = opts.some((o) => /disabilit/i.test(o));
    // Require "year" in the option text — bare "5+" is employer-count, not YoE.
    const looksYoe = opts.some((o) => /\byears?\b/i.test(o) && !!parseYearsOptionRange(o));
    const looksYesNo = opts.some((o) => /^(yes|no)\b/i.test(o) || /\b(agree|acknowledge|consent)\b/i.test(o));
    if (!raw) {
        // Disability empty → No (never first-option Yes).
        if (looksDisability) {
            return opts.find((o) =>
                /do not have|don'?t have|have not had|no disability|^no\b/i.test(o)
                && !(/^yes\b/i.test(o) && /have a disability/i.test(o))
            ) || '';
        }
        // YoE empty → leave blank (caller uses profile years); never opts[0] (0-2).
        if (looksYoe) return '';
        // Empty model answer: only auto-pick Yes/Agree on Yes/No-style menus.
        // Never force "Yes" onto numeric / ranking menus (employer count, high school, etc.).
        if (looksYesNo) {
            const strong = opts.find((o) => /yes\s*[—–-]/i.test(o) && /multiple/i.test(o))
                || opts.find((o) => /yes\s*[—–-]/i.test(o))
                || opts.find((o) => /^(yes|y)$/i.test(o))
                || opts.find((o) => /\bi\s+agree\b/i.test(o) && !/\b(do\s+not|don't)\b/i.test(o))
                || opts.find((o) => /\backnowledge\b/i.test(o) && !/\b(do\s+not|don't)\b/i.test(o));
            return strong || '';
        }
        return '';
    }
    const w = norm(raw);
    // Exact / case-insensitive exact
    for (const o of opts) {
        if (norm(o) === w) return o;
    }
    // Disability: hard lock No answers onto No options (never Yes via fuzzy).
    if (looksDisability || /disabilit/i.test(raw)) {
        const wantNo = /do not have|don'?t have|have not had|no disability|^no\b/i.test(raw)
            && !(/^yes\b/i.test(raw) && /have a disability/i.test(raw));
        if (wantNo) {
            return opts.find((o) =>
                /do not have|don'?t have|have not had|no disability|^no\b/i.test(o)
                && !( /^yes\b/i.test(o) && /have a disability/i.test(o))
            ) || '';
        }
    }
    // Skill-level menus (REST / Python / AI): never keep "No experience" / academic-only / 0–2
    // when a production / Built / Extensively / Yes option exists.
    const looksSkillLevel = opts.some((o) =>
        /built and maintained|no experience|only academic|extensively|currently maintain|0\s*[-–]\s*[12]|less than\s*[12]/i.test(o)
    );
    if (looksSkillLevel) {
        const weakAns = /no experience|not at all|never used|only academic|^no\b|0\s*[-–]\s*[12]|less than\s*[12]|zero\b/i.test(raw);
        const strong = opts.find((o) => /built and maintained/i.test(o))
            || opts.find((o) => /^yes\b/i.test(o) && /production|currently|past/i.test(o) && !/only academic/i.test(o))
            || opts.find((o) => /extensively/i.test(o))
            || opts.find((o) => /\d+\s*\+\s*years?|10\+|7\s*[-–]\s*10|5\s*\+/i.test(o)
                && !/0\s*[-–]|less than/i.test(o))
            || opts.find((o) => /^yes\b/i.test(o) && !/only academic|no experience/i.test(o));
        if (strong && (weakAns || !raw)) return strong;
        if (strong && /\d+\s*\+?\s*years?|expert|advanced|proficient|extensive/i.test(raw)) return strong;
    }
    // Bare Yes / Agree / No BEFORE YoE — "Yes" must not snap onto "5+" employer counts.
    if (/^(yes|y)$/i.test(raw) || /^(i\s+)?(agree|acknowledge|consent)\b/i.test(raw)) {
        const affirm = opts.find((o) => /^(yes|y)\b/i.test(o) && !/\b(no|not)\b/i.test(o))
            || opts.find((o) => /\bi\s+agree\b/i.test(o) && !/\b(do\s+not|don't|disagree)\b/i.test(o))
            || opts.find((o) => /\backnowledge\b/i.test(o) && !/\b(do\s+not|don't)\b/i.test(o))
            || opts.find((o) => /\bconsent\b/i.test(o) && !/\b(do\s+not|don't)\b/i.test(o))
            || opts.find((o) => /^agree\b/i.test(o));
        if (affirm) return affirm;
        // No Yes/Agree in list — do not return free-text "Yes" (typed into select → "No options").
        return '';
    }
    if (/^(no|n)$/i.test(raw) || /^(i\s+)?(do\s+not|don't|disagree|decline)\b/i.test(raw)) {
        const neg = opts.find((o) => /^(no|n)\b/i.test(o) && !/^not\b/i.test(o))
            || opts.find((o) => /\b(do\s+not|don't|disagree|decline|refuse)\b/i.test(o));
        if (neg) return neg;
        return '';
    }
    // Years-of-experience bands: map profile years → containing option (never 0-2 for 15+).
    const answerLooksYoe = /\d/.test(raw) || /\byears?\b/i.test(raw) || /\+|or more|less than/i.test(raw);
    if (looksYoe && answerLooksYoe) {
        const yoeHit = pickBestYearsOption(raw, opts);
        if (yoeHit) return yoeHit;
    }
    // Answer is a short prefix of an option (or vice versa)
    let best = null;
    let bestScore = -1;
    for (const o of opts) {
        const t = norm(o);
        let score = -1;
        if (t === w) score = 100;
        else if (t.startsWith(w) || w.startsWith(t)) score = 88;
        else if (t.includes(w) && w.length >= 4) score = 75;
        else if (w.includes(t) && t.length >= 6) score = 72;
        else {
            const tokens = w.split(/\s+/).filter((x) => x.length > 2);
            if (tokens.length) {
                const hit = tokens.filter((tok) => t.includes(tok)).length;
                const ratio = hit / tokens.length;
                if (ratio >= 0.45) score = Math.round(ratio * 80);
            }
            // Ownership / reliability paraphrases
            if (/\bowned?\b/.test(w) && /\bowned?\b/.test(t) && /\b(reliab|performance|security|production)\b/.test(t)) {
                score = Math.max(score, 78);
            }
            if (/\bcontribut/.test(w) && /\bcontribut/.test(t)) score = Math.max(score, 70);
        }
        // Prefer stronger "Yes — …" when the model said yes vaguely
        if (/^(yes|y)\b/.test(w) && /^yes\b/i.test(t) && /multiple|at least one|owned|production/i.test(t)) {
            score = Math.max(score, 80);
        }
        // High-school / ranking menus: "Above average" must not snap to bare "Average".
        if (/above\s*average|top\s*25|upper\s*quart/i.test(w)) {
            if (/below|bottom|poor/i.test(t)) score = -1;
            else if (/top\s*25\s*%/i.test(t)) score = Math.max(score, 94);
            else if (/top\s*(5|10)\s*%/i.test(t)) score = Math.max(score, 88);
            else if (/above\s*average|excellent|good|strong|upper/i.test(t)) score = Math.max(score, 90);
            else if (/^average$/i.test(t) || /\baverage\b/i.test(t)) score = Math.min(score, 40);
        }
        if (/top\s*5|excellent|outstanding/i.test(w)) {
            if (/top\s*5\s*%/i.test(t) || /excellent|outstanding/i.test(t)) score = Math.max(score, 95);
        }
        // Token "years" alone must not rank 0-2 equal to 10+.
        if (looksYoe) {
            const yScore = scoreYearsOption(parseYearsWanted(raw), o);
            if (yScore >= 0) score = Math.max(score, yScore);
            else if (/\d/.test(t) && Number.isFinite(parseYearsWanted(raw))) score = -1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = o;
        }
    }
    return bestScore >= 55 ? best : '';
}

/** Yes/No “ok with posted salary?” — must not be treated as expected $ amount. */
function isSalaryComfortYesNo(hay) {
    const h = String(hay || '');
    if (!/\b(salary|compensation|pay|wage)\b/i.test(h)) return false;
    return FIXED_CONSTANT_RE.salary_comfort_yes.test(h)
        || (/\b(are you|do you)\b/i.test(h) && /\bcomfortable\b/i.test(h));
}

function optionsLookYesNoOnly(options) {
    if (!Array.isArray(options) || options.length < 2) return false;
    const labels = options
        .map((o) => String(typeof o === 'string' ? o : (o?.label || o?.value || '')).trim())
        .filter(Boolean);
    if (labels.length < 2) return false;
    const yn = labels.filter((t) => /^(yes|no)\b/i.test(t));
    return yn.length >= 2 && yn.length === labels.length;
}

function isSalaryQuestion(q) {
    const hay = `${q?.label || ''} ${q?.name || ''} ${q?.id || ''}`;
    if (isSalaryComfortYesNo(hay)) return false;
    if (optionsLookYesNoOnly(q?.options)) return false;
    return SALARY_RE.test(hay);
}

function fixedConstantKind(q) {
    const hay = `${q?.label || ''} ${q?.name || ''} ${q?.id || ''}`;
    const order = [
        'salary_comfort_yes',
        'background_check_yes',
        'non_compete_no',
        'onsite_hub_yes',
        'us_person_yes',
        // Company / related employer first → No; then stack/skill → Yes.
        'previous_employer_no',
        'skill_experience_yes',
        'export_control_us_citizen',
        'immigration_na_if_citizen',
        'sanctioned_countries_no'
    ];
    for (const kind of order) {
        if (FIXED_CONSTANT_RE[kind]?.test(hay)) return kind;
    }
    return null;
}

const UNIQUE_WHY_RE = /\b(why\s*(are\s*you\s*|do\s*you\s*)?(want|apply|interested)|why\s*(this|the)\s*(role|company|position|job|opportunity)|why\s*us|what\s*interests\s*you|motivat(?:e|ion|es|ed)\s*(you)?\s*(to\s*apply)?)\b/i;
const UNIQUE_BEHAVIORAL_RE = /\b(tell\s*(us|me)\s*about\s*a\s*time|describe\s*a\s*time|give\s*an?\s*example\s*of\s*a\s*time|star\s*method|situation\s*where\s*you)\b/i;
const UNIQUE_COVER_RE = /\b(cover\s*letter|additional\s*information|anything\s*else\s*(we|you)\s*should\s*know|is\s*there\s*anything\s*else)\b/i;

function uniqueSubtype(hay) {
    const h = String(hay || '');
    if (UNIQUE_BEHAVIORAL_RE.test(h)) return 'behavioral';
    if (UNIQUE_COVER_RE.test(h)) return 'cover';
    if (UNIQUE_WHY_RE.test(h)) return 'why';
    return null;
}

/**
 * Cascade lane classifier (Studying Engine).
 * @returns {{ lane: string, kind?: string|null, unique_subtype?: string|null, knockout?: boolean }}
 */
function classifyAnswerLane(q) {
    const hay = `${q?.label || ''} ${q?.name || ''} ${q?.id || ''}`;
    if (FIXED_FIELD_RE.disability_status?.test(hay)
        && !/\binsurance\b/i.test(hay)
        && !/\btell (us|me) about\b/i.test(hay)) {
        return { lane: 'policy', kind: 'disability_status', knockout: true };
    }
    const constKind = fixedConstantKind(q);
    if (constKind) {
        return {
            lane: 'policy',
            kind: constKind,
            knockout: questionMemory.KNOCKOUT_KINDS.has(constKind)
        };
    }
    if (isSalaryQuestion(q)) {
        return { lane: 'salary', kind: 'salary_amount' };
    }
    const profileKind = fixedProfileKind(q);
    if (profileKind) {
        const knockout = questionMemory.KNOCKOUT_KINDS.has(profileKind);
        return {
            lane: knockout || profileKind === 'requires_sponsorship' || profileKind === 'work_authorization'
                ? (profileKind === 'disability_status' ? 'policy' : 'profile')
                : 'profile',
            kind: profileKind,
            knockout
        };
    }
    const sub = uniqueSubtype(hay);
    if (sub) {
        return { lane: 'unique', kind: `unique_${sub}`, unique_subtype: sub };
    }
    return { lane: 'written', kind: null };
}

const KNOWN_FIELD_TYPES = new Set([
    'text', 'textarea', 'select', 'radio', 'checkbox', 'yesno', 'boolean',
    'email', 'tel', 'phone', 'url', 'number', 'search', ''
]);

/**
 * New / unclassified question type → Groq (MiniMax stays on known lanes).
 * Written + no kind = studying engine does not recognize the type.
 * Exotic ATS input types (date, file, unknown, …) also count as new.
 */
function isNewQuestionType(q) {
    const type = String(q?.type || q?.input_type || '').toLowerCase().trim();
    if (type && !KNOWN_FIELD_TYPES.has(type)) return true;
    const lane = String(q?.lane || '').toLowerCase();
    if (lane === 'unique' || lane === 'policy' || lane === 'profile' || lane === 'salary') {
        return false;
    }
    return !q?.kind;
}

function tokenSet(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 2)
    );
}

function textSimilarity(a, b) {
    const A = tokenSet(a);
    const B = tokenSet(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter += 1;
    return inter / (A.size + B.size - inter);
}

function loadRecentUniqueAnswers(userId, limit = 15) {
    if (!userId) return [];
    try {
        const rows = getAll(
            `SELECT answers_json FROM bid_courses
             WHERE user_id = ? AND answers_json IS NOT NULL AND TRIM(answers_json) <> ''
             ORDER BY COALESCE(applied_at, filled_at, updated_at) DESC
             LIMIT 40`,
            [parseInt(userId, 10)]
        );
        const out = [];
        for (const row of rows) {
            let answers = [];
            try {
                answers = JSON.parse(row.answers_json);
            } catch {
                continue;
            }
            if (!Array.isArray(answers)) continue;
            for (const a of answers) {
                if (String(a.lane || '') === 'unique'
                    || uniqueSubtype(a.label || a.id)) {
                    const text = String(a.answer || a.value || '').trim();
                    if (text.length >= 40) out.push(text);
                    if (out.length >= limit) return out;
                }
            }
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Enforce Unique lane diversity vs recent bids. One regen hint via append if too similar.
 */
function enforceUniqueAnswer(draft, recentUniqueAnswers, { maxLength = 0 } = {}) {
    let text = String(draft || '').trim();
    let unique_similarity = 0;
    let unique_regenerated = false;
    for (const prev of recentUniqueAnswers || []) {
        unique_similarity = Math.max(unique_similarity, textSimilarity(text, prev));
    }
    if (unique_similarity >= 0.72 && text) {
        // Soft diversify without a second LLM round-trip: rephrase opener + drop first clause echo.
        const diversifiers = [
            'For this specific role, ',
            'Looking at this team and product, ',
            'Based on this job description, '
        ];
        const pick = diversifiers[Math.floor(Math.random() * diversifiers.length)];
        const stripped = text.replace(/^(i am|i'm|i have always|as someone who)\b[^.]{0,80}\.\s*/i, '');
        text = `${pick}${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}`;
        unique_regenerated = true;
        let sim2 = 0;
        for (const prev of recentUniqueAnswers || []) {
            sim2 = Math.max(sim2, textSimilarity(text, prev));
        }
        unique_similarity = sim2;
    }
    let truncated = false;
    if (maxLength > 40 && text.length > maxLength) {
        const cut = text.slice(0, maxLength - 1);
        const sp = cut.lastIndexOf('. ');
        text = (sp > 40 ? cut.slice(0, sp + 1) : cut).trim();
        truncated = true;
    }
    return { text, unique_similarity, unique_regenerated, truncated };
}

/** Map a form question to a fixed profile column, or null if AI may answer. */
function fixedProfileKind(q) {
    const hay = `${q?.label || ''} ${q?.name || ''} ${q?.id || ''}`;
    if (/\bsexual\b/i.test(hay) && FIXED_FIELD_RE.gender.test(hay)) return null;
    // "Authorized to work without sponsorship?" = work auth Yes — NOT "need sponsorship?" No
    if (
        /\b(authorized|authorised|eligible)\b/i.test(hay)
        && /\bwithout\s+(?:visa\s+)?sponsorship\b/i.test(hay)
    ) {
        return 'work_authorization';
    }
    // Prefer more specific matchers first
    const order = [
        'hispanic_latino', 'work_authorization', 'requires_sponsorship',
        'disability_status', 'veteran_status', 'security_clearance',
        'willing_to_relocate', 'willing_to_travel', 'earliest_start_date',
        'notice_period', 'how_heard', 'years_of_experience',
        'school', 'discipline', 'degree', 'education_level',
        'over_18', 'preferred_name', 'portfolio_url', 'website_url',
        'race_ethnicity', 'gender', 'birthdate', 'todays_date',
        'city', 'state', 'current_company'
    ];
    for (const kind of order) {
        if (!FIXED_FIELD_RE[kind]?.test(hay)) continue;
        // "Disability insurance" is not ADA self-ID.
        if (kind === 'disability_status' && /\binsurance\b/i.test(hay)) continue;
        // Don't treat "without sponsorship" auth questions as sponsorship-required.
        if (
            kind === 'requires_sponsorship'
            && /\b(authorized|authorised|eligible)\b/i.test(hay)
            && /\bwithout\s+(?:visa\s+)?sponsorship\b/i.test(hay)
        ) {
            continue;
        }
        // "Years of experience with React" is a skill written Q — not the profile YoE field.
        if (
            kind === 'years_of_experience'
            && /\byears?[\s_-]*of[\s_-]*experience\s+(with|in|using|on)\b/i.test(hay)
        ) {
            continue;
        }
        if (kind === 'years_of_experience' && /\b(describe|explain|provide|open[\s_-]*source)\b/i.test(hay)) {
            continue;
        }
        if (kind === 'degree' && /\b(highest[\s_-]*(degree|education)|degree[\s_-]*level)\b/i.test(hay)) {
            // Prefer education_level for "highest degree"
            continue;
        }
        if (kind === 'school' && /\b(high[\s_-]*school)\b/i.test(hay) && !/\buniversity|college\b/i.test(hay)) {
            continue;
        }
        return kind;
    }
    return null;
}

function fixedProfileValue(kind, profile) {
    if (!profile || !kind) return '';
    if (kind === 'birthdate') return profile.birthdate || '';
    if (kind === 'todays_date') {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                month: '2-digit',
                day: '2-digit',
                year: 'numeric'
            }).formatToParts(new Date());
            const get = (t) => parts.find((p) => p.type === t)?.value || '';
            return `${get('month')}/${get('day')}/${get('year')}`;
        } catch (_) {
            const d = new Date();
            return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
        }
    }
    if (kind === 'how_heard') return profile.how_heard || 'LinkedIn';
    if (kind === 'requires_sponsorship') {
        const raw = String(profile.requires_sponsorship || '').trim();
        if (/^(yes|y|true|1)$/i.test(raw)) return 'Yes';
        return 'No';
    }
    if (kind === 'disability_status') {
        return 'No, I do not have a disability';
    }
    if (kind === 'current_company') {
        const direct = String(
            profile.current_company || profile.current_employer || profile.company || ''
        ).trim();
        if (direct && !/^unknown$/i.test(direct)) return direct.slice(0, 80);
        const hay = `${profile.work_experience || ''}\n${profile.experience || ''}\n${profile.summary || ''}`;
        const atMatch = hay.match(/\bat\s+([A-Z][A-Za-z0-9&.,'’\- ]{1,50}?)(?:\s+in\s+|\s+[—–\-]\s+|\s*\(|\s*$)/m);
        if (atMatch && atMatch[1]) return atMatch[1].trim().replace(/\s+/g, ' ').slice(0, 80);
        const allowed = extractAllowedEmployers(hay);
        return (allowed[0] || '').slice(0, 80);
    }
    if (kind === 'work_authorization') {
        const raw = String(profile.work_authorization || '').trim();
        const country = String(profile.country || 'United States').trim();
        const isUsProfile = /^(united states|usa|u\.?s\.?a?\.?)$/i.test(country);
        if (!raw) return isUsProfile ? 'Yes' : '';
        if (/^(yes|y|true|1)$/i.test(raw)) return 'Yes';
        if (/^(no|n|false|0)$/i.test(raw)) return 'No';
        if (/\b(united states|usa|u\.?s\.?)\b/i.test(raw) && isUsProfile) return 'Yes';
        if (/\b(country|nation)\b/i.test(raw)) return isUsProfile ? 'Yes' : '';
        return isUsProfile ? 'Yes' : raw;
    }
    if (kind === 'school' || kind === 'degree' || kind === 'discipline') {
        const parts = parseEducationPartsServer(profile);
        return parts[kind] || '';
    }
    if (kind === 'years_of_experience') {
        return yearsExperienceFillValueServer(profile);
    }
    if (kind === 'over_18') {
        const raw = String(profile.over_18 || '').trim();
        if (raw) return raw;
        const country = String(profile.country || 'United States').trim();
        return /^(united states|usa|u\.?s\.?a?\.?)$/i.test(country) ? 'Yes' : '';
    }
    return profile[kind] || '';
}

function parseEducationPartsServer(profile) {
    if (!profile) return { school: '', degree: '', discipline: '' };
    let school = String(profile.school || '').trim();
    let degree = String(profile.degree || '').trim();
    let discipline = String(profile.discipline || '').trim();
    const firstLine = String(profile.education || '')
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0] || '';
    if (firstLine) {
        const m = firstLine.match(/^(.+?)\s+in\s+(.+?)\s+at\s+(.+?)(?:\s+in\s+[\d.]|\s*$)/i);
        if (m) {
            if (!degree) degree = m[1].trim();
            if (!discipline) discipline = m[2].trim();
            if (!school) school = m[3].trim();
        } else {
            const m2 = firstLine.match(/^(.+?)\s+at\s+(.+?)(?:\s+in\s+[\d.]|\s*$)/i);
            if (m2) {
                if (!degree) degree = m2[1].trim();
                if (!school) school = m2[2].trim();
            }
        }
    }
    if (!degree && profile.education_level) {
        const level = String(profile.education_level).trim();
        const map = {
            "Bachelor's": 'Bachelor of Science',
            "Master's": 'Master of Science',
            Doctorate: 'Doctorate',
            "Associate's": 'Associate of Science',
            'High School': 'High School Diploma'
        };
        degree = map[level] || level;
    }
    return { school, degree, discipline };
}

function yearsExperienceFillValueServer(profile) {
    const raw = String(profile?.years_of_experience || '').trim();
    if (!raw) return '';
    if (/year/i.test(raw) || /[+]/.test(raw) || /-/.test(raw)) return raw;
    const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n)) return raw;
    if (n < 5) return 'Less than 5 years';
    if (n <= 6) return '5-6 years';
    if (n <= 10) return '7-10 years';
    return '10+ years';
}

/** Soft cleanup: strip AI openers / skill dumps without inventing new facts. */
function polishWrittenAnswer(text, { companyName: co = '', jobRole: role = '', shortForm = false } = {}) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return t;

    const opener = new RegExp(
        `^(?:I(?:'m| am) (?:drawn to|particularly impressed by|excited about|thrilled by|passionate about)`
        + `|I am (?:a|an) [^,]{3,50} with (?:over |more than )?\\d+\\+? years?`
        + `|I am writing (?:to|because)`
        + `|(?:I believe )?my skills align[^.,]*[.,]?`
        + `|As a [^,]{3,60},?`
        + `|With (?:a |my )?background in [^,]{3,60},?)\\s*`,
        'i'
    );
    if (opener.test(t)) {
        const because = t.match(/\bbecause\b\s+(.+)$/i);
        if (because) t = because[1].trim();
        else t = t.replace(opener, '').trim();
    }

    t = t
        .replace(/\b(leverage|cutting-edge|seamless|dynamic team|opportunity to contribute|innovative team|fast-paced environment)\b/gi, '')
        .replace(/\s*I believe\b[^.!?]*[.!?]?/gi, '')
        .replace(/\s*I(?:'d| would) like to contribute\b[^.!?]*[.!?]?/gi, '')
        .replace(/\s*has the potential to\b[^.!?]*[.!?]?/gi, '')
        .replace(/\b(thrilled|passionate|excited) about (?:the )?opportunity\b[^.!?]*[.!?]?/gi, '')
        // Strip markdown / AI formatting so answers look human-typed.
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/\s*[—–―−]+\s*/g, ', ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([,.])/g, '$1')
        .replace(/,\s*,/g, ',')
        .trim();

    if (/^(the|which|because|and)\b/i.test(t) && co) {
        const rest = t.replace(/^(the|which|because|and)\b[, ]*/i, '').trim();
        t = `I want to work on ${co}'s ${role || 'team'}. ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
        t = t.replace(/\s+/g, ' ').trim();
    }
    const laundry = t.match(
        /^Built\s+(.+?),\s*interested in\s+(.+?)\s+with\s+([A-Za-z0-9+.#\/,\s-]{8,})$/i
    );
    if (laundry) {
        const built = laundry[1].trim().replace(/\.$/, '');
        const interest = laundry[2].trim().replace(/\.$/, '');
        const who = co || 'this team';
        const roleBit = role ? ` (${role})` : '';
        t = `Most of my recent work has been ${built}. ${who}${roleBit}, especially ${interest}, is the problem space I want next.`;
    }

    // Always keep answers short and form-like (even outside bidderMode).
    {
        const words = t.split(/\s+/).filter(Boolean);
        const sentences = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
        const maxWords = shortForm ? 55 : 60;
        const maxSentences = 2;
        if (words.length > maxWords || sentences.length > maxSentences) {
            const keep = sentences.slice(0, maxSentences).join(' ');
            t = keep || words.slice(0, Math.min(48, maxWords)).join(' ');
            if (t && !/[.!?]"?$/.test(t)) t += '.';
        }
    }

    if (t && /^[a-z]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.split(/\s+/).length > 4 && !/[.!?]"?$/.test(t)) t += '.';
    return t;
}

function looksLikeCompoundQuestion(questionLabel) {
    const q = String(questionLabel || '');
    if (!q.trim()) return false;
    const qMarks = (q.match(/\?/g) || []).length;
    if (qMarks >= 2) return true;
    if (/\b(if\s+(so|yes|no)|please\s+also|and\s+also|as\s+well)\b/i.test(q)) return true;
    if (/\b(1[).]|2[).]|;\s*)/.test(q) && /\?/.test(q)) return true;
    if (/\band\b.+\?/i.test(q) && /\b(what|why|how|describe|explain|bring|would you)\b/i.test(q)) return true;
    return false;
}

/**
 * @param {object} opts
 * @param {object} opts.profile
 * @param {string} opts.jobDescription
 * @param {string} opts.resumeHtml
 * @param {Array<{id:string,label:string,type?:string}>} opts.questions
 * @param {string} [opts.companyName]
 * @param {string} [opts.jobRole]
 */
async function generateApplicationAnswers({
    profile,
    jobDescription,
    resumeHtml,
    questions,
    companyName,
    jobRole,
    userId,
    /** Bidder engine only — longer essays + extra rules/few-shot block */
    bidderMode = false,
    promptExtras = ''
}) {
    const list = Array.isArray(questions) ? questions.filter((q) => q && (q.label || q.id)) : [];
    if (!list.length) {
        return { answers: [], skipped: [] };
    }

    const skipped = [];
    const salaryAnswers = [];
    const fixedAnswers = [];
    const memoryAnswers = [];
    const toAnswer = [];
    const studyingOn = questionMemory.studyingEnabled()
        && String(process.env.STUDYING_ENGINE || '1').trim() !== '0';

    try {
        questionMemory.seedIfEmpty();
    } catch (_) { /* ignore */ }

    for (const q of list) {
        const laneInfo = classifyAnswerLane(q);
        // Hard disability lock always Policy No
        if (laneInfo.kind === 'disability_status') {
            let answer = 'No, I do not have a disability';
            if (Array.isArray(q.options) && q.options.length) {
                const noOpt = q.options
                    .map((o) => (typeof o === 'string' ? o : (o?.label || o?.value || '')))
                    .find((t) => /do not have|don'?t have|have not had|no disability|^no\b/i.test(t)
                        && !/^yes\b/i.test(t));
                if (noOpt) answer = noOpt;
            }
            fixedAnswers.push({
                id: String(q.id || q.label).slice(0, 120),
                label: q.label || q.id,
                answer,
                source: 'hard_lock',
                match_source: 'hard_lock',
                answer_type: 'fixed',
                lane: 'policy',
                kind: 'disability_status',
                knockout: true,
                failure_code: 'knockout_lock'
            });
            continue;
        }
        // Fixed Yes/No (incl. salary-comfort) before salary $ detection.
        const constKind = fixedConstantKind(q);
        if (constKind) {
            fixedAnswers.push({
                id: String(q.id || q.label).slice(0, 120),
                label: q.label || q.id,
                answer: FIXED_CONSTANT_VALUE[constKind],
                source: 'fixed',
                match_source: 'regex',
                answer_type: 'fixed',
                lane: 'policy',
                kind: constKind,
                knockout: questionMemory.KNOCKOUT_KINDS.has(constKind)
            });
            continue;
        }
        if (isSalaryQuestion(q)) {
            const pick = pickSalaryExpectation({
                jobDescription,
                profileSalaryRange: profile?.salary_range || '',
                fieldLabel: q.label || q.id || '',
                jobRole: jobRole || '',
                companyName: companyName || ''
            });
            if (pick?.formatted) {
                const val = Number(pick.value);
                if (val === 0 || val === 99999) {
                    skipped.push({
                        id: q.id || q.label,
                        label: q.label || q.id,
                        reason: 'salary_sentinel_blocked'
                    });
                } else {
                    salaryAnswers.push({
                        id: String(q.id || q.label).slice(0, 120),
                        label: q.label || q.id,
                        answer: pick.formatted,
                        lane: 'salary',
                        match_source: 'salary',
                        salary_meta: {
                            source: pick.source,
                            value: pick.value,
                            jdRange: pick.jdRange,
                            profileRange: pick.profileRange
                        }
                    });
                }
            } else {
                skipped.push({
                    id: q.id || q.label,
                    label: q.label || q.id,
                    reason: 'salary_no_jd_or_profile_range'
                });
            }
            continue;
        }
        const fixedKind = fixedProfileKind(q);
        if (fixedKind) {
            const value = fixedProfileValue(fixedKind, profile);
            if (value) {
                fixedAnswers.push({
                    id: String(q.id || q.label).slice(0, 120),
                    label: q.label || q.id,
                    answer: value,
                    source: 'profile',
                    match_source: 'profile',
                    answer_type: 'fixed',
                    lane: laneInfo.lane === 'policy' ? 'policy' : 'profile',
                    kind: fixedKind,
                    knockout: !!laneInfo.knockout
                });
            } else {
                skipped.push({
                    id: q.id || q.label,
                    label: q.label || q.id,
                    reason: `fixed_profile_empty:${fixedKind}`
                });
            }
            continue;
        }

        // L2 vector / Jaccard memory (Policy/Profile phrasings only)
        if (studyingOn) {
            try {
                const mem = await questionMemory.matchQuestion(q.label || q.id, {
                    userId: userId || null
                });
                if (mem.hit && mem.answer) {
                    let answer = mem.answer;
                    if (Array.isArray(q.options) && q.options.length) {
                        if (mem.kind === 'disability_status') {
                            const noOpt = q.options
                                .map((o) => (typeof o === 'string' ? o : (o?.label || o?.value || '')))
                                .find((t) => /do not have|don'?t have|have not had|no disability|^no\b/i.test(t)
                                    && !/^yes\b/i.test(t));
                            answer = noOpt || answer;
                        } else {
                            const snapped = snapAnswerToOptions(answer, q.options);
                            if (snapped) answer = snapped;
                        }
                    }
                    memoryAnswers.push({
                        id: String(q.id || q.label).slice(0, 120),
                        label: q.label || q.id,
                        answer,
                        source: 'question_memory',
                        match_source: 'question_memory',
                        answer_type: 'fixed',
                        lane: 'policy',
                        kind: mem.kind,
                        knockout: !!mem.knockout,
                        memory_score: mem.score,
                        memory_gap: mem.gap,
                        failure_code: mem.failure_code || null
                    });
                    continue;
                }
            } catch (_) { /* fall through to LLM */ }
        }

        const drafted = {
            id: String(q.id || q.label).slice(0, 120),
            label: String(q.label || q.id).slice(0, 400),
            type: q.type || 'text',
            answer_type: 'written',
            lane: laneInfo.lane,
            kind: laneInfo.kind,
            unique_subtype: laneInfo.unique_subtype || undefined,
            options: Array.isArray(q.options)
                ? q.options
                    .map((o) => String(typeof o === 'string' ? o : (o?.label || o?.value || '')).trim())
                    .filter(Boolean)
                    .slice(0, 24)
                : []
        };
        drafted.new_type = isNewQuestionType(drafted);
        toAnswer.push(drafted);
    }

    if (!toAnswer.length) {
        const answersProvider = (() => {
            try {
                return getAnswersProviderConfig();
            } catch (_) {
                return null;
            }
        })();
        return {
            answers: [...salaryAnswers, ...fixedAnswers, ...memoryAnswers],
            skipped,
            provider: answersProvider?.provider || null,
            model: answersProvider?.model || null,
            studying: studyingOn,
            memory_hits: memoryAnswers.length
        };
    }

    const resumeText = String(resumeHtml || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 5000);

    const workExpText = String(profile.work_experience || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const allowedEmployers = extractAllowedEmployers(`${resumeText}\n${workExpText}`);
    const allowedEmployerBlock = allowedEmployers.length
        ? `ALLOWED EMPLOYERS (only these company names may appear in answers): ${allowedEmployers.join(', ')}`
        : 'ALLOWED EMPLOYERS: (none clearly listed — do not name any big-tech employer; say "in production" / "prior roles" only)';

    const profileBlock = [
        `Name: ${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
        profile.email ? `Email: ${profile.email}` : '',
        profile.phone ? `Phone: ${profile.phone}` : '',
        profile.linkedin_url ? `LinkedIn: ${profile.linkedin_url}` : '',
        profile.github_url ? `GitHub: ${profile.github_url}` : '',
        profile.city || profile.state || profile.country
            ? `Location: ${[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}`
            : '',
        profile.salary_range ? `Candidate salary range: ${profile.salary_range}` : '',
        profile.work_authorization ? `Work auth: ${profile.work_authorization}` : '',
        profile.requires_sponsorship ? `Sponsorship: ${profile.requires_sponsorship}` : '',
        profile.gender ? `Gender: ${profile.gender}` : '',
        profile.disability_status
            ? `Disability: No, I do not have a disability`
            : 'Disability: No, I do not have a disability',
        profile.veteran_status ? `Veteran: ${profile.veteran_status}` : '',
        profile.race_ethnicity ? `Race/ethnicity: ${profile.race_ethnicity}` : '',
        workExpText ? `Work history notes: ${workExpText.slice(0, 1200)}` : ''
    ].filter(Boolean).join('\n');

    const lengthBlock = bidderMode
        ? `LENGTH (Bidder — shortest clear human answers, NOT essays):
- Yes/No ONLY when the question is clearly binary (authorized? sponsorship? agree?). Answer "Yes" or "No" alone.
- MULTIPLE-CHOICE / RADIO: when OPTIONS are listed, copy ONE option EXACTLY (same spelling/punctuation). Do not paraphrase. Do not write an essay.
- NEVER answer only "Yes" or "No" to "describe / provide an example / explain" free-text questions (no OPTIONS).
- Status / N/A follow-ups → "N/A" or one short phrase.
- One-line fields → under ~10 words.
- "Why this company/role" / experience / open text → 1 short sentence when enough, else 2 (about 18–40 words total). Hard cap 50 words.
- Unique to THIS profile + THIS CV + THIS JD. Never reuse another candidate's phrasing.
- Never pad with buzzwords. Never write more than 50 words for any single answer.
- Mirror true JD keywords naturally; never invent employers or metrics.

COMPOUND / DOUBLE QUESTIONS (same field — answer ALL parts in one string):
- Labels often pack two asks: "Do you have X? If yes, describe…", "Why this role, and what would you bring?", "Authorized? Need sponsorship?"
- Detect multi-part cues: second "?", "If so/If yes", "and/also", "Please also", "1)/2)", or ";" joining asks.
- Cover every part in ONE answer. Usually two short sentences (part A, then part B). Never leave the second half blank or "N/A" when the first part is Yes/relevant.
- Binary + describe → "Yes. [one concrete sentence.]" or "No." only when the follow-up does not apply.
- Two open asks → one tight sentence each. No essay.
- Dual Yes/No with OPTIONS → pick the listed option that covers both when possible; otherwise one short line answering both.
- Still one id → one answer string. Do not invent a second field.`
        : `LENGTH (strict — shortest clear human answers):
- Yes/No ONLY when the question is clearly binary (authorized? sponsorship? agree?). Answer "Yes" or "No" alone.
- MULTIPLE-CHOICE / RADIO: when OPTIONS are listed, copy ONE option EXACTLY (same spelling/punctuation). Do not paraphrase.
- NEVER answer only "Yes" or "No" to "describe / provide an example / explain" free-text questions (no OPTIONS) — write 1–2 real sentences.
- Status / N/A follow-ups → "N/A" or one short phrase.
- One-line fields → under ~10 words.
- "Why this company/role" / open text → 1–2 natural sentences (about 18–40 words). Hard cap 50 words.
- Unique to THIS profile + THIS CV + THIS JD. Shortest answer that still sounds human and job-specific.`;

    const systemPrompt = `You write the shortest clear job-application form answers in the candidate's voice: a real person typing into a web form — never like an AI assistant, never like a polished cover letter.

Voice: calm, direct, specific, professional. Plain English only. Contractions speech is OK when natural ("I've", "I'm"). Not slangy, not corporate-AI, not a resume keyword dump.

SOUND HUMAN (critical):
- Prefer concrete facts from THIS candidate's GENERATED RESUME + PROFILE + WORK HISTORY, aimed at THIS JOB DESCRIPTION.
- Every open-text answer must be unique to this profile and this JD — if another candidate could paste the same line, rewrite.
- Do NOT write multi-paragraph essays. Prefer one short sentence; two only when needed${bidderMode ? ' (three only if a compound question needs both parts)' : ''}.
- Do NOT start with "As a …", "With a background in …", "I am a [title] with X years…", or "I am writing to…".
- Do NOT use generic praise, skill laundry lists, or resume-dump openings.
- Do NOT use parallel buzzword stacks or "passionate / excited / thrilled / leverage / cutting-edge / innovative team".
- If the question asks how many employers/companies in the last N years, count from WORK HISTORY (never answer 0 if they have jobs listed — use at least 1).
- If the question asks for rationale or evidence (grades, rankings, SAT/ACT), answer with real scores/grades from PROFILE/RESUME only. Never answer with a US state name alone (e.g. never just "Texas").
- Disability / EEO / veteran / race / gender / how you heard about us → return "" (filled from profile elsewhere).
${bidderMode ? `
COMPOUND QUESTIONS:
- When one label asks two things, answer both briefly in the same string (see LENGTH rules).
` : ''}
MULTIPLE CHOICE (critical):
- When a question includes an "options" array, your answer MUST be exactly one of those option strings (character-for-character when possible).
- Pick the option that best matches PROFILE + RESUME + JD. Prefer the strongest true option (e.g. "Yes — multiple systems" over weaker ones when resume supports ownership).
- For language / skill radios, pick the one language/skill that is strongest on the resume among the listed options.
- Never invent a new option. Never answer with a paragraph when options exist.

FORMATTING (critical — answers must look human-typed):
- Plain text only. Never use markdown, bold (**text**), italics, bullets, numbered lists, headings (#), or code backticks.
- Never use long dashes (em dash — or en dash – or ―). Use a period, comma, or plain hyphen (-) only if needed.
- Prefer two short sentences over one sentence with a dash.
- No emoji. No ALL CAPS emphasis.

${lengthBlock}

UNIQUENESS (critical for "why" / interest questions):
- Locked to THIS company + THIS role + THIS JD + THIS profile's resume. If swapping the company name or candidate still works, rewrite; too generic.
- Use 1 concrete JD hook + 1 true resume fact from THIS CV only.
- Do NOT dump stacks ("Python, APIs, Postgres…"). At most one skill inside a real sentence.
- Do NOT copy example wording below. Write fresh sentences from THIS JD + resume only.

BAD:
"Built ops tooling and microservices, interested in satellite scheduling with Python, APIs, Postgres."
"Excited about the opportunity to contribute to your innovative team."
"I am particularly drawn to your mission and cutting-edge culture."
"Texas" (as a standalone answer to a rationale/evidence question)
"At Google, I led…" (when Google is not on the resume)
"Yes" (alone, when the label also asks you to describe or explain)
"**Reliability** — I owned on-call…" (markdown / long dash)

GOOD pattern (structure only — write fresh words for THIS job and THIS profile):
"Most of my recent work was reliability tooling for production systems. [Company]'s [one duty from JD] matches what I want next."

GOOD compound pattern:
"Yes. I owned on-call and reduced incident time on a production API."

CONTENT:
1. Facts only from GENERATED RESUME, WORK HISTORY, and PROFILE. Aim with the JOB DESCRIPTION.
2. Do NOT invent employers, degrees, tools, years, clearances, or citizenship. Never invent Google, Meta, Amazon, Apple, Microsoft, Netflix, Uber, Airbnb, or any employer not listed under ALLOWED EMPLOYERS.
3. If a company is not in ALLOWED EMPLOYERS, do not write its name — describe the work without naming a fake employer.
4. Do NOT answer salary / pay; those are filled separately.
5. EEO demographics (gender, disability, veteran, race/ethnicity) → return "" (filled from profile elsewhere). Work authorization, sponsorship, prior employer at company, over-18, relocate, how-heard, years of experience → answer from PROFILE facts as Yes/No or an exact OPTIONS string when listed.
6. Fresh wording every time. Never reuse another application's or another profile's phrasing.
7. Ban: "I am drawn to", "particularly impressed", "leverage", "cutting-edge", "passionate about", "seamless", "thrilled", "as a [title] with experience in", "skills align", "opportunity to contribute", "dynamic team", "excited about the opportunity", "in today's fast-paced", "I am a [title] with", long dashes, and markdown/bold.
8. If ANSWER STYLE is provided, match brevity/tone only.
9. Non-empty answers for every id except fixed-profile skips (""). For OPTIONS questions, non-empty means an exact option string.
10. Return ONLY valid JSON: {"answers":[{"id":"...","answer":"..."}]}`;

    let playbookBlock = '';
    try {
        if (userId) {
            const { getPlaybookForAnswers } = require('./bidInsightsService');
            const { promptBlock } = getPlaybookForAnswers({
                userId,
                profileId: profile?.id,
                jobRole,
                companyName
            });
            playbookBlock = promptBlock || '';
        }
    } catch (err) {
        console.warn('[answers] playbook load skipped:', err.message);
    }

    const buildUserPrompt = (questionList, { missingOnly = false } = {}) => `COMPANY: ${companyName || 'Unknown'}
ROLE: ${jobRole || 'Unknown'}

Write professional human answers for ${companyName || 'this company'} / ${jobRole || 'this role'}.
For interest/"why" questions: name something specific from THIS JD and tie it to the resume. No skill laundry lists.
${missingOnly ? '\nThese ids were missing; return a short non-empty answer for each (unless fixed-profile skip).\n' : ''}
PROFILE:
${profileBlock || '(none)'}

${allowedEmployerBlock}

JOB DESCRIPTION (excerpt):
${String(jobDescription || '').slice(0, 3500)}

GENERATED RESUME (text):
${resumeText || '(none)'}
${playbookBlock && !bidderMode ? `\nANSWER STYLE (tone only; new content for this job):\n${playbookBlock}\n` : ''}
${promptExtras ? `\n${promptExtras}\n` : ''}
QUESTIONS (answer ALL ids):
${JSON.stringify(questionList, null, 2)}`;

    let provider = getAnswersProviderConfig();
    const answersOnGroq = provider.provider === 'groq';
    // Prefer MiniMax highspeed only when answers actually run on MiniMax
    // (ANSWERS_PROVIDER=minimax override). Autofill default is Groq-only.
    if (provider.provider === 'minimax' && !/highspeed/i.test(String(provider.model || ''))) {
        try {
            provider = getProviderConfig('minimax', { model: 'MiniMax-M2.7-highspeed' });
        } catch (_) { /* keep default */ }
    }
    const answersMaxTokens = (() => {
        const base = /highspeed/i.test(String(provider.model || ''))
            ? 1200
            : (provider.provider === 'minimax' || /reasoner|r1/i.test(String(provider.model || '')) ? 2200 : 900);
        const groqBase = provider.provider === 'groq' ? 1400 : base;
        const scaled = Math.min(3200, groqBase + toAnswer.length * 180);
        if (bidderMode) {
            return Math.min(1600, Math.max(700, 450 + toAnswer.length * 70));
        }
        return scaled;
    })();
    const postAnswers = async (cfg, questionList, opts) => axios.post(cfg.apiUrl, {
        model: cfg.model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserPrompt(questionList, opts) }
        ],
        max_tokens: answersMaxTokens,
        temperature: 0.4
    }, {
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json'
        },
        timeout: cfg.timeoutMs || (cfg.provider === 'local' ? 55000 : 55000)
    });

    function trackAnswersUsage(response, cfg) {
        try {
            const { recordAiResponse, currentUsageContext } = require('./aiUsageService');
            const ctx = currentUsageContext();
            const kind = bidderMode ? 'bidder' : (ctx.kind || 'answers');
            recordAiResponse(response, {
                provider: cfg?.provider || provider.provider,
                model: cfg?.model || provider.model,
                kind,
                userId: userId || ctx.userId,
                profileId: profile?.id || ctx.profileId,
                keySlot: cfg?.groq_key_slot || cfg?.minimax_key_slot || null
            });
        } catch (_) { /* ignore */ }
    }

    /**
     * MiniMax first (rotate Key 1/2 on quota). Any MiniMax failure
     * (timeout, 401, 413, 5xx, Akamai) → Groq. Groq rotates on quota/401.
     */
    async function runWithQuotaFallback(questionList, opts) {
        const triedKeys = new Set();
        let lastErr = null;
        let triedGroqRescue = false;
        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                if (provider?.apiKey) triedKeys.add(provider.apiKey);
                const response = await postAnswers(provider, questionList, opts);
                trackAnswersUsage(response, provider);
                return response;
            } catch (err) {
                lastErr = err;
                err.upstreamStatus = err.response?.status;
                err.upstreamMessage = err.response?.data?.error?.message
                    || err.response?.data?.base_resp?.status_msg
                    || err.message;

                if (provider.provider === 'minimax') {
                    const alt = getAlternateMinimaxConfig(provider.minimax_key_slot, {
                        model: provider.model
                    });
                    if (alt?.apiKey && !triedKeys.has(alt.apiKey)) {
                        console.warn(
                            `[answers] MiniMax Key ${provider.minimax_key_slot} failed ` +
                            `(${err.upstreamStatus || err.code || 'error'}); ` +
                            `retrying with Key ${alt.minimax_key_slot}`
                        );
                        try { promoteMinimaxSlot(alt.minimax_key_slot); } catch (_) { /* ignore */ }
                        provider = alt;
                        continue;
                    }
                }

                if (provider.provider === 'minimax' && !triedGroqRescue) {
                    const groq = getAnswersGroqRescueConfig();
                    if (groq?.apiKey && !triedKeys.has(groq.apiKey)) {
                        console.warn(
                            `[answers] MiniMax not working (${err.upstreamStatus || err.code || err.message}); ` +
                            `autofill/bidder rescuing with Groq Key ${groq.groq_key_slot}`
                        );
                        triedGroqRescue = true;
                        provider = groq;
                        continue;
                    }
                }

                if (
                    provider.provider === 'groq'
                    && (isGroqQuotaError(err) || isGroqAuthError(err) || isMinimaxUnavailableError(err))
                ) {
                    const alt = getAlternateGroqConfig(provider.groq_key_slot);
                    if (alt?.apiKey && !triedKeys.has(alt.apiKey)) {
                        console.warn(
                            `[answers] Groq Key ${provider.groq_key_slot} failed; ` +
                            `retrying with Key ${alt.groq_key_slot}`
                        );
                        try { promoteGroqSlot(alt.groq_key_slot); } catch (_) { /* ignore */ }
                        provider = alt;
                        continue;
                    }
                }
                throw err;
            }
        }
        throw lastErr || new Error('Answers provider failed after retries');
    }

    /** Force a one-shot Groq call for questions MiniMax left empty. */
    async function runGroqRescueForMissing(questionList, opts) {
        const groq = getAnswersGroqRescueConfig();
        if (!groq?.apiKey || !questionList?.length) return null;
        const prev = provider;
        provider = groq;
        try {
            console.warn(
                `[answers] Groq rescue for ${questionList.length} question(s) MiniMax left empty`
            );
            return await runWithQuotaFallback(questionList, opts);
        } finally {
            provider = prev;
        }
    }

    function groqAnswerCheckEnabled() {
        const v = String(process.env.ANSWERS_GROQ_CHECK || '1').trim().toLowerCase();
        return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
    }

    /** Heuristic: MiniMax draft looks wrong / too thin for this question → Groq should check. */
    function needsGroqAnswerCheck(q, answer) {
        const a = String(answer || '').trim();
        const label = String(q?.label || '');
        if (!a) return true;
        if (Array.isArray(q.options) && q.options.length) {
            return !snapAnswerToOptions(a, q.options);
        }
        const isOpen = /\b(describe|explain|why|tell us|provide|example|experience|motivat|interest|elaborate|detail)\b/i.test(label)
            || (label.length > 55 && /\?/.test(label));
        const words = a.split(/\s+/).filter(Boolean).length;
        if (isOpen && words < 6) return true;
        if (looksLikeCompoundQuestion(label) && words < 8) return true;
        if (/^(yes|no)\.?$/i.test(a) && isOpen) return true;
        if (/^(n\/?a|none|nil|idk|asdf|test|tbd)\.?$/i.test(a) && isOpen) return true;
        return false;
    }

    /**
     * Groq QA pass: verify MiniMax drafts; fix only bad ones so submit is safer.
     */
    async function runGroqAnswerCheck(draftItems) {
        const groq = getAnswersGroqRescueConfig();
        if (!groq?.apiKey || !draftItems?.length) return new Map();

        const checkSystem = `You QA job-application form answers written by another model.
For each item, check whether "draft" correctly answers the question for this candidate.
Rules:
- If draft is good enough, set ok=true and return the same answer (or a tiny cleanup).
- If draft is wrong, empty, off-topic, only Yes/No on a describe/explain question, does not match OPTIONS exactly, or skips half of a compound question, set ok=false and write a fixed answer.
- OPTIONS listed: copy ONE option EXACTLY (same spelling).
- Open text: 1–2 short human sentences (bidder-style), concrete, no essay.
- Never invent employers not in the candidate context.
Return JSON only: {"reviews":[{"id":"q1","ok":true,"answer":"..."},{"id":"q2","ok":false,"answer":"..."}]}`;

        const userPayload = {
            company: companyName || '',
            role: jobRole || '',
            candidate: profileBlock.slice(0, 1500),
            items: draftItems.map((it) => ({
                id: it.id,
                question: it.label,
                options: it.options?.length ? it.options : undefined,
                draft: it.draft
            }))
        };

        const prev = provider;
        provider = groq;
        try {
            console.warn(`[answers] Groq checking ${draftItems.length} MiniMax answer(s)`);
            const response = await axios.post(groq.apiUrl, {
                model: groq.model,
                messages: [
                    { role: 'system', content: checkSystem },
                    {
                        role: 'user',
                        content: `Review and fix only bad drafts.\n${JSON.stringify(userPayload, null, 2)}`
                    }
                ],
                max_tokens: Math.min(2000, 400 + draftItems.length * 120),
                temperature: 0.2
            }, {
                headers: {
                    Authorization: `Bearer ${groq.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: groq.timeoutMs || 45000
            });
            trackAnswersUsage(response, groq);
            const raw = stripReasoning(String(response.data?.choices?.[0]?.message?.content || ''));
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return new Map();
            let parsed;
            try {
                parsed = JSON.parse(jsonMatch[0]);
            } catch (_) {
                try {
                    parsed = JSON.parse(repairAnswersJson(jsonMatch[0]));
                } catch (__) {
                    return new Map();
                }
            }
            const out = new Map();
            const rows = Array.isArray(parsed?.reviews)
                ? parsed.reviews
                : (Array.isArray(parsed?.answers) ? parsed.answers : []);
            for (const row of rows) {
                if (!row || row.id == null) continue;
                const text = String(row.answer ?? '').trim();
                if (!text) continue;
                const ok = row.ok === true || row.ok === 'true';
                const draft = draftItems.find((d) => String(d.id) === String(row.id))?.draft || '';
                if (!ok || text !== draft) {
                    let polished = polishWrittenAnswer(text, {
                        companyName,
                        jobRole,
                        shortForm: true
                    });
                    const qMeta = toAnswer.find((q) => String(q.id) === String(row.id));
                    polished = rejectBareYesNoEssay(qMeta?.label || '', polished);
                    polished = rejectBareStateEssay(qMeta?.label || '', polished);
                    polished = stripInventedEmployers(polished, allowedEmployers);
                    if (Array.isArray(qMeta?.options) && qMeta.options.length) {
                        const snapped = snapAnswerToOptions(polished, qMeta.options);
                        if (snapped) polished = snapped;
                    }
                    if (polished) out.set(String(row.id), polished);
                }
            }
            if (out.size) {
                console.warn(`[answers] Groq check fixed ${out.size}/${draftItems.length} answer(s)`);
            }
            return out;
        } catch (err) {
            console.warn('[answers] Groq answer check failed:', err.message);
            return new Map();
        } finally {
            provider = prev;
        }
    }

    function repairAnswersJson(raw) {
        let s = String(raw || '').trim();
        // Prefer the answers array object if present
        const objMatch = s.match(/\{[\s\S]*"answers"\s*:\s*\[[\s\S]*/);
        if (objMatch) s = objMatch[0];
        // Truncate trailing junk after last plausible close
        s = s.replace(/```/g, '').trim();
        // Common local-model flaws
        s = s.replace(/,\s*([}\]])/g, '$1');
        // If truncated mid-string, close quotes/brackets best-effort
        const quoteCount = (s.match(/"/g) || []).length;
        if (quoteCount % 2 === 1) s += '"';
        const openBraces = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
        const openBrackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
        if (openBrackets > 0) s += ']'.repeat(openBrackets);
        if (openBraces > 0) s += '}'.repeat(openBraces);
        return s;
    }

    function extractAnswersLoose(raw) {
        const byId = new Map();
        const re = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"answer"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}/g;
        let m;
        while ((m = re.exec(String(raw || ''))) !== null) {
            const text = m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
            if (text) byId.set(m[1], text);
        }
        // Also allow answer-first ordering
        const re2 = /\{\s*"answer"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"id"\s*:\s*"([^"]+)"\s*\}/g;
        while ((m = re2.exec(String(raw || ''))) !== null) {
            const text = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
            if (text) byId.set(m[2], text);
        }
        return byId;
    }

    /** Reject bare Yes/No on essay-style prompts (model often answers "Yes" to REST/GraphQL). */
    function rejectBareYesNoEssay(questionLabel, answer) {
        const a = String(answer || '').trim();
        if (!/^(yes|no)\.?$/i.test(a)) return answer;
        const q = String(questionLabel || '');
        if (looksLikeCompoundQuestion(q) && /\b(describe|provide|explain|example|detail|elaborate)\b/i.test(q)) {
            return '';
        }
        if (/\b(describe|provide|explain|example|which|what|how|briefly|including|experience with)\b/i.test(q)) {
            return '';
        }
        if (q.length > 80 && /\?/.test(q) && !/\b(authorized|sponsor|agree|confirm|ever worked|able to)\b/i.test(q)) {
            return '';
        }
        return answer;
    }

    /** Reject lone US state names on rationale / evidence / grades questions (e.g. "Texas"). */
    function rejectBareStateEssay(questionLabel, answer) {
        const a = String(answer || '').trim();
        if (!/^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i.test(a)) {
            return answer;
        }
        const q = String(questionLabel || '').toLowerCase();
        if (/rationale|evidence|high school|degree result|grading|performance|score|gpa|grade|university/.test(q)) {
            return '';
        }
        // Always drop lone-state answers shorter than a real sentence.
        return '';
    }

    function parseAnswerMap(response) {
        const rawFull = String(response.data?.choices?.[0]?.message?.content || '');
        const raw = stripReasoning(rawFull);
        if (!rawFull.trim()) {
            throw new Error('Model returned empty content');
        }
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const candidates = [];
        if (jsonMatch) candidates.push(jsonMatch[0]);
        candidates.push(repairAnswersJson(raw));
        if (jsonMatch) candidates.push(repairAnswersJson(jsonMatch[0]));

        let parsedEmpty = false;
        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate);
                if (!parsed || !Array.isArray(parsed.answers)) continue;
                const map = new Map();
                for (const row of parsed.answers || []) {
                    if (!row || row.id == null) continue;
                    const qMeta = toAnswer.find((q) => String(q.id) === String(row.id));
                    let text = polishWrittenAnswer(String(row.answer ?? '').trim(), {
                        companyName,
                        jobRole,
                        shortForm: true
                    });
                    text = rejectBareYesNoEssay(qMeta?.label || '', text);
                    text = rejectBareStateEssay(qMeta?.label || '', text);
                    text = stripInventedEmployers(text, allowedEmployers);
                    if (text) map.set(String(row.id), text);
                }
                if (map.size) return map;
                // Valid JSON but all empty (common when resume missing / model followed "return \"\"")
                parsedEmpty = true;
            } catch (_) { /* try next */ }
        }

        const loose = extractAnswersLoose(raw);
        if (loose.size) {
            console.warn(`[answers] recovered ${loose.size} answer(s) via loose extract`);
            for (const [id, text] of [...loose.entries()]) {
                const qMeta = toAnswer.find((q) => String(q.id) === String(id));
                let polished = polishWrittenAnswer(text, {
                    companyName,
                    jobRole,
                    shortForm: true
                });
                polished = rejectBareYesNoEssay(qMeta?.label || '', polished);
                polished = rejectBareStateEssay(qMeta?.label || '', polished);
                polished = stripInventedEmployers(polished, allowedEmployers);
                if (polished) loose.set(id, polished);
                else loose.delete(id);
            }
            if (loose.size) return loose;
        }
        if (parsedEmpty) {
            return new Map(); // caller may apply fallbacks — do not retry endlessly
        }
        console.warn(
            `[answers] parse failed · finish=${response.data?.choices?.[0]?.finish_reason || '?'} · `
            + `raw=${rawFull.length}b stripped=${raw.length}b · head=${JSON.stringify(raw.slice(0, 180))}`
        );
        throw new Error('Failed to parse answers JSON from model output');
    }

    function fallbackWrittenAnswer(q) {
        const opts = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
        if (opts.length) {
            // Heuristic pick when the model left an options question empty.
            const label = String(q.label || '').toLowerCase();
            const blob = `${resumeText}\n${workExpText}\n${profile.skills || ''}`.toLowerCase();
            if (/language|golang|python|java|ruby/.test(label)) {
                const langs = ['golang', 'go', 'python', 'java', 'ruby'];
                for (const lang of langs) {
                    if (!blob.includes(lang === 'golang' ? 'go' : lang) && !blob.includes(lang)) continue;
                    const hit = opts.find((o) => new RegExp(lang === 'go' ? '\\bgo(lang)?\\b' : `\\b${lang}\\b`, 'i').test(o));
                    if (hit) return hit;
                }
            }
            if (/year|experience/.test(label)) {
                const yoeLabel = yearsExperienceFillValueServer(profile)
                    || String(profile.years_of_experience || '').trim()
                    || '10+';
                const snapped = pickBestYearsOption(yoeLabel, opts)
                    || snapAnswerToOptions(yoeLabel, opts);
                if (snapped) return snapped;
                // Never fall through to opts[0] (that picked "0-2 years" for senior profiles).
                return '';
            }
            if (/\bdisabilit/i.test(label)) {
                const noOpt = opts.find((o) =>
                    /do not have|don'?t have|have not had|no disability|^no\b/i.test(o)
                    && !( /^yes\b/i.test(o) && /have a disability/i.test(o))
                );
                if (noOpt) return noOpt;
                return '';
            }
            if (/how many companies|companies have you worked|number of companies/.test(label)) {
                const n = String(Math.max(1, Math.min(8, Number(profile.employer_count) || 2)));
                const snapped = snapAnswerToOptions(n, opts);
                if (snapped) return snapped;
            }
            if (/high[\s_-]*school|mathematics|native language/.test(label) && /perform|grade/.test(label)) {
                const snapped = snapAnswerToOptions('Above average', opts)
                    || snapAnswerToOptions('Top 25%', opts)
                    || snapAnswerToOptions('Good', opts);
                if (snapped) return snapped;
            }
            const strong = opts.find((o) => /yes\s*[—–-].*multiple/i.test(o))
                || opts.find((o) => /yes\s*[—–-]/i.test(o) && /owned|production|at least/i.test(o))
                || opts.find((o) => /^(yes|y)$/i.test(o));
            if (strong && /own|api|backend|reliable|production|system|service/.test(label)) return strong;
            // Prefer agree on consent menus; otherwise first non-placeholder option.
            if (/agree|acknowledg|consent|plagiarism|own words|data protection|privacy/.test(label)) {
                const agree = snapAnswerToOptions('I agree', opts) || snapAnswerToOptions('Yes', opts);
                if (agree) return agree;
            }
            // Never default to first option for EEO / YoE / screening radios.
            if (/\b(disabilit|veteran|gender|race|ethnicity|hispanic|sponsor|authoriz|year|experience)\b/i.test(label)) {
                return '';
            }
            return opts.find((o) => !/^select/i.test(o) && !/^choose/i.test(o)) || opts[0];
        }
        const label = String(q.label || '').toLowerCase();
        const resume = resumeText || '';
        const github = profile.github_url || profile.website_url || '';
        if (/\b(open[\s_-]*source|maintainer|sustained\s+contributor|oss\b)\b/.test(label)) {
            if (/\b(open[\s_-]*source|github|maintainer|contributor|pull request|merged)\b/i.test(resume)) {
                return 'I have been a sustained open-source contributor, with ongoing commits, reviews, and maintainer-style ownership on projects described on my resume.';
            }
            if (github) {
                return `I contribute regularly on GitHub (${github}), including sustained commits and reviews rather than one-off patches.`;
            }
            return 'I contribute to open-source projects with sustained commits and code reviews, focused on production-quality tooling rather than one-off patches.';
        }
        if (/\b(rest|graphql|oauth|jwt|authentication|authorization)\b/.test(label)) {
            return 'I have built production APIs with REST and GraphQL, using JWT and OAuth2 for auth, with role checks on protected routes and services.';
        }
        if (/\b(react|vue|front[\s_-]*end framework)\b/.test(label)) {
            const co = allowedEmployers.find((e) => /whatnot/i.test(e)) || allowedEmployers[0];
            if (co) {
                return `React is the framework I've used most in production. At ${co}, I partnered on frontend product work across components, state, and API integration.`;
            }
            return 'React is the framework I have used most in production, owning feature work across components, state, and API integration on shipped product surfaces.';
        }
        if (/\b(php|laravel|eloquent|queues|events)\b/.test(label)) {
            return 'I have production PHP/Laravel experience including queues, events, and complex Eloquent models for multi-tenant workflows.';
        }
        if (/\b(aws|amazon web services|glue|lambda|step functions|mwaa|airflow|s3|dynamodb|ecs|eks)\b/.test(label)) {
            const skillHit = String(profile.skills || '')
                .split(/[,;|]/)
                .map((s) => s.trim())
                .filter((s) => /aws|lambda|glue|airflow|s3|dynamo|step|cloud/i.test(s))
                .slice(0, 4)
                .join(', ');
            const yoe = String(profile.years_of_experience || '').replace(/\D/g, '');
            return (
                `I have hands-on AWS experience${yoe ? ` across ${yoe}+ years` : ''}, `
                + `most proficient with ${skillHit || 'Lambda, S3, and data/ETL services'}. `
                + 'I have built and operated serverless and scheduled data workflows in production, '
                + 'and I am comfortable with Step Functions / Airflow-style orchestration where needed.'
            );
        }
        if (/\b(why|interest|motivat|what draws|excited about)\b/.test(label) && (companyName || jobRole)) {
            const who = companyName || 'this team';
            const role = jobRole || 'this role';
            return `I am interested in ${who}'s ${role} because it matches the production work on my resume, and I want to apply that experience here.`;
        }
        return '';
    }

    const groqNewTypeIds = new Set();
    const newTypeQs = toAnswer.filter((q) => q.new_type);
    const knownQs = toAnswer.filter((q) => !q.new_type);

    let byId = new Map();

    if (answersOnGroq) {
        // Autofill default: one Groq batch for all written questions (rotate keys on quota).
        if (toAnswer.length) {
            try {
                console.warn(
                    `[answers] Groq-only autofill for ${toAnswer.length} question(s)`
                    + (newTypeQs.length ? ` (${newTypeQs.length} new-type)` : '')
                );
                const response = await runWithQuotaFallback(toAnswer, { missingOnly: false });
                byId = parseAnswerMap(response);
                for (const q of newTypeQs) {
                    if (byId.get(q.id)) groqNewTypeIds.add(q.id);
                }
            } catch (err) {
                console.warn('[answers] Groq primary written-answer call failed:', err.message);
            }
        }
        const missing = toAnswer.filter((q) => !byId.get(q.id));
        if (missing.length) {
            try {
                console.warn(`[answers] Groq retry for ${missing.length} empty answer(s)`);
                const retryResp = await runWithQuotaFallback(missing, { missingOnly: true });
                const retryMap = parseAnswerMap(retryResp);
                for (const [id, text] of retryMap) byId.set(id, text);
            } catch (err) {
                console.warn('[answers] Groq missing-answer retry failed:', err.message);
            }
        }
        // Skip MiniMax QA pass — drafts already came from Groq.
    } else {
        if (knownQs.length) {
            try {
                const response = await runWithQuotaFallback(knownQs, { missingOnly: false });
                byId = parseAnswerMap(response);
            } catch (err) {
                console.warn('[answers] primary written-answer call failed:', err.message);
            }
        }

        // New / unclassified types go to Groq first (not MiniMax).
        if (newTypeQs.length) {
            try {
                const groqResp = await runGroqRescueForMissing(newTypeQs, { missingOnly: false });
                if (groqResp) {
                    const groqMap = parseAnswerMap(groqResp);
                    for (const [id, text] of groqMap) {
                        if (text) {
                            byId.set(id, text);
                            groqNewTypeIds.add(id);
                        }
                    }
                }
                console.warn(
                    `[answers] Groq answered ${groqNewTypeIds.size}/${newTypeQs.length} new-type question(s)`
                );
            } catch (err) {
                console.warn('[answers] Groq new-type batch failed:', err.message);
            }
            const groqMissed = newTypeQs.filter((q) => !byId.get(q.id));
            if (groqMissed.length) {
                try {
                    const mmResp = await runWithQuotaFallback(groqMissed, { missingOnly: true });
                    const mmMap = parseAnswerMap(mmResp);
                    for (const [id, text] of mmMap) byId.set(id, text);
                } catch (err) {
                    console.warn('[answers] MiniMax fallback for new-type questions failed:', err.message);
                }
            }
        }

        const missing = toAnswer.filter((q) => !byId.get(q.id));
        // MiniMax left gaps → Groq rescue for remaining.
        if (missing.length) {
            const allMissing = missing.length === toAnswer.length;
            console.warn(
                `[answers] ${missing.length}/${toAnswer.length} written answer(s) empty` +
                (allMissing ? ' — MiniMax retry then Groq rescue' : ' — Groq rescue for remaining')
            );
            if (allMissing) {
                try {
                    const retryResp = await runWithQuotaFallback(missing, { missingOnly: true });
                    const retryMap = parseAnswerMap(retryResp);
                    for (const [id, text] of retryMap) byId.set(id, text);
                } catch (err) {
                    console.warn('[answers] MiniMax missing-answer retry failed:', err.message);
                }
            }
            const stillMissing = toAnswer.filter((q) => !byId.get(q.id));
            if (stillMissing.length) {
                try {
                    const rescueResp = await runGroqRescueForMissing(stillMissing, { missingOnly: true });
                    if (rescueResp) {
                        const rescueMap = parseAnswerMap(rescueResp);
                        for (const [id, text] of rescueMap) byId.set(id, text);
                    }
                } catch (err) {
                    console.warn('[answers] Groq rescue failed:', err.message);
                }
            }
        }

        // Groq QA: check MiniMax drafts that look weak / wrong before fill+submit.
        if (groqAnswerCheckEnabled()) {
            const toCheck = toAnswer
                .map((q) => ({
                    id: q.id,
                    label: q.label,
                    options: q.options,
                    draft: byId.get(q.id) || ''
                }))
                .filter((it) => !groqNewTypeIds.has(it.id) && needsGroqAnswerCheck(
                    { label: it.label, options: it.options },
                    it.draft
                ));
            if (toCheck.length) {
                const fixed = await runGroqAnswerCheck(toCheck);
                for (const [id, text] of fixed) byId.set(id, text);
            }
        }
    }

    // Resume/profile fallbacks for anything still empty (no more per-id LLM calls).
    for (const q of toAnswer) {
        let cur = byId.get(q.id);
        if (cur) {
            const cleaned = rejectBareStateEssay(q.label, rejectBareYesNoEssay(q.label, cur));
            if (!cleaned) {
                byId.delete(q.id);
                cur = '';
            } else if (cleaned !== cur) {
                byId.set(q.id, cleaned);
            }
        }
        if (byId.get(q.id)) continue;
        const fb = fallbackWrittenAnswer(q);
        if (fb) {
            byId.set(q.id, fb);
            console.warn(`[answers] used fallback for ${q.id}`);
        } else {
            skipped.push({
                id: q.id,
                label: q.label,
                reason: 'written_answer_empty_after_retry'
            });
        }
    }

    // Drop empty written rows so autofill does not overwrite with blanks
    const recentUnique = loadRecentUniqueAnswers(userId, 15);
    const uniqueGateOff = String(process.env.UNIQUE_SIM_GATE || '1').trim() === '0';

    const writtenAnswers = toAnswer
        .filter((q) => byId.get(q.id))
        .map((q) => {
            let answer = stripInventedEmployers(byId.get(q.id), allowedEmployers);
            // Final safety: sponsorship / prior-employer / sanctioned never leave as AI Yes.
            const hay = String(q.label || '');
            if (FIXED_FIELD_RE.disability_status?.test(hay)
                || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(hay)) {
                answer = 'No, I do not have a disability';
            } else if (FIXED_CONSTANT_RE.previous_employer_no?.test(hay)
                || FIXED_CONSTANT_RE.sanctioned_countries_no?.test(hay)) {
                answer = 'No';
            } else if (
                FIXED_FIELD_RE.requires_sponsorship?.test(hay)
                && !(
                    /\b(authorized|authorised|eligible)\b/i.test(hay)
                    && /\bwithout\s+(?:visa\s+)?sponsorship\b/i.test(hay)
                )
            ) {
                answer = fixedProfileValue('requires_sponsorship', profile) || 'No';
            }
            if (Array.isArray(q.options) && q.options.length) {
                // Never snap disability No onto a Yes option.
                const isDis = FIXED_FIELD_RE.disability_status?.test(hay)
                    || /\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(hay);
                if (isDis) {
                    const noOpt = q.options.map((o) => (typeof o === 'string' ? o : (o?.label || o?.value || '')))
                        .find((t) => /do not have|don'?t have|have not had|no disability|^no\b/i.test(t)
                            && !/^yes\b/i.test(t));
                    answer = noOpt || 'No, I do not have a disability';
                } else if (
                    (FIXED_FIELD_RE.years_of_experience?.test(hay) || (/\byears?\b/i.test(hay) && /\bexperience\b/i.test(hay)))
                    && q.options.some((o) => parseYearsOptionRange(typeof o === 'string' ? o : (o?.label || o?.value || '')))
                ) {
                    // Always map from profile years — LLM often returns the first band (0-2).
                    const yoeLabel = yearsExperienceFillValueServer(profile)
                        || String(profile.years_of_experience || '').trim()
                        || '10+';
                    const picked = pickBestYearsOption(yoeLabel, q.options)
                        || snapAnswerToOptions(yoeLabel, q.options);
                    if (picked) answer = picked;
                    else {
                        const snapped = snapAnswerToOptions(answer, q.options);
                        if (snapped) answer = snapped;
                    }
                } else {
                    const snapped = snapAnswerToOptions(answer, q.options);
                    if (snapped) answer = snapped;
                }
            }

            const lane = q.lane || classifyAnswerLane(q).lane || 'written';
            const meta = {
                id: q.id,
                label: q.label,
                answer,
                answer_type: 'written',
                source: groqNewTypeIds.has(q.id) ? 'groq_new_type' : 'api',
                match_source: groqNewTypeIds.has(q.id) ? 'llm_groq_new_type' : 'llm',
                new_type: !!q.new_type,
                lane,
                kind: q.kind || undefined,
                unique_subtype: q.unique_subtype || undefined,
                options: q.options?.length ? q.options : undefined
            };

            if (lane === 'unique' && !uniqueGateOff) {
                const maxLen = Number(q.maxLength || q.maxlength || 0) || 0;
                const enforced = enforceUniqueAnswer(answer, recentUnique, { maxLength: maxLen });
                meta.answer = enforced.text;
                meta.unique_similarity = enforced.unique_similarity;
                meta.unique_regenerated = enforced.unique_regenerated;
                meta.truncated = enforced.truncated || undefined;
                if (enforced.unique_regenerated) meta.failure_code = 'unique_regen';
                if (enforced.text) recentUnique.unshift(enforced.text);
            }

            return meta;
        })
        .filter((a) => String(a.answer || '').trim());

    const answers = [
        ...salaryAnswers,
        ...fixedAnswers,
        ...memoryAnswers,
        ...writtenAnswers
    ];

    return {
        answers,
        skipped,
        provider: provider.provider,
        model: provider.model,
        written_count: toAnswer.length,
        written_filled: writtenAnswers.length,
        studying: studyingOn,
        memory_hits: memoryAnswers.length
    };
}

module.exports = {
    generateApplicationAnswers,
    isSalaryQuestion,
    isSalaryComfortYesNo,
    snapAnswerToOptions,
    polishWrittenAnswer,
    looksLikeCompoundQuestion,
    classifyAnswerLane,
    isNewQuestionType,
    enforceUniqueAnswer,
    textSimilarity,
    fixedConstantKind,
    fixedProfileKind,
    FIXED_FIELD_RE,
    FIXED_CONSTANT_RE,
    FIXED_CONSTANT_VALUE,
    SALARY_RE
};
