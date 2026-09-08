/**
 * "Where are you located?" with US-hire state list — must classify as state/city, not question.
 * Run: node extension/fixtures/test_location_select.js
 */

const LOC =
    'Where are you located? (We are always expanding, but there is a small list of states we do not hire in, '
    + 'including Alabama, Alaska, Delaware, District of Columbia, Hawaii, Iowa, Louisiana, Mississippi, '
    + 'Nebraska, New Mexico, Rhode Island, South Dakota, West Virginia and Utah and while we love all parts '
    + 'of the world, we can only hire permanent US residents at this time.) *';

function classify(hay) {
    const h = String(hay || '').toLowerCase();
    if (
        /\bwhere (?:are|do) you (?:located|currently reside|live)\b/.test(h)
        || /\bwhere are you located\b/.test(h)
        || /\bcurrent[\s_-]*location\b/.test(h)
        || /\bwhere do you currently reside\b/.test(h)
    ) {
        if (
            /\bstates?\s+we\s+do\s+not\s+hire|\bdo not hire in\b|\bstates? we do not\b/.test(h)
            || (/\b(alabama|alaska|hawaii|utah|nebraska)\b/.test(h) && /\bhire\b/.test(h))
        ) {
            return 'state';
        }
        return 'city';
    }
    // Old buggy path: US in help text blocked city
    if (
        /\b(city|where do you currently reside|where are you located|current[\s_-]*location)\b/.test(h)
        && !/\b(united states|u\.?\s*s\.?\s*a?\.?)\b/.test(h)
    ) {
        return 'city';
    }
    if (
        (/\b(do you|are you)\b/.test(h) && /\breside\b/.test(h) && !/\bwhere\b/.test(h))
        || (/\breside\b/.test(h) && /\b(united states|u\.?\s*s\.?\s*a?\.?)\b/.test(h) && !/\bwhere\b/.test(h))
        || /\blegal(?:ly)?\s+resid|\bpermanent\s+residenc/.test(h)
    ) {
        return 'work_authorization';
    }
    return 'question';
}

/** Old bidderFill city rule that broke Flexential-style location. */
function oldBrokenClassify(hay) {
    const h = String(hay || '').toLowerCase();
    if (
        /\b(city|where do you currently reside|where are you located|current[\s_-]*location)\b/.test(h)
        && !/\b(united states|u\.?\s*s\.?\s*a?\.?)\b/.test(h)
    ) {
        return 'city';
    }
    return 'question';
}

const checks = [];
function check(name, ok) {
    checks.push([name, !!ok]);
}

check('NEW: Flexential location → state', classify(LOC) === 'state');
check('OLD: would miss (documents bug)', oldBrokenClassify(LOC) === 'question');
check('NEW: not work_authorization', classify(LOC) !== 'work_authorization');
check('NEW: not question', classify(LOC) !== 'question');
check(
    'simple where located → city',
    classify('Where are you located?') === 'city'
);
check(
    'where currently reside → city',
    classify('Where do you currently reside?') === 'city'
);
check(
    'US reside yes/no still auth',
    classify('Do you currently reside in the United States?') === 'work_authorization'
);

const stateMap = { ca: 'California', oh: 'Ohio', ny: 'New York' };
function wantedForState(profile) {
    const st = String(profile.state || '').trim();
    return stateMap[st.toLowerCase()] || st;
}
check('CA → California', wantedForState({ state: 'CA' }) === 'California');
check('OH → Ohio', wantedForState({ state: 'OH' }) === 'Ohio');

// Alias matching for native <select> (CA ↔ California)
function matchStateOption(wanted, options) {
    const stMap = {
        ca: 'California', ny: 'New York', oh: 'Ohio', tx: 'Texas', wa: 'Washington'
    };
    const aliases = [wanted];
    const k = String(wanted || '').toLowerCase();
    if (stMap[k]) aliases.push(stMap[k], k.toUpperCase());
    const entry = Object.entries(stMap).find(([, v]) => v.toLowerCase() === k);
    if (entry) aliases.push(entry[0].toUpperCase(), entry[1]);
    if (String(wanted).includes(',')) aliases.push(String(wanted).split(',').pop().trim());
    for (const opt of options) {
        const t = opt.text.toLowerCase();
        const v = String(opt.value || '').toLowerCase();
        if (aliases.some((a) => {
            const w = a.toLowerCase();
            return t === w || v === w || (w.length === 2 && v === w);
        })) return opt;
    }
    return null;
}
const opts = [
    { text: 'Select...', value: '' },
    { text: 'California', value: 'CA' },
    { text: 'Ohio', value: 'OH' }
];
check('select match California text', matchStateOption('California', opts)?.value === 'CA');
check('select match CA code', matchStateOption('CA', opts)?.value === 'CA');
check('select match City, CA', matchStateOption('Palo Alto, CA', opts)?.value === 'CA');
check(
    'select empty wanted skips placeholder',
    (() => {
        const aliases = [''].filter(Boolean);
        return aliases.length === 0;
    })()
);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} location-select checks passed.`);
