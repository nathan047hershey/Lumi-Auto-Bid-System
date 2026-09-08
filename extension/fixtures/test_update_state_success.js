/**
 * Regression: Update state / thank-you must flip Control to SUCCESS 100%,
 * not stay on FILLED 90% when reautofill_done is the latest non-success event.
 * Run: node extension/fixtures/test_update_state_success.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Load client helpers via a light CommonJS shim (strip ESM export).
const srcPath = path.join(__dirname, '../../client/src/lib/bidCourseFailure.js');
const src = fs.readFileSync(srcPath, 'utf8')
    .replace(/^export /gm, '')
    .replace(/export \{[^}]+\}/g, '');
// eslint-disable-next-line no-eval
const mod = { exports: {} };
const fn = new Function('module', 'exports', `${src}\nmodule.exports = {\n  isSuccessEvent,\n  lastStatusEvent,\n  courseRunStatus,\n  bidStageProgress,\n  isProofScreenshotStage,\n  isFilledEvent,\n  liveStatusComment,\n  isTabClosedEvent,\n  isBudgetExceededEvent,\n  isFailureEvent,\n  failureLabel\n};`);
fn(mod, mod.exports);
const {
    isSuccessEvent,
    lastStatusEvent,
    courseRunStatus,
    bidStageProgress,
    isProofScreenshotStage,
    isFilledEvent,
    liveStatusComment,
    isTabClosedEvent,
    isBudgetExceededEvent,
    isFailureEvent,
    failureLabel
} = mod.exports;

const checks = [];

checks.push(['isSuccessEvent marked_applied', isSuccessEvent('marked_applied') === true]);
checks.push(['isSuccessEvent mark_applied', isSuccessEvent('mark_applied') === true]);
checks.push(['isSuccessEvent submit_success_detected', isSuccessEvent('submit_success_detected') === true]);
checks.push(['isSuccessEvent reautofill_done', isSuccessEvent('reautofill_done') === false]);
checks.push(['isFilledEvent reautofill_done', isFilledEvent('reautofill_done') === true]);

const events = [
    { event_type: 'reautofill_started' },
    { event_type: 'reautofill_done', meta: { filled: 11 } },
    { event_type: 'marked_applied', meta: { via: 'control_update_state' } },
    { event_type: 'ready_to_submit' } // later noise must not hide SUCCESS
];
const last = lastStatusEvent(events);
checks.push(['lastStatusEvent prefers marked_applied', last.event_type === 'marked_applied']);

const courseStaleLast = {
    outcome: 'applied',
    applied_at: '2026-09-05T00:00:00.000Z',
    last_event_type: 'reautofill_done',
    filled_at: '2026-09-05T00:00:00.000Z'
};
const fromCourse = lastStatusEvent(courseStaleLast);
checks.push(['course applied_at beats reautofill_done', fromCourse.event_type === 'marked_applied']);

const run = courseRunStatus({
    ...courseStaleLast,
    last_event_type: 'reautofill_done'
});
checks.push(['courseRunStatus SUCCESS despite reautofill_done', run.kind === 'success']);
checks.push(['courseRunStatus short SUCCESS', run.short === 'SUCCESS']);

const runAppStatus = courseRunStatus({
    outcome: 'unknown',
    last_event_type: 'reautofill_done',
    filled_at: '2026-09-05T00:00:00.000Z',
    application_status: 'applied'
});
checks.push(['application_status applied → SUCCESS', runAppStatus.kind === 'success']);

const progress = bidStageProgress({
    events: [
        { event_type: 'reautofill_done' },
        { event_type: 'marked_applied' }
    ],
    lastEventType: 'reautofill_done',
    queueState: { status: 'running', lastStatusEvent: 'marked_applied' }
});
checks.push(['bidStageProgress pct 100', progress.pct === 100]);
checks.push(['bidStageProgress SUCCESS label', /SUCCESS/i.test(progress.label)]);
checks.push(['bidStageProgress emerald', progress.tone === 'emerald']);
checks.push(['bidStageProgress done step', progress.stepIndex === 4]);

const progressOutcome = bidStageProgress({
    events: [{ event_type: 'reautofill_done' }],
    lastEventType: 'reautofill_done',
    courseOutcome: 'applied',
    appliedAt: '2026-09-05T00:00:00.000Z'
});
checks.push(['bidStageProgress courseOutcome applied → 100', progressOutcome.pct === 100]);

const progressRe = bidStageProgress({
    events: [{ event_type: 'reautofill_done', meta: { filled: 11 } }],
    lastEventType: 'reautofill_done'
});
checks.push(['reautofill_done alone is FILLED ~90+', progressRe.pct >= 90 && /FILLED/i.test(progressRe.label)]);
checks.push(['reautofill_done tone sky', progressRe.tone === 'sky']);

checks.push(['after_submit is proof', isProofScreenshotStage('after_submit') === true]);
checks.push(['reautofill_after not proof', isProofScreenshotStage('reautofill_after') === false]);

const filledStuck = courseRunStatus({
    outcome: 'unknown',
    last_event_type: 'reautofill_done',
    filled_at: '2026-09-05T00:00:00.000Z'
});
checks.push(['reautofill_done alone is not SUCCESS', filledStuck.kind !== 'success']);
checks.push(['reautofill_done alone is FILLED', filledStuck.kind === 'filled']);

checks.push([
    'liveStatusComment SUCCESS',
    /SUCCESS/i.test(liveStatusComment({ eventType: 'marked_applied' }))
]);

const revokedEvents = [
    { event_type: 'reautofill_done' },
    { event_type: 'marked_applied' },
    { event_type: 'success_revoked', meta: { reason: 'form_still_open' } },
    { event_type: 'fill_incomplete' }
];
const afterRevoke = lastStatusEvent(revokedEvents);
checks.push(['revoke beats older marked_applied', afterRevoke.event_type === 'fill_incomplete']);
checks.push(['isSuccessEvent ignores revoke', isSuccessEvent('success_revoked') === false]);

const progressRevoked = bidStageProgress({
    events: revokedEvents,
    lastEventType: 'fill_incomplete',
    courseOutcome: 'unknown',
    appliedAt: null
});
checks.push(['bidStageProgress after revoke not SUCCESS', progressRevoked.tone !== 'emerald']);

// Monitor engine: tab closed / budget / reautofill / AI skip
checks.push(['isTabClosedEvent tab_closed', isTabClosedEvent('tab_closed') === true]);
checks.push([
    'isTabClosedEvent item_aborted+Tab closed',
    isTabClosedEvent('item_aborted', { error: 'Tab closed' }) === true
]);
checks.push([
    'isTabClosedEvent not plain abort',
    isTabClosedEvent('item_aborted', { error: 'other' }) === false
]);
checks.push([
    'isBudgetExceededEvent bid_budget',
    isBudgetExceededEvent('bid_budget_exceeded', { limitMs: 90000 }) === true
]);
checks.push([
    'isBudgetExceededEvent item_aborted budget',
    isBudgetExceededEvent('item_aborted', { error: 'bid_time_budget_exceeded' }) === true
]);
checks.push([
    'tab_closed is not hard failure',
    isFailureEvent('tab_closed') === false
]);
checks.push([
    'item_aborted Tab closed is not hard failure',
    isFailureEvent('item_aborted', { error: 'Tab closed' }) === false
]);
checks.push([
    'bid_budget_exceeded is failure',
    isFailureEvent('bid_budget_exceeded', { limitMs: 90000 }) === true
]);
checks.push([
    'reautofill_failed is failure',
    isFailureEvent('reautofill_failed', { error: 'Tab closed' }) === true
]);

const runTab = courseRunStatus({
    outcome: 'unknown',
    last_event_type: 'tab_closed',
    updated_at: new Date().toISOString()
});
checks.push(['courseRunStatus TAB CLOSED kind', runTab.kind === 'attention']);
checks.push(['courseRunStatus TAB CLOSED short', runTab.short === 'TAB CLOSED']);

const runAbort = courseRunStatus({
    outcome: 'unknown',
    last_event_type: 'item_aborted',
    last_event_meta: { error: 'Tab closed' },
    updated_at: new Date().toISOString()
});
checks.push(['item_aborted Tab closed → attention', runAbort.kind === 'attention' && runAbort.short === 'TAB CLOSED']);

const runBudget = courseRunStatus({
    outcome: 'unknown',
    last_event_type: 'bid_budget_exceeded',
    last_event_meta: { limitMs: 90000 },
    updated_at: new Date().toISOString()
});
checks.push(['courseRunStatus TIME LIMIT', runBudget.kind === 'failed' && runBudget.short === 'TIME LIMIT']);

const runRefill = courseRunStatus({
    outcome: 'unknown',
    last_event_type: 'reautofill_failed',
    last_event_meta: { error: 'Tab closed' },
    updated_at: new Date().toISOString()
});
checks.push(['courseRunStatus RE-FILL FAIL', runRefill.kind === 'failed' && runRefill.short === 'RE-FILL FAIL']);

const progressTab = bidStageProgress({
    events: [{ event_type: 'tab_closed' }],
    lastEventType: 'tab_closed'
});
checks.push(['bidStageProgress TAB CLOSED amber', progressTab.tone === 'amber' && /TAB CLOSED/i.test(progressTab.label)]);

const progressBudget = bidStageProgress({
    events: [{ event_type: 'bid_budget_exceeded', meta: { limitMs: 90000 } }],
    lastEventType: 'bid_budget_exceeded',
    lastEventMeta: { limitMs: 90000 }
});
checks.push(['bidStageProgress TIME LIMIT rose', progressBudget.tone === 'rose' && /TIME LIMIT/i.test(progressBudget.label)]);

const progressAiSkip = bidStageProgress({
    events: [{ event_type: 'mid_fill' }, { event_type: 'ai_skipped_budget', meta: { fresh: 3 } }],
    lastEventType: 'ai_skipped_budget',
    lastEventMeta: { fresh: 3 }
});
// ai_skipped_budget is secondary — last primary mid_fill should drive fill label
checks.push(['ai_skipped_budget secondary → fill progress', /fill|Filling/i.test(progressAiSkip.label) || progressAiSkip.tone === 'sky']);

checks.push([
    'liveStatusComment tab closed',
    /Open tab.*Re-autofill/i.test(liveStatusComment({ eventType: 'tab_closed' }))
]);
checks.push([
    'liveStatusComment budget',
    /Time budget/i.test(liveStatusComment({ eventType: 'bid_budget_exceeded', meta: { limitMs: 90000 } }))
]);
checks.push([
    'liveStatusComment ai skip',
    /AI skipped/i.test(liveStatusComment({ eventType: 'ai_skipped_budget', meta: { fresh: 2 } }))
]);
checks.push([
    'liveStatusComment fill_retry willRetry',
    /retrying/i.test(liveStatusComment({ eventType: 'fill_retry', meta: { willRetry: true, filled: 4 } }))
]);
checks.push(['failureLabel Time limit', failureLabel('bid_budget_exceeded', { limitMs: 90000 }) === 'Time limit']);
checks.push(['failureLabel Tab closed', failureLabel('tab_closed') === 'Tab closed']);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed += 1;
}
if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} update-state SUCCESS checks passed.`);
