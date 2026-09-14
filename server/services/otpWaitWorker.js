// =============================================================================
// services/otpWaitWorker.js
// =============================================================================
//
// Background worker that resolves stale OTP waits for the hybrid auto-bidder.
//
// Run alongside the server (started in server/index.js). Polls for
// fill_requests stuck in awaiting_otp state and attempts to resolve them
// via otpWaitService.
//
// This is a FALLBACK worker — the primary OTP wait path is the extension
// calling POST /user/outlook/wait-otp directly (same as before). This worker
// handles cases where:
//   - Extension was offline when OTP arrived
//   - Extension crashed while waiting
//   - Server restarted during an OTP wait
//
// Polling interval: 15 seconds (configurable via OTP_WORKER_POLL_MS env).
// =============================================================================

'use strict';

const otpWaitService = require('./otpWaitService');
const fillRequestService = require('./fillRequestService');

const POLL_MS = Math.max(
    5000,
    parseInt(process.env.OTP_WORKER_POLL_MS || '15000', 10)
);

let intervalHandle = null;
let stopped = false;

/**
 * Start the OTP wait worker (call once from server/index.js).
 */
function startWorker() {
    if (intervalHandle) return;
    stopped = false;
    console.log(`[otpWorker] starting (poll interval=${POLL_MS}ms)`);

    // Run immediately, then on interval
    poll();
    intervalHandle = setInterval(poll, POLL_MS);
}

/**
 * Stop the OTP wait worker.
 */
function stopWorker() {
    if (!intervalHandle) return;
    stopped = true;
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[otpWorker] stopped');
}

async function poll() {
    if (stopped) return;
    try {
        const results = await otpWaitService.resolveStaleOtpRequests();
        if (results.length > 0) {
            console.log(`[otpWorker] resolved ${results.length} stale OTP request(s)`);
            for (const r of results) {
                if (r.ok) {
                    console.log(`  fill_request=${r.fillRequestId}: OTP=${r.code}`);
                } else {
                    console.log(`  fill_request=${r.fillRequestId}: ${r.error}`);
                }
            }
        }
    } catch (err) {
        console.warn('[otpWorker] poll error:', err.message);
    }
}

module.exports = { startWorker, stopWorker };
