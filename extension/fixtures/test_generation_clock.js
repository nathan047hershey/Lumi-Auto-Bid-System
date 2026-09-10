/**
 * Run: node extension/fixtures/test_generation_clock.js
 */
const { generationDurationMs, parseSqliteUtcMs } = require('../../server/lib/generationClock.js');

const start = Date.parse('2026-09-08T20:57:57.000Z');
const end = Date.parse('2026-09-08T21:07:30.000Z');
const ms = generationDurationMs(start, end);
const checks = [
    ['9m 33s wall', ms === 573000],
    ['parse iso', parseSqliteUtcMs('2026-09-08T20:57:57.000Z') === start],
    ['parse sqlite utc', parseSqliteUtcMs('2026-09-08 20:57:57') === start]
];

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : ms);
    if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`\nAll ${checks.length} generation-clock checks passed.`);
