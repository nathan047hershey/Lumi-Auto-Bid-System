/**
 * Bidder queue + autofill budget defaults (anti 10m redo loops).
 * Run: node extension/fixtures/test_bidder_queue_defaults.js
 */
import { BIDDER_DEFAULTS } from '../lib/bidderQueue.js';
import {
    AUTOFILL_RETRY_PER_PAGE,
    BID_HARD_LIMIT_MS
} from '../lib/autofillEngine.js';

const checks = [];

checks.push(['formWaitMs ≤ 15s', Number(BIDDER_DEFAULTS.formWaitMs) <= 15000]);
checks.push(['formWaitMs ≥ 8s', Number(BIDDER_DEFAULTS.formWaitMs) >= 8000]);
checks.push(['openGapMs ≤ 8s', Number(BIDDER_DEFAULTS.openGapMs) <= 8000]);
checks.push(['maxTabs ≥ 1', Number(BIDDER_DEFAULTS.maxTabs) >= 1]);
checks.push(['per-page retries ≤ 2', AUTOFILL_RETRY_PER_PAGE <= 2]);
checks.push(['bid hard limit ≤ 2m', BID_HARD_LIMIT_MS <= 120000]);
checks.push(['bid hard limit ≥ 60s', BID_HARD_LIMIT_MS >= 60000]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
