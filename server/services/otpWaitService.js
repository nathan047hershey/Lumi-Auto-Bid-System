// =============================================================================
// services/otpWaitService.js
// =============================================================================
//
// OTP wait logic for the hybrid auto-bidder.
// Reuses the existing outlookMail.waitForOtp() which already polls both
// Outlook Graph and Gmail IMAP, handles SMS gateways, and extracts codes.
//
// This service is called by:
//   1. The extension (directly via POST /user/outlook/wait-otp) — same as before
//   2. The optional otpWaitWorker (recovery/fallback when extension is offline)
//
// No new mail polling code — we delegate entirely to outlookMail.waitForOtp().
// =============================================================================

'use strict';

const outlookMail = require('./outlookMailService');
const fillRequestService = require('./fillRequestService');
const {
    getOne,
    getAll,
    runQuery,
    saveDatabase
} = require('../config/database');

const OTP_WAIT_TIMEOUT_MS = parseInt(process.env.OTP_WAIT_TIMEOUT_MS || '720000', 10);  // 12 min
const OTP_WAIT_POLL_MS    = parseInt(process.env.OTP_WAIT_POLL_MS || '5000', 10);

/**
 * Wait for an OTP for a specific fill_request.
 *
 * Called by otpWaitWorker when the extension is offline and a fill_request
 * is stuck in awaiting_otp state. Also called by the extension directly
 * via POST /user/outlook/wait-otp (the original path, unchanged).
 *
 * @param {number} fillRequestId
 * @param {object} opts
 * @param {number} opts.timeoutMs
 * @param {number} opts.pollMs
 * @param {string} opts.fromHint
 * @returns {object} { ok, code?, error? }
 */
async function waitForOtpForFillRequest(fillRequestId, opts = {}) {
    const { timeoutMs = OTP_WAIT_TIMEOUT_MS, pollMs = OTP_WAIT_POLL_MS } = opts;

    const fr = fillRequestService.getFillRequest(fillRequestId);
    if (!fr) {
        return { ok: false, error: 'fill_request_not_found' };
    }

    // Get the user who owns this fill_request
    const userRow = getOne(
        `SELECT u.id, u.username
           FROM users u
           JOIN user_profile_assignments upa ON upa.user_id = u.id
          WHERE upa.profile_id = ?
          LIMIT 1`,
        [fr.profile_id]
    );
    if (!userRow) {
        return { ok: false, error: 'no_user_found' };
    }

    // Determine afterIso — look for OTPs received after the OTP wait started
    const afterIso = fr.otp_started_at
        ? new Date(new Date(fr.otp_started_at).getTime() - 120 * 1000).toISOString()
        : new Date(Date.now() - 120 * 1000).toISOString();

    // Call the existing waitForOtp — polls all connected Outlook + Gmail mailboxes
    const result = await outlookMail.waitForOtp(userRow.id, {
        timeoutMs,
        pollMs,
        afterIso,
        fromHint: 'greenhouse'
    });

    if (result?.ok && result?.code) {
        // Record the OTP code on the fill_request
        fillRequestService.setOtpCode(fillRequestId, result.code);
        return { ok: true, code: result.code, subject: result.subject, from: result.from };
    }

    return { ok: false, error: result?.error || 'otp_timeout' };
}

/**
 * Find all fill_requests stuck in awaiting_otp and attempt to resolve them.
 * Called by the otpWaitWorker on each poll cycle.
 *
 * @param {number} timeoutMs - how long to wait per request (default 12 min)
 * @returns {Array} results for each processed request
 */
async function resolveStaleOtpRequests(timeoutMs = OTP_WAIT_TIMEOUT_MS) {
    const stale = fillRequestService.getStaleOtpRequests(timeoutMs, 999); // get all, let service decide
    const results = [];

    for (const fr of stale) {
        // Skip if still within timeout window
        if (fr.otp_started_at) {
            const startedMs = new Date(fr.otp_started_at).getTime();
            if (Date.now() - startedMs < timeoutMs) continue;
        }

        console.log(`[otpWait] resolving fill_request=${fr.id} (started=${fr.otp_started_at})`);
        const result = await waitForOtpForFillRequest(fr.id, { timeoutMs });
        results.push({ fillRequestId: fr.id, ...result });
    }

    return results;
}

module.exports = {
    waitForOtpForFillRequest,
    resolveStaleOtpRequests
};
