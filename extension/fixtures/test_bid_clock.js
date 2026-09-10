/**
 * Bid clock starts at Process (queue_started / opened), never generate_done.
 * Answers clock is answers_generating → bidder_answers_ready.
 * Run: node extension/fixtures/test_bid_clock.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const srcPath = path.join(__dirname, '../../client/src/lib/bidClock.js');
const src = fs.readFileSync(srcPath, 'utf8')
    .replace(/^export /gm, '')
    .replace(/export \{[^}]+\}/g, '');
const mod = { exports: {} };
const fn = new Function('module', 'exports', `${src}\nmodule.exports = {\n  bidClockStartAt,\n  bidClockEndAt,\n  answersClockFromEvents\n};`);
fn(mod, mod.exports);
const { bidClockStartAt, bidClockEndAt, answersClockFromEvents } = mod.exports;

const genAt = '2026-09-08T12:00:00.000Z';
const queueAt = '2026-09-08T16:55:00.000Z';
const answersAt = '2026-09-08T16:55:20.000Z';
const answersReadyAt = '2026-09-08T16:55:38.000Z';
const appliedAt = '2026-09-08T16:57:10.000Z';

const events = [
    { event_type: 'generate_done', at: genAt },
    { event_type: 'queue_started', at: queueAt },
    { event_type: 'opened', at: '2026-09-08T16:55:05.000Z' },
    { event_type: 'answers_generating', at: answersAt, meta: { questions: 12 } },
    {
        event_type: 'bidder_answers_ready',
        at: answersReadyAt,
        meta: { count: 11, questions: 12, duration_ms: 18000 }
    },
    { event_type: 'marked_applied', at: appliedAt }
];

const checks = [];

const start = bidClockStartAt({
    events,
    course: { started_at: genAt },
    queueJobStartedAt: null
});
checks.push(['bid start is queue_started, not generate_done', start === queueAt]);

const genOnlyStart = bidClockStartAt({
    events: [{ event_type: 'generate_done', at: genAt }],
    course: { started_at: genAt }
});
checks.push(['generation-only course has no bid start', genOnlyStart == null]);

const end = bidClockEndAt({
    events,
    course: { applied_at: appliedAt },
    running: false
});
checks.push(['bid end is applied_at', end === appliedAt]);

const liveEnd = bidClockEndAt({
    events: events.slice(0, 3),
    course: {},
    running: true
});
checks.push(['running bid has no end', liveEnd == null]);

const answers = answersClockFromEvents(events);
checks.push(['answers questions', answers?.questions === 12]);
checks.push(['answers count', answers?.answers === 11]);
checks.push(['answers duration_ms from meta', answers?.ms === 18000]);
checks.push(['answers not live after ready', answers?.live === false]);

const liveAnswers = answersClockFromEvents(events.slice(0, 4));
checks.push(['answers live while generating', liveAnswers?.live === true]);
checks.push(['answers live questions', liveAnswers?.questions === 12]);

const emptyAnswers = answersClockFromEvents([
    { event_type: 'answers_generating', at: answersAt, meta: { questions: 0 } }
]);
checks.push(['zero questions is not an answers clock', emptyAnswers == null]);

const noGenerateStart = bidClockStartAt({
    events: [
        { event_type: 'opened', at: queueAt },
        { event_type: 'fill_done', at: appliedAt }
    ],
    course: { started_at: genAt }
});
checks.push(['opened starts bid without generate_done', noGenerateStart === queueAt]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`\nAll ${checks.length} bid-clock checks passed.`);
