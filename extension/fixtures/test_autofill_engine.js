/**
 * Autofill Engineer v3 unit checks.
 * Run: node extension/fixtures/test_autofill_engine.js
 */
import {
    AUTOFILL_ENGINE,
    AUTOFILL_MAX_PAGES,
    AUTOFILL_MIN_COVERAGE,
    AUTOFILL_RETRY_PER_PAGE,
    BID_HARD_LIMIT_MS,
    engineLabelForAts,
    formFieldCount,
    formFingerprint,
    maxPagesForAts,
    mergeAnswers,
    pickNewQuestions,
    settleMsForAts,
    shouldAdvancePage,
    shouldRefillPage,
    useAnswersOnlyOnPage
} from '../lib/autofillEngine.js';

const checks = [];

checks.push(['engine id', AUTOFILL_ENGINE === 'autofill-engine-v3']);
checks.push(['max pages default', AUTOFILL_MAX_PAGES === 6]);
checks.push(['retry default', AUTOFILL_RETRY_PER_PAGE === 2]);
checks.push(['min coverage', AUTOFILL_MIN_COVERAGE === 0.35]);
checks.push(['bid hard limit ~90s', typeof BID_HARD_LIMIT_MS === 'number' && BID_HARD_LIMIT_MS >= 60000 && BID_HARD_LIMIT_MS <= 120000]);
checks.push(['oracle label', engineLabelForAts('oracle') === 'autofill-engine-v3:oracle']);
checks.push(['ashby label', engineLabelForAts('ashby') === 'autofill-engine-v3:ashby']);
checks.push(['workday label', engineLabelForAts('workday') === 'autofill-engine-v3:workday']);
checks.push(['icims label', engineLabelForAts('icims') === 'autofill-engine-v3:icims']);
checks.push(['bamboohr label', engineLabelForAts('bamboohr') === 'autofill-engine-v3:bamboohr']);
checks.push(['generic label', engineLabelForAts('') === 'autofill-engine-v3:generic']);
checks.push(['linkedin label', engineLabelForAts('linkedin') === 'autofill-engine-v3:linkedin']);

checks.push(['oracle settle slower', settleMsForAts('oracle') > settleMsForAts('generic')]);
checks.push(['workday more pages', maxPagesForAts('workday') > AUTOFILL_MAX_PAGES]);

const fp1 = formFingerprint({
    url: 'https://eihu.fa.us8.oraclecloud.com/apply',
    fields: [{ id: 'a', label: 'Email', type: 'text', kind: 'email' }],
    fileInputs: [{ kind: 'resume' }]
});
const fp2 = formFingerprint({
    url: 'https://eihu.fa.us8.oraclecloud.com/apply',
    fields: [{ id: 'a', label: 'Email', type: 'text', kind: 'email' }],
    fileInputs: [{ kind: 'resume' }]
});
const fp3 = formFingerprint({
    url: 'https://eihu.fa.us8.oraclecloud.com/apply/step2',
    fields: [{ id: 'b', label: 'Phone', type: 'text', kind: 'phone' }],
    fileInputs: []
});
checks.push(['fingerprint stable', fp1 === fp2]);
checks.push(['fingerprint changes on page', fp1 !== fp3]);
checks.push(['field count', formFieldCount({ fields: [{}, {}], fileInputs: [{}] }) === 3]);

const merged = mergeAnswers(
    [{ id: '1', label: 'Why us?', answer: 'A' }],
    [{ id: '1', label: 'Why us?', answer: 'B' }, { id: '2', label: 'Salary', answer: '120k' }]
);
checks.push(['merge overwrites by id', merged.find((a) => a.id === '1')?.answer === 'B']);
checks.push(['merge keeps new', merged.some((a) => a.id === '2')]);

