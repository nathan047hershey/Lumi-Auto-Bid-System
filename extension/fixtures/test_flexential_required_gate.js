/**
 * Flexential / contractor prior-employer + required-complete gate.
 * Mirrors extension/content/bidderFill.js requiredFieldSatisfied + classify.
 * Run: node extension/fixtures/test_flexential_required_gate.js
 */

const PRIOR_RE =
    /\b(have you (ever )?worked|previously\s+worked|former\s+(employee|employer)|worked\s+(at|for)\b|ever\s+worked\s+(at|for)|permanent or temporary employee|(?:currently|previously)\s+(?:\([^)]*\)\s*)?working\s+for|working\s+for\b.{0,80}\b(contractor|contingent)|contractor or contingent|contingent worker|as an?\s+(employee|contractor|contingent)|employee or (?:a )?contractor|internal (?:candidate|employee)|applied (?:here|to (?:us|this)|before))\b/i;

function classify(label, name = '') {
    const hay = `${label} ${name}`.toLowerCase();
    if (/\b(phone|mobile|tel)\b/.test(hay)) return 'phone';
    if (/\b(sponsor|visa)\b/.test(hay)) return 'requires_sponsorship';
    if (PRIOR_RE.test(hay)) return 'previous_employer_no';
    if (/\b(why|describe|tell us|essay)\b/.test(hay)) return 'question';
    return 'question';
}

