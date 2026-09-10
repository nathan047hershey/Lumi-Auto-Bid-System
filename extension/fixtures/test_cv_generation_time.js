/**
 * CV generation clock: start Generating → Ready/Failed.
 * Run: node extension/fixtures/test_cv_generation_time.js
 */
import { parseSqliteUtcMs, sqliteUtcToIso } from '../../client/src/lib/sqliteDate.js';

function formatDurationCompact(seconds) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
}

function formatCvGenerationMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    return formatDurationCompact(n / 1000);
}

function cvGenerationDurationMs(row, { now = Date.now() } = {}) {
    if (!row) return null;
    const start = parseSqliteUtcMs(row.generation_started_at);
    const status = String(row.generation_status || '');
    if (status === 'generating') {
        if (!Number.isFinite(start) || start <= 0) return null;
        return Math.max(0, now - start);
    }
    if (Number.isFinite(start) && start > 0) {
        const end = parseSqliteUtcMs(row.generation_finished_at);
        if (Number.isFinite(end) && end >= start) return end - start;
    }
    const stored = Number(row.generation_ms);
    if (Number.isFinite(stored) && stored > 0) return stored;
    return null;
}

function cvGenerationTimeLabel(row, { now = Date.now() } = {}) {
    if (!row) return null;
    const status = String(row.generation_status || '');
    if (status === 'pending') return formatCvGenerationMs(row.generation_ms);
    return formatCvGenerationMs(cvGenerationDurationMs(row, { now }));
}

const checks = [];

const naiveUtc = '2026-09-08 21:06:00';
const parsed = parseSqliteUtcMs(naiveUtc);
const asLocal = Date.parse(naiveUtc);
checks.push(['naive sqlite is UTC', parsed === Date.parse('2026-09-08T21:06:00Z')]);
checks.push(['naive sqlite is not local', parsed !== asLocal || (new Date()).getTimezoneOffset() === 0]);
checks.push(['iso z passthrough', parseSqliteUtcMs('2026-09-08T21:06:00.000Z') === Date.parse('2026-09-08T21:06:00.000Z')]);
checks.push(['toIso adds Z', sqliteUtcToIso(naiveUtc) === '2026-09-08T21:06:00.000Z']);

const now = Date.parse('2026-09-08T21:07:30.000Z');
checks.push([
    'generating elapsed 90s',
    cvGenerationTimeLabel({
        generation_status: 'generating',
        generation_started_at: naiveUtc
    }, { now }) === '1m 30s'
]);
checks.push([
    'ready uses stored ms',
    cvGenerationTimeLabel({ generation_status: 'ready', generation_ms: 45000 }) === '45s'
]);
checks.push([
    'ready 9m+ from start to finish',
    cvGenerationTimeLabel({
        generation_status: 'ready',
        generation_started_at: '2026-09-08T20:57:57.000Z',
        generation_finished_at: '2026-09-08T21:07:30.000Z',
        generation_ms: 278000
    }) === '9m 33s'
]);
checks.push([
    'pending has no live clock',
    cvGenerationTimeLabel({
        generation_status: 'pending',
        updated_at: '2026-09-08 20:00:00',
        generation_ms: null
    }, { now }) === null
]);
checks.push([
    'ready missing ms is empty',
    cvGenerationTimeLabel({ generation_status: 'ready', generation_ms: null }) === null
]);
checks.push([
    'generating ignores stale updated_at',
    cvGenerationTimeLabel({
        generation_status: 'generating',
        updated_at: '2026-09-08 20:00:00',
        generation_started_at: null
    }, { now }) === null
]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
if (failed) {
    console.error(`\n${failed}/${checks.length} cv-generation-time checks failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} cv-generation-time checks passed.`);
