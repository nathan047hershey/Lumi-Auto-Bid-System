// =============================================================================
// services/fillRequestService.js
// =============================================================================
//
// Manages fill_request rows for the hybrid auto-bidder OTP flow:
//   - Server generates resume (done by jobMatchService)
//   - Server creates a fill_request to signal the extension to fill the form
//   - Extension polls for pending requests, fills the form
//   - If OTP page encountered, extension calls server's wait-otp endpoint
//   - Extension marks fill_request complete/failed via PATCH
//
// No RabbitMQ needed here — the extension polls via REST. Cleanup is handled
// by jobMatchService.tick() and the optional otpWaitWorker.
// =============================================================================

'use strict';

const {
    getOne,
    getAll,
    runQuery,
    saveDatabase
} = require('../config/database');

// Valid statuses
const STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'awaiting_otp'];

/**
 * Create a new fill_request for an auto-generated application.
 * Called by jobMatchService after resume is ready.
 *
 * @param {number} applicationId  - job_applications.id
 * @param {number} profileId      - candidate_profiles.id
 * @param {number} jobLinkId     - job_links.id
 * @returns {object}              - the newly created fill_request row
 */
function createFillRequest(applicationId, profileId, jobLinkId) {
    const result = runQuery(
        `INSERT INTO fill_requests
           (application_id, profile_id, job_link_id, status, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))`,
        [applicationId, profileId, jobLinkId]
    );
    saveDatabase();
    const id = result?.lastInsertRowid;
    return getOne('SELECT * FROM fill_requests WHERE id = ?', [id]);
}

/**
 * Get pending fill requests, optionally scoped to a specific user's profiles.
 * Extension calls this via GET /user/auto-apply/fill-requests/pending.
 *
 * @param {number} limit
 * @param {number|null} userId  - if provided, only requests for this user's profiles
 * @returns {Array}
 */
function getPendingFillRequests(limit = 10, userId = null) {
    let sql = `
        SELECT fr.*,
               cp.first_name, cp.last_name, cp.email AS candidate_email,
               cp.phone AS candidate_phone,
               jl.company_name, jl.position_title, jl.job_apply_url, jl.source_url,
               ja.resume_filename, ja.job_description
        FROM fill_requests fr
        JOIN candidate_profiles cp ON cp.id = fr.profile_id
        JOIN job_links jl ON jl.id = fr.job_link_id
        JOIN job_applications ja ON ja.id = fr.application_id
    `;
    const params = [];
    if (userId) {
        sql += `
            JOIN user_profile_assignments upa ON upa.profile_id = fr.profile_id
            WHERE fr.status = 'pending' AND upa.user_id = ?
        `;
        params.push(userId);
    } else {
        sql += ` WHERE fr.status = 'pending' `;
    }
    sql += ` ORDER BY fr.created_at ASC LIMIT ?`;
    params.push(limit);
    return getAll(sql, params);
}

/**
 * Get a single fill_request by id.
 */
function getFillRequest(id) {
    return getOne('SELECT * FROM fill_requests WHERE id = ?', [id]);
}

/**
 * Mark a fill_request as in_progress (extension started filling it).
 */
function markInProgress(id) {
    runQuery(
        `UPDATE fill_requests
            SET status = 'in_progress', updated_at = datetime('now')
          WHERE id = ?`,
        [id]
    );
    saveDatabase();
}

/**
 * Mark a fill_request as completed (form submitted successfully).
 */
function markCompleted(id) {
    runQuery(
        `UPDATE fill_requests
            SET status = 'completed',
                updated_at = datetime('now')
          WHERE id = ?`,
        [id]
    );
    // Also update the parent job_application
    const fr = getFillRequest(id);
    if (fr) {
        runQuery(
            `UPDATE job_applications
                SET status = 'applied',
                    filled_at = datetime('now'),
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`,
            [fr.application_id]
        );
    }
    saveDatabase();
}

/**
 * Mark a fill_request as failed with an error message.
 */
function markFailed(id, error = null) {
    runQuery(
        `UPDATE fill_requests
            SET status = 'failed',
                error = ?,
                updated_at = datetime('now')
          WHERE id = ?`,
        [error ? String(error).slice(0, 500) : null, id]
    );
    saveDatabase();
}

/**
 * Mark a fill_request as awaiting_otp (extension detected a security code page).
 * Records when the OTP wait started so we can compute timeout.
 */
function markAwaitingOtp(id) {
    runQuery(
        `UPDATE fill_requests
            SET status = 'awaiting_otp',
                otp_started_at = datetime('now'),
                retry_count = retry_count + 1,
                updated_at = datetime('now')
          WHERE id = ?`,
        [id]
    );
    saveDatabase();
}

/**
 * Record the OTP code on a fill_request (found by waitForOtp and returned to extension).
 */
function setOtpCode(id, code) {
    runQuery(
        `UPDATE fill_requests
            SET otp_code = ?,
                status = 'pending',
                updated_at = datetime('now')
          WHERE id = ?`,
        [String(code).slice(0, 20), id]
    );
    // Also store on the parent job_applications for display
    const fr = getFillRequest(id);
    if (fr) {
        runQuery(
            `UPDATE job_applications
                SET otp_code = ?
              WHERE id = ?`,
            [String(code).slice(0, 20), fr.application_id]
        );
    }
    saveDatabase();
}

/**
 * Get fill_requests that are stuck in awaiting_otp beyond the timeout.
 * The cleanup job (otpWaitWorker) uses this to either reset to pending
 * (if retries remain) or mark failed.
 *
 * @param {number} timeoutMs
 * @param {number} maxRetries
 * @returns {Array} stale fill_requests
 */
function getStaleOtpRequests(timeoutMs = 720000, maxRetries = 2) {
    const cutoffSec = Math.floor(timeoutMs / 1000);
    return getAll(
        `SELECT * FROM fill_requests
          WHERE status = 'awaiting_otp'
            AND otp_started_at < datetime('now', '-' || ? || ' seconds')
        `,
        [cutoffSec]
    );
}

/**
 * Get fill_requests that are stuck in pending (extension never picked them up).
 * @param {number} timeoutMs
 * @returns {Array}
 */
function getStalePendingRequests(timeoutMs = 600000) {
    const cutoffSec = Math.floor(timeoutMs / 1000);
    return getAll(
        `SELECT * FROM fill_requests
          WHERE status = 'pending'
            AND created_at < datetime('now', '-' || ? || ' seconds')
        `,
        [cutoffSec]
    );
}

/**
 * Count of pending fill requests (for status reporting).
 */
function getPendingCount() {
    const r = getOne(`SELECT COUNT(*) AS n FROM fill_requests WHERE status = 'pending'`);
    return r?.n || 0;
}

/**
 * Count of awaiting_otp fill requests.
 */
function getAwaitingOtpCount() {
    const r = getOne(`SELECT COUNT(*) AS n FROM fill_requests WHERE status = 'awaiting_otp'`);
    return r?.n || 0;
}

module.exports = {
    createFillRequest,
    getPendingFillRequests,
    getFillRequest,
    markInProgress,
    markCompleted,
    markFailed,
    markAwaitingOtp,
    setOtpCode,
    getStaleOtpRequests,
    getStalePendingRequests,
    getPendingCount,
    getAwaitingOtpCount,
    STATUSES
};