function phoneDigits(s) {
    let d = String(s || '').replace(/[^\d]/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    return d;
}

function isPlaceholderValue(got) {
    const g = String(got || '').replace(/\s+/g, ' ').trim();
    if (!g) return true;
    if (/^select(\.\.\.|…|:)?$/i.test(g)) return true;
    if (/^choose(\s|$|\.\.\.|…)/i.test(g)) return true;
    if (/^--/.test(g) || /^type to search/i.test(g) || /^start typing/i.test(g)) return true;
    return false;
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
    if (g.includes(w) || w.includes(g)) {
        if (/^y/.test(w) && /\bno\b/.test(g) && !/^y/.test(g)) return false;
        return true;
    }
    if (kind === 'previous_employer_no' || kind === 'requires_sponsorship') {
        if (/^y/.test(w) && /^y/.test(g) && !/\bno\b/.test(g)) return true;
        if (/^n/.test(w) && (/^n/.test(g) || /\bno\b/.test(g))) return true;
    }
    return false;
}

function effectiveFieldKind(field) {
    const kind = String(field?.kind || '');
    const lab = String(field?.label || '');
    if (kind === 'previous_employer_no' || kind === 'requires_sponsorship') return kind;
    if (PRIOR_RE.test(lab)) return 'previous_employer_no';
    if (/\b(sponsor|sponsorship|visa)\b/i.test(lab)) return 'requires_sponsorship';
    return kind || classify(lab);
}

function requiredFieldSatisfied(field, wanted, got) {
    const kind = effectiveFieldKind(field);
    let w = String(wanted || '').trim();
    if (!w && (kind === 'previous_employer_no' || kind === 'requires_sponsorship')) w = 'No';
    if (w && valuesMatch(w, got, kind)) return true;
    if (isPlaceholderValue(got)) return false;
    if (kind === 'phone') return phoneDigits(got).length >= 7;
    if (kind === 'previous_employer_no' || kind === 'requires_sponsorship') {
        if (/\bno\b/i.test(got) && !/yes/i.test(String(got).replace(/\bno\b/i, ''))) return true;
        return false;
    }
    if (!w) return true;
    return false;
}

function requiredComplete(fields, wantedById, gotById) {
    const required = fields.filter((f) => f.required);
    let ok = 0;
    const missing = [];
    for (const f of required) {
        const wanted = wantedById[f.id] ?? '';
        const got = gotById[f.id] ?? '';
        if (requiredFieldSatisfied(f, wanted, got)) ok += 1;
        else missing.push(f.label || f.id);
    }
    return {
        requiredComplete: required.length > 0 && ok === required.length,
        requiredOk: ok,
        requiredTotal: required.length,
        missingRequired: missing
    };
}

const FLEX =
    'Are you currently (or previously) working for Flexential as a contractor or contingent worker?*';

const checks = [];
function check(name, ok) {
    checks.push([name, !!ok]);
}

check('classify Flexential contractor', classify(FLEX) === 'previous_employer_no');
check(
    'classify previously worked Included Health',
    classify('Have you previously worked for Grand Rounds / Included Health / FireFly Health?') === 'previous_employer_no'
);
check(
    'classify contingent worker short',
    classify('Are you a contingent worker at Acme?') === 'previous_employer_no'
);
check('classify phone', classify('Phone*') === 'phone');
check('not essay when contractor', classify(FLEX) !== 'question');

// BUG FIX: empty wanted + UI shows No → must be satisfied (user completed select)
check(
    'empty wanted + No on Flexential → ok',
    requiredFieldSatisfied(
        { id: 'fx', label: FLEX, kind: 'question', required: true },
        '',
        'No'
    ) === true
);
check(
    'misclassified question + No → ok',
    requiredFieldSatisfied(
        { id: 'fx', label: FLEX, kind: 'question', required: true },
        '',
        'No'
    )
);
check(
    'wanted No + got No → ok',
    requiredFieldSatisfied(
        { id: 'fx', label: FLEX, kind: 'previous_employer_no', required: true },
        'No',
        'No'
    )
);
check(
    'empty + Select placeholder → NOT ok',
    requiredFieldSatisfied(
        { id: 'fx', label: FLEX, kind: 'question', required: true },
        '',
        'Select...'
    ) === false
);
check(
    'empty + blank → NOT ok',
    requiredFieldSatisfied(
        { id: 'fx', label: FLEX, kind: 'question', required: true },
        '',
        ''
    ) === false
);

// Phone
check(
    'phone formatted match',
    requiredFieldSatisfied(
        { id: 'ph', label: 'Phone*', kind: 'phone', required: true },
        '937-326-3137',
        '(937) 326-3137'
    )
);
check(
    'phone empty wanted but digits present → ok',
    requiredFieldSatisfied(
        { id: 'ph', label: 'Phone*', kind: 'phone', required: true },
        '',
        '(937) 326-3137'
    )
);
check(
    'phone empty → NOT ok',
    requiredFieldSatisfied(
        { id: 'ph', label: 'Phone*', kind: 'phone', required: true },
        '9373263137',
        ''
    ) === false
);

// Full form: 6/14 style — Flexential filled, phone empty → still incomplete but Flexential not in missing
{
    const fields = [
        { id: 'ph', label: 'Phone*', kind: 'phone', required: true },
        { id: 'fx', label: FLEX, kind: 'question', required: true },
        { id: 'em', label: 'Email*', kind: 'email', required: true },
        { id: 'fn', label: 'First Name*', kind: 'first_name', required: true },
        { id: 'ln', label: 'Last Name*', kind: 'last_name', required: true },
        { id: 'sp', label: 'Sponsorship?*', kind: 'requires_sponsorship', required: true }
    ];
    const wanted = {
        ph: '9373263137',
        fx: '', // AI sent nothing — old bug marked missing even when No shown
        em: 'a@b.com',
        fn: 'Alex',
        ln: 'Testuser',
        sp: 'No'
    };
    const gotPartial = {
        ph: '',
        fx: 'No',
        em: 'a@b.com',
        fn: 'Alex',
        ln: 'Testuser',
        sp: 'No'
    };
    const r1 = requiredComplete(fields, wanted, gotPartial);
    check('partial: Flexential NOT in missing when No shown', !r1.missingRequired.some((m) => /Flexential/i.test(m)));
    check('partial: Phone still missing', r1.missingRequired.some((m) => /Phone/i.test(m)));
    check('partial: not complete', r1.requiredComplete === false);

    const gotFull = { ...gotPartial, ph: '(937) 326-3137' };
    const r2 = requiredComplete(fields, wanted, gotFull);
    check('full: requiredComplete true', r2.requiredComplete === true);
    check('full: missing empty', r2.missingRequired.length === 0);
    check('full: 6/6 ok', r2.requiredOk === 6 && r2.requiredTotal === 6);
}

// Old broken gate simulation (wanted && match only)
function oldBrokenGate(wanted, got, kind) {
    if (!wanted) return false;
    return valuesMatch(wanted, got, kind);
}
check(
    'OLD gate would fail Flexential (documents the bug)',
    oldBrokenGate('', 'No', 'question') === false
);
check(
    'NEW gate passes Flexential',
    requiredFieldSatisfied({ label: FLEX, kind: 'question' }, '', 'No') === true
);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} Flexential / required-gate checks passed.`);
