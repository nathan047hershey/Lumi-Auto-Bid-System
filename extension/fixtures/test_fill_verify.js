/**
 * Shared fill verify / submit gate unit checks.
 * Run: node extension/fixtures/test_fill_verify.js
 */
import {
    normalizeFillStats,
    isFillIncomplete,
    canAutoSubmit,
    stableMissingLabels,
    bidLimitMsForAts,
    formWaitMsForAts,
    submitSuccessPollPlan,
    FILL_VERIFY_BASE_LIMIT_MS,
    prioritizeFieldsForBudget
} from '../lib/autofillEngine.js';

const checks = [];

checks.push(['base limit', FILL_VERIFY_BASE_LIMIT_MS === 90000]);
checks.push([
    'stable missing labels',
    (() => {
        const m = stableMissingLabels(['Email', '', { label: 'City' }, 'Email']);
        return m[0] === 'Email' && m.includes('City') && m.length === 3;
    })()
]);
checks.push([
    'stable missing drops dupes',
    stableMissingLabels(['Phone', 'phone']).length === 1
]);

const incomplete = normalizeFillStats({
    requiredOk: 2,
    requiredTotal: 5,
    missingRequired: ['Location', ''],
    filled: 4
});
checks.push(['normalize incomplete', incomplete.requiredComplete === false && incomplete.incomplete === true]);
checks.push(['normalize missing labels', incomplete.missingRequired.includes('Location')]);

const complete = normalizeFillStats({
    requiredComplete: true,
    requiredOk: 3,
    requiredTotal: 3,
    filled: 5
});
checks.push(['normalize complete', complete.requiredComplete === true && !isFillIncomplete(complete)]);
checks.push(['isFillIncomplete true', isFillIncomplete(incomplete)]);
checks.push(['canAutoSubmit blocks incomplete', canAutoSubmit(incomplete, { autoSubmit: true }) === false]);
checks.push(['canAutoSubmit allows complete', canAutoSubmit(complete, { autoSubmit: true }) === true]);
checks.push(['canAutoSubmit respects prefs off', canAutoSubmit(complete, { autoSubmit: false }) === false]);

checks.push(['workday budget > base', bidLimitMsForAts('workday') > FILL_VERIFY_BASE_LIMIT_MS]);
checks.push(['page bump capped', bidLimitMsForAts('workday', { pageCount: 6 }) <= 150000]);
checks.push(['form wait workday longer', formWaitMsForAts('workday', 12000) >= 18000]);
checks.push(['poll plan attempts', submitSuccessPollPlan({ totalMs: 12000, gapMs: 800 }).attempts >= 2]);

const ranked = prioritizeFieldsForBudget([
    { label: 'Why us?', kind: 'essay', required: false },
    { label: 'Resume', kind: 'file', required: true },
    { label: 'Email', kind: 'email', required: true },
    { label: 'Notes', kind: 'textarea', required: false }
]);
checks.push(['prioritize required first', ranked[0].kind === 'file' || ranked[0].label === 'Resume']);
checks.push([
    'prioritize essays last',
    /essay|textarea/i.test(ranked[ranked.length - 1].kind)
    || /why|notes/i.test(ranked[ranked.length - 1].label || '')
]);

let failed = 0;
for (const [name, ok] of checks) {
    if (!ok) {
        failed += 1;
        console.error('FAIL', name);
    } else {
        console.log('PASS', name);
    }
}
if (failed) {
    console.error(`\n${failed}/${checks.length} fill-verify checks failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} fill-verify checks passed.`);
