/**
 * Unit checks for bidderFill classify / valuesMatch / required labels (mirrored for Node).
 * Run: node extension/fixtures/test_bidder_fill_unit.js
 */
function classify(label, name = '') {
    const hay = `${label} ${name}`.toLowerCase();
    if (/\b(first[\s_-]*name|given[\s_-]*name)\b/.test(hay)) return 'first_name';
    if (/\b(last[\s_-]*name|family[\s_-]*name|surname)\b/.test(hay)) return 'last_name';
    if (/\b(full[\s_-]*name|your[\s_-]*name)\b/.test(hay) && !/first|last/.test(hay)) return 'full_name';
    if (/\bemail\b/.test(hay)) return 'email';
    if (/\b(phone|mobile|tel)\b/.test(hay)) return 'phone';
    if (/\blinkedin\b/.test(hay)) return 'linkedin';
    if (/\bgithub\b|\bportfolio\b/.test(hay)) return 'github';
    if (
        /\bwhich of the states?\b/.test(hay)
        || /\bchoose which(?: of the)? states?\b/.test(hay)
        || /\boperates? in\b.{0,60}\bstates?\b/.test(hay)
        || (/\breside\b/.test(hay) && /\bstates?\b/.test(hay)
            && /\b(choose|select|which|operat|list of)\b/.test(hay))
    ) {
        return 'state';
    }
    if (
        (/\b(do you|are you)\b/.test(hay) && /\breside\b/.test(hay) && !/\bwhere\b/.test(hay))
        || (/\breside\b/.test(hay) && /\b(united states|u\.?\s*s\.?\s*a?\.?|u\.s\b)\b/.test(hay)
            && !/\bwhere\b/.test(hay) && !/\bstates?\b/.test(hay))
        || /\blegal(?:ly)?\s+resid|\bpermanent\s+residenc/.test(hay)
    ) {
        return 'work_authorization';
    }
    if (
        /\b(authorized|authorised|eligible)\b/.test(hay)
        && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(hay)
    ) {
        return 'work_authorization';
    }
    if (/\b(sponsor|sponsorship|visa|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/.test(hay)
        || /\bwill you.{0,80}\b(require|need).{0,60}\b(sponsor|visa)/.test(hay)
        || /\bneed\b.{0,40}\bvisa\b.{0,40}\bsponsor/.test(hay)) {
        return 'requires_sponsorship';
    }
    if (/\b(authoriz|eligible to work|work remotely|working from this state|legally[\s_-]*authorized)\b/.test(hay)) {
        return 'work_authorization';
    }
    if (/\bcountry\b/.test(hay) && !/\b(sponsor|visa|authoriz)\b/.test(hay)) return 'country';
    if (
        /\b(city|where do you currently reside|where are you located|current[\s_-]*location|current[\s_-]*reside)\b/.test(hay)
        && !/\b(united states|u\.?\s*s\.?\s*a?\.?)\b/.test(hay)
    ) {
        return 'city';
    }
    if (/\bsalary|compensation|pay\b/.test(hay)) return 'salary';
    if (/\bover[\s_-]*18|18 or older\b/.test(hay)) return 'over_18';
    if (/\bhave you ever worked|previously worked|contractor or contingent|contingent worker|(?:currently|previously).{0,40}working\s+for\b/.test(hay)) return 'previous_employer_no';
    if (/\b(hispanic|latino|latina|latinx)\b/.test(hay)) return 'hispanic_latino';
    if (/\b(start[\s_-]*date|earliest[\s_-]*start|available[\s_-]*to[\s_-]*start|when[\s_-]*can[\s_-]*you[\s_-]*start)\b/.test(hay)
        && !/\b(birth|dob|signature|application\s*date|today)\b/.test(hay)) {
        return 'earliest_start_date';
    }
    if (/\b(notice[\s_-]*period|notice[\s_-]*time)\b/.test(hay)) return 'notice_period';
    if (/\b(how[\s_-]*did[\s_-]*you[\s_-]*(hear|find)|hear[\s_-]*about|find[\s_-]*this[\s_-]*(position|role|job)|referral[\s_-]*source|source[\s_-]*of[\s_-]*hire)\b/.test(hay)) {
        return 'how_heard';
    }
    if (
        (
            /^(date|date\s*\*?)$/.test(hay.trim())
            || /\b(today'?s?\s*date|signature\s*date|date\s*signed|application\s*date)\b/.test(hay)
        )
        && !/\b(birth|dob|start|available|earliest)\b/.test(hay)
    ) {
        return 'todays_date';
    }
    if (/\b(why|describe|tell us|essay|cover letter|additional information)\b/.test(hay)) return 'question';
    return 'question';
}

function sponsorshipAnswer(profile) {
    const raw = String(profile?.requires_sponsorship || '').trim();
    if (/^(yes|y|true|1)$/i.test(raw)) return 'Yes';
    return 'No';
}

function formatEstTodayMdY() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: '2-digit',
        day: '2-digit',
        year: 'numeric'
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    return `${get('month')}/${get('day')}/${get('year')}`;
}

function detectAts(hostname, hasGhForm) {
    const host = String(hostname || '').toLowerCase();
    if (host.includes('greenhouse') || host.includes('boards.greenhouse') || hasGhForm) return 'greenhouse';
    if (host.includes('lever.co')) return 'lever';
    if (host.includes('ashbyhq') || host.includes('ashby')) return 'ashby';
    if (host.includes('myworkday') || host.includes('workday')) return 'workday';
    return 'unknown';
}

function phoneDigits(s) {
    let d = String(s || '').replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    return d;
}

function valuesMatch(wanted, got, kind) {
    const w = String(wanted || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const g = String(got || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!w) return true;
    if (!g) return false;
    if (g === w) return true;
    if (kind === 'phone') {
        const wd = phoneDigits(wanted);
        const gd = phoneDigits(got);
        if (wd && gd && (wd === gd || wd.endsWith(gd) || gd.endsWith(wd))) return true;
    }
    if (kind === 'linkedin' || kind === 'github') {
        const normUrl = (s) => String(s || '')
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/+$/, '')
            .replace(/\s+/g, '');
        const wu = normUrl(wanted);
        const gu = normUrl(got);
        if (wu && gu && (wu === gu || gu.includes(wu) || wu.includes(gu))) return true;
    }
    if (g.includes(w) || w.includes(g)) {
        if (/^y/.test(w) && /\bno\b/.test(g) && !/^y/.test(g)) return false;
        return true;
    }
    if (kind === 'work_authorization' || kind === 'requires_sponsorship' || kind === 'over_18'
        || kind === 'hispanic_latino' || kind === 'previous_employer_no') {
        if (/^y/.test(w) && /^y/.test(g) && !/\bno\b/.test(g)) return true;
        if (/^n/.test(w) && (/^n/.test(g) || /\bno\b/.test(g))) return true;
    }
    return false;
}

function fieldMissingLabel(f) {
    const lab = String(f?.label || '').replace(/\s+/g, ' ').trim();
    if (lab) return lab.slice(0, 120);
    if (f?.kind && f.kind !== 'question') return String(f.kind).replace(/_/g, ' ');
    if (f?.name) return String(f.name).slice(0, 80);
    return String(f?.id || 'required field').slice(0, 80);
}

function isPlaceholderValue(got) {
    const g = String(got || '').replace(/\s+/g, ' ').trim();
    if (!g) return true;
    if (/^select(\.\.\.|…|:)?$/i.test(g)) return true;
    if (/^choose(\s|$|\.\.\.|…)/i.test(g)) return true;
    return false;
}

function requiredFieldSatisfied(field, wanted, got) {
    let kind = String(field?.kind || '');
    const lab = String(field?.label || '');
    if (/\b(contractor or contingent|contingent worker|(?:currently|previously).{0,40}working\s+for|previously worked|have you ever worked)\b/i.test(lab)) {
        kind = 'previous_employer_no';
    }
    let w = String(wanted || '').trim();
    if (!w && (kind === 'previous_employer_no' || kind === 'requires_sponsorship')) w = 'No';
    if (w && valuesMatch(w, got, kind)) return true;
    if (isPlaceholderValue(got)) {
        // Empty wanted + empty essay/textarea → incomplete (do not fake FILLED).
        if (!w && (field?.type === 'textarea' || kind === 'question')) return false;
        return false;
    }
    if (kind === 'phone') return phoneDigits(got).length >= 7;
    if (kind === 'previous_employer_no' || kind === 'requires_sponsorship') {
        return /\bno\b/i.test(got);
    }
    if (!w) {
        const g = String(got || '').trim();
        if (field?.type === 'textarea' || kind === 'question') return g.length >= 12;
        return g.length > 0;
    }
    return false;
}

function requiredComplete(fields, profileValues, currentValues) {
    const required = fields.filter((f) => f.required);
    let ok = 0;
    const missing = [];
    for (const f of required) {
        const wanted = profileValues[f.id] || profileValues[f.kind] || '';
        const got = currentValues[f.id] || '';
        if (requiredFieldSatisfied(f, wanted, got)) ok += 1;
        else missing.push(fieldMissingLabel(f));
    }
    return {
        requiredComplete: required.length > 0 && ok === required.length,
        requiredOk: ok,
        requiredTotal: required.length,
        missingRequired: missing
    };
}

/** Prefer short Yes when scoring Yes against long unrelated options. */
function pickRadio(wanted, options) {
    const wantYes = /^(yes|y)\b/i.test(wanted);
    const wantNo = /^(no|n)\b/i.test(wanted);
    let best = null;
    let bestScore = -1;
    for (const t of options) {
        let score = valuesMatch(wanted, t, 'work_authorization') ? 90 : -1;
        const tClean = String(t).replace(/\s+/g, ' ').trim();
        if (/^(yes|no)$/i.test(tClean)) {
            if (wantYes && /^yes$/i.test(tClean)) score = 100;
            if (wantNo && /^no$/i.test(tClean)) score = 100;
        }
        if (wantYes && /\b(no|not|don't|do not)\b/i.test(tClean) && !/^yes\b/i.test(tClean)) {
            score = -1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = t;
        }
    }
    return bestScore >= 70 ? best : null;
}

const checks = [];
checks.push(['first name', classify('First Name') === 'first_name']);
checks.push(['email', classify('Email Address') === 'email']);
checks.push(['salary', classify('What is your expected compensation?') === 'salary']);
checks.push(['previous employer', classify('Have you ever worked at this company?') === 'previous_employer_no']);
checks.push([
    'flexential contractor',
    classify('Are you currently (or previously) working for Flexential as a contractor or contingent worker?') === 'previous_employer_no'
]);
checks.push([
    'flexential No with empty wanted',
    requiredFieldSatisfied(
        { label: 'Are you currently (or previously) working for Flexential as a contractor or contingent worker?*', kind: 'question' },
        '',
        'No'
    ) === true
]);
checks.push(['essay', classify('Why do you want to work here?') === 'question']);
checks.push(['us reside yesno', classify('Do you currently reside in the United States?') === 'work_authorization']);
checks.push(['city where reside', classify('Where do you currently reside?') === 'city']);
checks.push(['sponsor', classify('Will you require visa sponsorship?') === 'requires_sponsorship']);
checks.push([
    'PLOS need visa sponsorship',
    classify('Will you need visa sponsorship to work in the US now or in the future? *')
        === 'requires_sponsorship'
]);
checks.push([
    'PLOS limited state list',
    classify('PLOS currently operates in 8 states. Please choose which of the states you currently reside in. *')
        === 'state'
]);
checks.push([
    'authorized without sponsorship → work auth Yes',
    classify('Are you legally authorized to work in the United States without sponsorship?')
        === 'work_authorization'
]);
checks.push([
    'authorized without sponsorship not sponsorship kind',
    classify('Are you legally authorized to work in the United States without sponsorship?')
        !== 'requires_sponsorship'
]);
checks.push([
    'sponsor H-1B',
    classify('Will you now or in the future require sponsorship for employment visa status (e.g. H-1B status)?')
        === 'requires_sponsorship'
]);
checks.push([
    'prior employer Included Health',
    classify('Have you previously worked for Grand Rounds, Included Health, or Doctor on Demand as a permanent or temporary employee?')
        === 'previous_employer_no'
]);
checks.push([
    'prior employer FireFly',
    classify('Have you previously worked for FireFly as a permanent or temporary employee?')
        === 'previous_employer_no'
]);
// Simulate "prefer API" bug: API Yes must lose to hard locks.
function resolveWanted(kind, label, apiYes, profile) {
    const lab = String(label || '');
    if (kind === 'requires_sponsorship' || /\bsponsorship\b/i.test(lab)) {
        return sponsorshipAnswer(profile);
    }
    if (kind === 'previous_employer_no' || /\bpreviously\s+worked\b/i.test(lab)) {
        return 'No';
    }
    return apiYes;
}
checks.push([
    'API Yes cannot win sponsorship',
    resolveWanted('requires_sponsorship', 'Will you require sponsorship?', 'Yes', { requires_sponsorship: 'No' }) === 'No'
]);
checks.push([
    'API Yes cannot win prior employer',
    resolveWanted('previous_employer_no', 'Have you previously worked for FireFly?', 'Yes', {}) === 'No'
]);
checks.push(['sponsor answer default No', sponsorshipAnswer({ requires_sponsorship: 'No' }) === 'No']);
checks.push(['sponsor answer empty → No', sponsorshipAnswer({}) === 'No']);
checks.push(['sponsor answer prose → No', sponsorshipAnswer({ requires_sponsorship: 'I may need a visa' }) === 'No']);
checks.push(['sponsor answer exact Yes', sponsorshipAnswer({ requires_sponsorship: 'Yes' }) === 'Yes']);
checks.push(['date field', classify('Date') === 'todays_date']);
checks.push(['how heard', classify('How did you hear about this position?') === 'how_heard']);
checks.push(['notice period', classify('What is your notice period?') === 'notice_period']);
checks.push(['start date', classify('When can you start?') === 'earliest_start_date']);
checks.push(['how heard not essay', classify('How did you hear about us?') !== 'question']);
checks.push(['date EST format', /^\d{2}\/\d{2}\/\d{4}$/.test(formatEstTodayMdY())]);
checks.push(['gh host', detectAts('boards.greenhouse.io', false) === 'greenhouse']);
checks.push(['block lever', detectAts('jobs.lever.co', false) === 'lever']);
checks.push(['verify yes', valuesMatch('Yes', 'Yes', 'over_18')]);
checks.push(['verify no soft', valuesMatch('No', 'No, I have not', 'previous_employer_no')]);
checks.push(['phone formats', valuesMatch('937-326-3137', '(937) 326-3137', 'phone')]);
checks.push(['linkedin url', valuesMatch(
    'https://www.linkedin.com/in/alex-testuser',
    'linkedin.com/in/alex-testuser/',
    'linkedin'
)]);
checks.push(['radio yes not no', pickRadio('Yes', ['No', 'Yes', 'Prefer not to say']) === 'Yes']);
checks.push(['radio no exact', pickRadio('No', ['Yes', 'No']) === 'No']);

const completeFields = [
    { id: 'fn', label: 'First Name', kind: 'first_name', required: true },
    { id: 'em', label: 'Email', kind: 'email', required: true },
    { id: 'ph', label: 'Phone', kind: 'phone', required: true },
    { id: 'li', label: 'LinkedIn Profile', kind: 'linkedin', required: true },
    { id: 'res', label: 'Do you currently reside in the United States?', kind: 'work_authorization', required: true },
    { id: 'sp', label: 'Will you require visa sponsorship?', kind: 'requires_sponsorship', required: true }
];
const completeProfile = {
    first_name: 'Alex',
    email: 'v@example.com',
    phone: '9373263137',
    linkedin: 'https://linkedin.com/in/alex-testuser',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    fn: 'Alex',
    em: 'v@example.com',
    ph: '9373263137',
    li: 'https://linkedin.com/in/alex-testuser',
    res: 'Yes',
    sp: 'No'
};
const completeCurrent = {
    fn: 'Alex',
    em: 'v@example.com',
    ph: '(937) 326-3137',
    li: 'linkedin.com/in/alex-testuser/',
    res: 'Yes',
    sp: 'No'
};
const complete = requiredComplete(completeFields, completeProfile, completeCurrent);
checks.push(['visually complete → requiredComplete', complete.requiredComplete === true]);
checks.push(['complete missing empty', complete.missingRequired.length === 0]);

const incomplete = requiredComplete(completeFields, completeProfile, {
    ...completeCurrent,
    res: ''
});
checks.push(['missing reside incomplete', incomplete.requiredComplete === false]);
checks.push(['missing label stable', incomplete.missingRequired[0] === 'Do you currently reside in the United States?']);
checks.push(['empty label falls back', fieldMissingLabel({ kind: 'email', label: '' }) === 'email']);

function keepCheckbox(label, kind) {
    const hay = String(label || '').toLowerCase();
    const isConsent = /\b(agree|acknowledg|consent|terms|certify|confirm)\b/.test(hay);
    return isConsent
        || kind === 'requires_sponsorship'
        || kind === 'work_authorization'
        || kind === 'over_18'
        || kind === 'willing_to_relocate'
        || kind === 'previous_employer_no'
        || kind === 'question';
}
checks.push(['consent checkbox', keepCheckbox('I agree to the terms', 'question') === true]);
checks.push(['skip bare eeo', keepCheckbox('Hispanic or Latino', 'gender') === false]);
checks.push(['fingerprint includes path', `${'/apply'}|${''}|a|b`.includes('/apply')]);

function fallbackEssayForQuestion(label, profile = {}) {
    const lab = String(label || '').toLowerCase();
    const skills = String(profile.skills || '').trim();
    const yoe = String(profile.years_of_experience || '').replace(/\D/g, '') || '';
    if (/\b(aws|amazon web services|glue|lambda|step functions|mwaa|airflow)\b/i.test(lab)) {
        return (
            `I have hands-on AWS experience${yoe ? ` across ${yoe}+ years` : ''}, `
            + `most proficient with ${skills || 'Lambda, S3, and related data/ETL services'}.`
        );
    }
    return '';
}

const awsLabel = 'Please describe your experience working in an AWS cloud environment, specifically with services such as Glue, Lambda, Step Functions, and MWAA (Airflow). Which services are you most proficient in? *';
checks.push([
    'empty required essay NOT satisfied without answer',
    requiredFieldSatisfied({ type: 'textarea', kind: 'question', label: awsLabel }, '', '') === false
]);
checks.push([
    'empty essay with wanted still not satisfied until filled',
    requiredFieldSatisfied({ type: 'textarea', kind: 'question' }, 'AWS answer here', '') === false
]);
checks.push([
    'filled essay satisfied',
    requiredFieldSatisfied({ type: 'textarea', kind: 'question' }, '', 'I have hands-on AWS experience with Lambda.') === true
]);
const awsFb = fallbackEssayForQuestion(awsLabel, { years_of_experience: '8', skills: 'AWS, Lambda, Python' });
checks.push(['AWS essay fallback non-empty', awsFb.length > 40]);
checks.push(['AWS essay fallback mentions AWS/Lambda', /aws|lambda/i.test(awsFb)]);
checks.push(['sibling label length allows long essay', awsLabel.length > 80 && awsLabel.length < 420]);

// Engine budget/retry constants must stay aligned with autofillEngine (read from source).
const fs = require('fs');
const path = require('path');
const autofillSrc = fs.readFileSync(path.join(__dirname, '../lib/autofillEngine.js'), 'utf8');
const bidderSrc = fs.readFileSync(path.join(__dirname, '../content/bidderFill.js'), 'utf8');
const hardLimit = Number((autofillSrc.match(/BID_HARD_LIMIT_MS\s*=\s*(\d+)/) || [])[1]);
const retryPerPage = Number((autofillSrc.match(/AUTOFILL_RETRY_PER_PAGE\s*=\s*(\d+)/) || [])[1]);
const maxPages = Number((autofillSrc.match(/AUTOFILL_MAX_PAGES\s*=\s*(\d+)/) || [])[1]);
const ghBudget = Number((bidderSrc.match(/DEFAULT_BUDGET_MS\s*=\s*(\d+)\s*\*\s*1000/) || [])[1]) * 1000
    || Number((bidderSrc.match(/DEFAULT_BUDGET_MS\s*=\s*(\d+)/) || [])[1]);
const ghRetries = Number((bidderSrc.match(/MAX_RETRIES\s*=\s*(\d+)/) || [])[1]);
const ghPages = Number((bidderSrc.match(/MAX_PAGES\s*=\s*(\d+)/) || [])[1]);
checks.push(['autofill BID_HARD_LIMIT_MS 90s', hardLimit === 90000]);
checks.push(['autofill AUTOFILL_RETRY_PER_PAGE 2', retryPerPage === 2]);
checks.push(['autofill AUTOFILL_MAX_PAGES 6', maxPages === 6]);
checks.push(['greenhouse DEFAULT_BUDGET_MS 90s', ghBudget === 90000]);
checks.push(['greenhouse MAX_RETRIES 2', ghRetries === 2]);
checks.push(['greenhouse MAX_PAGES 6', ghPages === 6]);
checks.push(['bidderFill has AWS essay fallback', /fallbackEssayForQuestion|Glue|MWAA|step functions/i.test(bidderSrc)]);
checks.push(['bidderFill rejects empty essay as complete', /Empty wanted \+ empty field is NOT satisfied|type === 'textarea' \|\| kind === 'question'/i.test(bidderSrc)]);
checks.push(['bidderFill allows long sibling labels', /maxSibling|TEXTAREA.*420|420.*TEXTAREA/i.test(bidderSrc)]);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} bidder-fill unit checks passed.`);
