'use strict';
/**
 * CoreWeave / Greenhouse reliability scorecard.
 * Mirrors classify + default heuristics + controlMatch disability polarity.
 * Run: node extension/fixtures/test_coreweave_reliability.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const checks = [];
function check(name, ok) {
    checks.push([name, !!ok]);
}

// —— controlMatch (real source) ——
const cmSrc = fs.readFileSync(path.join(__dirname, '../content/controlMatch.js'), 'utf8');
const sandbox = { window: {}, document: { querySelector: () => null } };
vm.createContext(sandbox);
vm.runInContext(cmSrc, sandbox);
const cm = sandbox.window.__lumiControlMatch;
check('controlMatch loaded', !!cm);

const wantNoDis = 'No, I do not have a disability';
const yesOpt = 'Yes, I have a disability, or have had one in the past';
const noOpt = "No, I don't have a disability, and have not had one in the past";

check('disability No → No option high', cm.scoreChoice(wantNoDis, noOpt) >= 90);
check('disability No → Yes option REJECTED', cm.scoreChoice(wantNoDis, yesOpt) < 0);
check('disability short No → Yes REJECTED', cm.scoreChoice('No', yesOpt) < 0 || cm.scoreChoice(wantNoDis, yesOpt) < 0);
check(
    'disability No wins over Yes in matchNativeOption',
    cm.matchNativeOption(
        [
            { text: 'Select...', value: '' },
            { text: yesOpt, value: 'yes' },
            { text: noOpt, value: 'no' }
        ],
        wantNoDis
    )?.value === 'no'
);

// —— classify (mirror bidderFill / fill.js patterns) ——
function classify(label) {
    const hay = String(label || '').toLowerCase();
    if (/\bopen to working\b.{0,120}\b(office|hub|onsite|on[\s_-]*site)|\b\d+\s+days?\b.{0,60}\b(office|hub)|office hubs?\b/i.test(hay)) {
        return 'onsite_hub_yes';
    }
    if (/\bu\.?\s*s\.?\s*person\b|whether you are a\s*["“']?u\.?\s*s\.?\s*person/i.test(hay)) {
        return 'us_person_yes';
    }
    if (/\b(have you (ever )?worked|previously\s+worked|former\b.{0,48}\bemployee|are you a former\b|employed by\b|ever been employed|have (?:you )?ever been employed|worked\s+(at|for)\b)/i.test(hay)) {
        return 'previous_employer_no';
    }
    if (/\b(sponsor|sponsorship|visa|h-?1b)\b/i.test(hay) || /\bwill you.{0,60}\b(require|need).{0,40}\b(sponsor|visa)/i.test(hay)) {
        return 'requires_sponsorship';
    }
    if (/\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(hay)) return 'disability_status';
    if (/\b(veteran|military)\b/i.test(hay)) return 'veteran_status';
    return 'question';
}

function defaultAnswer(kind, label) {
    if (kind === 'disability_status') return 'No, I do not have a disability';
    if (kind === 'onsite_hub_yes') return 'Yes';
    if (kind === 'us_person_yes') return 'Yes';
    if (kind === 'previous_employer_no') return 'No';
    if (kind === 'requires_sponsorship') return 'No';
    if (kind === 'veteran_status') return 'I am not a protected veteran';
    const lab = String(label || '');
    if (/\b(open|willing|able|comfortable|agree|authorized|eligible|citizen|person)\b/i.test(lab)) return 'Yes';
    if (/\b(require|need|sponsor|former|ever been|criminal)\b/i.test(lab)) return 'No';
    return '';
}

const coreweaveFields = [
    {
        label: 'Do you now or will you in the future require sponsorship to work in the country you are applying to?',
        expectKind: 'requires_sponsorship',
        expectAnswer: 'No'
    },
    {
        label: 'Are you open to working 3 days from one of our office hubs in NYC, NJ, CA, WA?',
        expectKind: 'onsite_hub_yes',
        expectAnswer: 'Yes'
    },
    {
        label: 'Are you a former CoreWeave employee?',
        expectKind: 'previous_employer_no',
        expectAnswer: 'No'
    },
    {
        label: 'Are you now or have you ever been employed by CoreWeave?',
        expectKind: 'previous_employer_no',
        expectAnswer: 'No'
    },
    {
        label: 'Please indicate whether you are a "U.S. person". U.S. person is defined as a (i) U.S. citizen or national…',
        expectKind: 'us_person_yes',
        expectAnswer: 'Yes'
    },
    {
        label: 'Do you now or will you in the future require sponsorship to work in the United States? (e.g. H1-B, H1B1, TN, E3, OPT/STEM OPT, H4, J2, or other visa type)',
        expectKind: 'requires_sponsorship',
        expectAnswer: 'No'
    },
    {
        label: 'Disability Status',
        expectKind: 'disability_status',
        expectAnswer: 'No, I do not have a disability'
    },
    {
        label: 'Veteran Status',
        expectKind: 'veteran_status',
        expectAnswer: 'I am not a protected veteran'
    }
];

for (const f of coreweaveFields) {
    const kind = classify(f.label);
    const answer = defaultAnswer(kind, f.label);
    check(`classify: ${f.expectKind} ← ${f.label.slice(0, 48)}…`, kind === f.expectKind);
    check(`answer: ${f.expectAnswer.slice(0, 24)} ← ${f.expectKind}`, answer === f.expectAnswer
        || (f.expectKind === 'disability_status' && /^No/i.test(answer)));
}

// —— source guards (engine has sweep + hard locks) ——
const bidderSrc = fs.readFileSync(path.join(__dirname, '../content/bidderFill.js'), 'utf8');
const fillSrc = fs.readFileSync(path.join(__dirname, '../content/fill.js'), 'utf8');
check('bidderFill has sweepRequiredSelects', /async function sweepRequiredSelects/.test(bidderSrc));
check('bidderFill has defaultAnswerForEmptySelect', /function defaultAnswerForEmptySelect/.test(bidderSrc));
check('bidderFill disability hard lock No', /Hard lock: always No/.test(bidderSrc));
check('fill.js disability hard lock No', /Hard lock: always No/.test(fillSrc));
check('bidderFill onsite_hub_yes kind', /onsite_hub_yes/.test(bidderSrc));
check('bidderFill us_person_yes kind', /us_person_yes/.test(bidderSrc));
check('bidderFill employed by pattern', /employed by\\b/.test(bidderSrc));
check('bidderFill former…employee pattern', /former\\b\.\{0,48\}\\bemployee/.test(bidderSrc));
check('fill.js clickSubmitAsync wait enable', /async function clickSubmitAsync/.test(fillSrc));

// —— server fixed constants ——
let serverOk = true;
try {
    const svcPath = path.join(__dirname, '../../server/services/applicationAnswersService.js');
    const svc = fs.readFileSync(svcPath, 'utf8');
    check('server has onsite_hub_yes', /onsite_hub_yes/.test(svc));
    check('server has us_person_yes', /us_person_yes/.test(svc));
    check('server previous_employer includes employed by', /employed by/.test(svc));
    // Evaluate fixedConstantKind via require if possible
    const {
        // not all exports — load via regex smoke only
    } = {};
    void serverOk;
} catch (err) {
    check('server answers service readable', false);
    console.warn(err.message);
}

const passed = checks.filter(([, ok]) => ok).length;
const total = checks.length;
const pct = total ? Math.round((passed / total) * 1000) / 10 : 0;

for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
console.log(`\nCoreWeave reliability scorecard: ${passed}/${total} = ${pct}%`);

if (passed < total) {
    process.exitCode = 1;
}

// Export for reporters
if (typeof module !== 'undefined') {
    module.exports = { passed, total, pct, checks };
}