const learned = mergeAnswers(
    [{ id: 'loc', label: 'Location', answer: 'Wrong', source: 'llm', match_source: 'llm' }],
    [{ id: 'loc', label: 'Location', answer: 'Austin, TX 78701', source: 'fill_lesson', match_source: 'fill_lesson' }]
);
checks.push(['lesson beats llm', learned.find((a) => a.id === 'loc')?.answer === 'Austin, TX 78701']);
const lessonKeeps = mergeAnswers(
    [{ id: 'loc', label: 'Location', answer: 'Austin, TX 78701', source: 'fill_lesson_early', match_source: 'fill_lesson_early' }],
    [{ id: 'loc', label: 'Location', answer: 'AI city', source: 'api', match_source: 'llm' }]
);
checks.push(['lesson survives later llm', lessonKeeps.find((a) => a.id === 'loc')?.answer === 'Austin, TX 78701']);

const fresh = pickNewQuestions(
    [
        { id: '1', label: 'Why us?' },
        { id: '3', label: 'Relocation?' }
    ],
    [{ id: '1', label: 'Why us?', answer: 'A' }]
);
checks.push(['pick new questions', fresh.length === 1 && fresh[0].id === '3']);

checks.push([
    'should advance when fp changes',
    shouldAdvancePage({
        clickedNext: true,
        fingerprintBefore: fp1,
        fingerprintAfter: fp3,
        pages: 1
    }) === true
]);
checks.push([
    'should stop when fp same',
    shouldAdvancePage({
        clickedNext: true,
        fingerprintBefore: fp1,
        fingerprintAfter: fp1,
        pages: 1
    }) === false
]);
checks.push([
    'should stop at max pages',
    shouldAdvancePage({
        clickedNext: true,
        fingerprintBefore: fp1,
        fingerprintAfter: fp3,
        pages: AUTOFILL_MAX_PAGES,
        maxPages: AUTOFILL_MAX_PAGES
    }) === false
]);
checks.push([
    'should not advance without next click',
    shouldAdvancePage({
        clickedNext: false,
        fingerprintBefore: fp1,
        fingerprintAfter: fp3,
        pages: 0
    }) === false
]);
checks.push([
    'should advance when after fp empty',
    shouldAdvancePage({
        clickedNext: true,
        fingerprintBefore: fp1,
        fingerprintAfter: '',
        pages: 0
    }) === true
]);

checks.push(['answersOnly off mid-walk', useAnswersOnlyOnPage(2) === false]);
checks.push(['answersOnly on final', useAnswersOnlyOnPage(99, { finalSubmitPass: true }) === true]);

checks.push([
    'refill when zero filled',
    shouldRefillPage({
        form: { fields: [{}, {}, {}], fileInputs: [] },
        fillStats: { filled: 0 },
        attempt: 1,
        maxAttempts: 3
    }) === true
]);
checks.push([
    'no refill when coverage ok',
    shouldRefillPage({
        form: { fields: [{}, {}, {}], fileInputs: [] },
        fillStats: { filled: 3 },
        attempt: 1,
        maxAttempts: 3
    }) === false
]);
checks.push([
    'no refill at max attempts',
    shouldRefillPage({
        form: { fields: [{}, {}, {}], fileInputs: [] },
        fillStats: { filled: 0 },
        attempt: 3,
        maxAttempts: 3
    }) === false
]);

const byLabel = mergeAnswers(
    [{ label: 'Why us?', answer: 'old' }],
    [{ label: 'Why us?', answer: 'new' }]
);
checks.push(['merge by label', byLabel.length === 1 && byLabel[0].answer === 'new']);

const emptyFp = formFingerprint(null);
checks.push(['fingerprint null safe', emptyFp === '']);

const skipped = pickNewQuestions(
    [{ id: '1', label: 'A' }, { id: '', label: 'B' }, { id: '3', label: 'C' }],
    [{ id: '', label: 'B', answer: 'x' }]
);
checks.push(['pick skips answered label', skipped.every((q) => q.label !== 'B') && skipped.length === 2]);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} autofill-engine checks passed.`);
