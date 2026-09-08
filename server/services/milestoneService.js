// =============================================================================
// Milestone workflow service (rewritten 2026-07)
// =============================================================================
// The milestone workflow was rewritten from scratch around the application
// dashboard. The new flow is:
//
//   1. USER adds the FIRST milestone on an application from the user
//      dashboard. That action auto-creates an `interview_requests` row
//      with status='requested' (the user-facing app is now visible to
//      admin as an Interview Request).
//
//   2. ADMIN sees the new Interview Request in the admin dashboard and
//      assigns it to a developer (a user with role='developer'). The
//      assignment is per-application: only the `assigned_developer_id`
//      column on `interview_requests` changes — the developer's global
//      role stays the same. Callers/users can never be promoted into
//      developers as part of this flow.
//
//   3. DEVELOPER (or admin) marks the current milestone as completed.
//      Users cannot mark a milestone complete — they only add new ones.
//
//   4. USER adds the next milestone (only after the previous one is
//      completed). The cycle continues until the application reaches
//      its conclusion, when admin can toggle the success/failed flag.
//
// All timestamps are stored as ISO-8601 UTC strings. UI converts to
// GMT-4 on display via `utils/time.js`. The picker in the UI is locked
// to GMT-4 so user-entered times are unambiguous.
// =============================================================================

const { getOne, getAll, runQuery } = require('../config/database');
const { formatGMT4 } = require('../utils/time');

// -----------------------------------------------------------------------------
// Milestone kinds (canonical list, in display order)
// -----------------------------------------------------------------------------
// The user picks one of these when adding a milestone. The kind drives
// the badge colour in the UI and any downstream routing logic.
const MILESTONE_KINDS = [
    'recruiter_reply',
    'ai_interview',
    'phone_screen',
    'video',
    'technical',
    'hiring_manager_interview',
    'panel_interview',
    'offer',
    'other'
];

const MILESTONE_KIND_LABELS = {
    recruiter_reply:          'Recruiter reply',
    ai_interview:             'AI interview',
    phone_screen:             'Phone screen',
    video:                    'Video interview',
    technical:                'Technical interview',
    hiring_manager_interview: 'Hiring manager interview',
    panel_interview:          'Panel interview',
    offer:                    'Offer',
    other:                    'Other'
};

// Kinds a developer (role='developer') is allowed to mark completed.
// Everything else (recruiter_reply, offer, other) is admin-only because
// those kinds represent business / pipeline transitions that the
// developer shouldn't drive. Admin can mark anything as complete.
const DEVELOPER_COMPLETABLE_KINDS = new Set([
    'ai_interview',
    'phone_screen',
    'video',
    'technical',
    'hiring_manager_interview',
    'panel_interview'
]);

function isMilestoneKind(kind) {
    return typeof kind === 'string' && MILESTONE_KINDS.includes(kind);
}

function labelForKind(kind) {
    return MILESTONE_KIND_LABELS[kind] || (kind ? kind.replace(/_/g, ' ') : '');
}

// -----------------------------------------------------------------------------
// Interview-request helpers
// -----------------------------------------------------------------------------

// Resolve the `interview_requests` row for an application, auto-creating
// one when the user adds their FIRST milestone. Auto-creation is what
// surfaces the application to the admin as an Interview Request.
function getOrCreateRequestForApplication(applicationId, createdBy) {
    const existing = getOne(
        `SELECT * FROM interview_requests WHERE application_id = ?`,
        [applicationId]
    );
    if (existing) return existing;
    const result = runQuery(
        `INSERT INTO interview_requests (application_id, status, created_by)
         VALUES (?, 'requested', ?)`,
        [applicationId, createdBy || null]
    );
    return getOne(`SELECT * FROM interview_requests WHERE id = ?`, [result.lastInsertRowid]);
}

// -----------------------------------------------------------------------------
// Milestone helpers
// -----------------------------------------------------------------------------

// Return all milestones for a request, ordered by position. Each row is
// decorated with `kind_label` for display. Times are returned as raw
// ISO strings — the caller is responsible for converting to GMT-4.
// We also JOIN interview_requests so each row carries `application_id`
// — clients (e.g. the developer dashboard) need this to map a milestone
// back to its parent application without an extra round-trip.
function listMilestonesForRequest(requestId) {
    if (!requestId) return [];
    const rows = getAll(
        `SELECT im.*, ir.application_id AS application_id
         FROM interview_milestones im
         JOIN interview_requests ir ON ir.id = im.interview_request_id
         WHERE im.interview_request_id = ?
         ORDER BY im.position ASC, im.id ASC`,
        [requestId]
    );
    return rows.map((m) => ({
        ...m,
        kind_label: labelForKind(m.kind),
        scheduled_at_display: m.scheduled_at ? formatGMT4(m.scheduled_at) : '',
        completed_at_display: m.completed_at ? formatGMT4(m.completed_at) : ''
    }));
}

// Convenience: milestones for an application (resolves requestId first).
function listMilestonesForApplication(applicationId) {
    const req = getOne(
        `SELECT id FROM interview_requests WHERE application_id = ?`,
        [applicationId]
    );
    if (!req) return [];
    return listMilestonesForRequest(req.id);
}

// Most recently added milestone (highest position).
function getLatestMilestone(requestId) {
    if (!requestId) return null;
    return getOne(
        `SELECT * FROM interview_milestones
         WHERE interview_request_id = ?
         ORDER BY position DESC, id DESC
         LIMIT 1`,
        [requestId]
    );
}

// Latest milestone for many applications in one query — used by the
// list endpoints to decorate rows without an N+1.
function getLatestMilestonesForApplications(applicationIds) {
    const map = new Map();
    if (!Array.isArray(applicationIds) || applicationIds.length === 0) return map;
    const placeholders = applicationIds.map(() => '?').join(',');
    const rows = getAll(
        `SELECT ir.application_id AS application_id, im.*
         FROM interview_milestones im
         JOIN interview_requests ir ON im.interview_request_id = ir.id
         WHERE ir.application_id IN (${placeholders})
           AND im.id = (
                SELECT im2.id FROM interview_milestones im2
                WHERE im2.interview_request_id = im.interview_request_id
                ORDER BY im2.position DESC, im2.id DESC
                LIMIT 1
           )`,
        applicationIds
    );
    for (const r of rows) {
        map.set(r.application_id, r);
    }
    return map;
}

// Compute (total, completed, current) for a list of milestones so the
// UI can render the stepper.
function summariseMilestones(milestones) {
    const total = milestones.length;
    const completed = milestones.filter((m) => !!m.completed_at).length;
    // The "current" milestone is the first one not yet completed.
    const current = milestones.find((m) => !m.completed_at) || null;
    return { total, completed, current };
}

// Append a new milestone. `scheduledAt` may be null when the user
// doesn't know the time yet (e.g. "Recruiter reply" with no date).
//
// The four optional `*Detail` / `*Message` / `*Link` fields mirror the
// columns on `interview_milestones` so each step can carry its own
// per-milestone context (recruiter message, user reply, meeting URL,
// AI-screener notes). We accept them here AND in the route-layer
// `cleanMilestoneAddInput` so the user-side MilestoneList can persist
// the full detail form in one round-trip — previously these fields
// were silently dropped, which is why the modal showed empty after
// the user saved interview link / recruiter detail.
//
// Each text field is trimmed; an empty string after trim is stored as
// NULL so the column genuinely reflects "no detail captured" instead
// of an empty string.
//
// Returns the new milestone row. The `position` is auto-assigned to
// MAX(position)+1 so existing milestones keep their order.
function addMilestone({
    requestId,
    kind,
    label,
    scheduledAt,
    memo,
    addedBy,
    recruiterMessage,
    replyMessage,
    interviewLink,
    aiInterviewDetail
}) {
    if (!requestId) throw new Error('requestId is required');
    if (!isMilestoneKind(kind)) throw new Error(`Invalid milestone kind: ${kind}`);

    const pos = getOne(
        `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos
         FROM interview_milestones WHERE interview_request_id = ?`,
        [requestId]
    );
    const nextPos = pos?.next_pos ?? 0;
    const effectiveLabel = label && label.trim() ? label.trim() : labelForKind(kind);
    const trimToNull = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

    const result = runQuery(
        `INSERT INTO interview_milestones
            (interview_request_id, kind, milestone_type, label, scheduled_at,
             memo, position, added_by,
             recruiter_message, reply_message, interview_link, ai_interview_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            requestId,
            kind,
            kind,
            effectiveLabel,
            scheduledAt || null,
            memo || null,
            nextPos,
            addedBy || null,
            trimToNull(recruiterMessage),
            trimToNull(replyMessage),
            trimToNull(interviewLink),
            trimToNull(aiInterviewDetail)
        ]
    );

    // Touch the parent request + remember who added the last milestone
    // (admin dashboard uses this to badge "recently updated by X").
    runQuery(
        `UPDATE interview_requests
         SET updated_at = CURRENT_TIMESTAMP,
             last_milestone_added_by = ?
         WHERE id = ?`,
        [addedBy || null, requestId]
    );

    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [result.lastInsertRowid]);
}

// Mark a milestone completed. `completedBy` is the user id who flipped
// the flag — required so we can enforce the permission rule (only
// developer/admin can complete) at the caller, plus record who did it.
//
// Optional `actualAt` lets the caller supply the real interview time
// (when the developer actually finished the call rather than the
// wall-clock "now" — they're often logging it from memory minutes
// later). Optional `memo` updates the free-form notes so the developer
// can capture what happened (passed/failed/followups/etc.) in the
// same form. Optional `durationMinutes` captures how long the
// interview actually ran (in MINUTES) — typical values are 30, 45, 60.
// We coerce to a positive integer and clamp the upper bound at 24h
// (1440 minutes) so a typo like `9999` doesn't poison the audit
// trail. A missing / null value is left as NULL on the row so the
// column genuinely reflects "unknown" rather than "0".
function completeMilestone(milestoneId, completedBy, { actualAt, memo, durationMinutes } = {}) {
    if (!milestoneId) throw new Error('milestoneId is required');
    const stamp = (actualAt && !Number.isNaN(new Date(actualAt).getTime()))
        ? new Date(actualAt).toISOString()
        : new Date().toISOString();
    const setClauses = [
        'completed_at = ?',
        'completed_by = ?',
        'updated_at = CURRENT_TIMESTAMP'
    ];
    const params = [stamp, completedBy || null];
    if (memo !== undefined && memo !== null) {
        setClauses.push('memo = ?');
        params.push(String(memo).trim() || null);
    }
    if (durationMinutes !== undefined && durationMinutes !== null && durationMinutes !== '') {
        const n = parseInt(durationMinutes, 10);
        if (Number.isFinite(n) && n > 0 && n <= 1440) {
            setClauses.push('duration_minutes = ?');
            params.push(n);
        }
    }
    params.push(milestoneId);
    runQuery(
        `UPDATE interview_milestones
         SET ${setClauses.join(', ')}
         WHERE id = ?`,
        params
    );
    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
}

// Un-complete a milestone (admin override). Used when an admin needs to
// re-open a step the developer closed too early.
function uncompleteMilestone(milestoneId) {
    runQuery(
        `UPDATE interview_milestones
         SET completed_at = NULL, completed_by = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [milestoneId]
    );
    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
}

// Approval workflow. Admins approve a completed milestone once the
// interview has been verified — this gates the developer's "approved
// interview time" rollup. We enforce "must be completed first" so a
// milestone can never be approved before the developer closes it.
// We also auto-clear the paid flag when un-approving — paying an
// un-approved milestone makes no sense, so the admin re-runs the
// full approval → pay cycle.
function approveMilestone(milestoneId, approvedBy) {
    if (!milestoneId) throw new Error('milestoneId is required');
    const m = getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
    if (!m) throw new Error('Milestone not found');
    if (!m.completed_at) {
        throw new Error('Cannot approve a milestone that is not yet completed');
    }
    runQuery(
        `UPDATE interview_milestones
         SET approved = 1,
             approved_by = ?,
             approved_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [approvedBy || null, milestoneId]
    );
    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
}

function unapproveMilestone(milestoneId) {
    runQuery(
        `UPDATE interview_milestones
         SET approved = 0,
             approved_by = NULL,
             approved_at = NULL,
             -- If it was paid, auto-unpay since the audit trail
             -- requires the approve → pay order.
             paid = 0,
             paid_by = NULL,
             paid_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [milestoneId]
    );
    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
}

// Payment workflow. An admin marks an approved milestone as paid once
// the invoice is settled. Requires approved=1 — paying an un-approved
// milestone would skip the verification step.
function payMilestone(milestoneId, paidBy) {
    if (!milestoneId) throw new Error('milestoneId is required');
    const m = getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
    if (!m) throw new Error('Milestone not found');
    if (!m.approved) {
        throw new Error('Cannot pay a milestone that is not yet approved');
    }
    runQuery(
        `UPDATE interview_milestones
         SET paid = 1,
             paid_by = ?,
             paid_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [paidBy || null, milestoneId]
    );
    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
}

function unpayMilestone(milestoneId) {
    runQuery(
        `UPDATE interview_milestones
         SET paid = 0,
             paid_by = NULL,
             paid_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [milestoneId]
    );
    return getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
}

// Sum the duration (in MINUTES) of every approved milestone across
// the rows passed in. Returns 0 when no approved rows are present.
// Used by the developer dashboard's "total approved interview time"
// rollup so the developer can see how much billable time their
// approved interviews add up to.
function totalApprovedDurationMinutes(milestones) {
    if (!Array.isArray(milestones) || milestones.length === 0) return 0;
    return milestones
        .filter((m) => !!m.approved && Number.isFinite(parseInt(m.duration_minutes, 10)))
        .reduce((sum, m) => sum + parseInt(m.duration_minutes, 10), 0);
}

// Delete a milestone (admin only). Re-sequences `position` so the list
// stays contiguous after the delete.
function deleteMilestone(milestoneId) {
    const m = getOne(`SELECT * FROM interview_milestones WHERE id = ?`, [milestoneId]);
    if (!m) return false;
    runQuery(`DELETE FROM interview_milestones WHERE id = ?`, [milestoneId]);
    // Re-sequence positions for the parent request so the next read
    // returns 0,1,2,...
    const rows = getAll(
        `SELECT id FROM interview_milestones
         WHERE interview_request_id = ?
         ORDER BY position ASC, id ASC`,
        [m.interview_request_id]
    );
    rows.forEach((r, i) => {
        runQuery(
            `UPDATE interview_milestones SET position = ? WHERE id = ?`,
            [i, r.id]
        );
    });
    return true;
}

// -----------------------------------------------------------------------------
// Permission helpers
// -----------------------------------------------------------------------------

// A user is allowed to mark a milestone complete if they are:
//   - an admin (admin can complete ANY kind)
//   - the developer assigned to the interview_request, AND the
//     milestone's kind is in the developer-completable whitelist
//     (DEVELOPER_COMPLETABLE_KINDS). Recruiter replies, offers, and
//     generic "other" steps are admin-only because they represent
//     business / pipeline transitions outside the developer's scope.
//
// A regular user (the original poster) is NOT allowed to complete.
//
// Returns { allowed: boolean, reason?: string } so the caller can
// distinguish "wrong role" from "wrong kind for this role" in the UI.

// Return every role held by a user — the primary `users.role` plus any
// additional roles stored in `user_roles`. Returns a de-duplicated
// array of strings (e.g. `['admin']`, `['user', 'developer']`). Used
// by the permission helpers in this file and by route handlers that
// need to gate side-effects (completing milestones, assigning
// developers, etc.).
function getUserRoles(userId) {
    if (!userId) return [];
    const rows = getAll(
        `SELECT role FROM (
             SELECT role FROM users WHERE id = ?
             UNION
             SELECT role FROM user_roles WHERE user_id = ?
         )`,
        [userId, userId]
    );
    return Array.from(new Set(rows.map((r) => r.role).filter(Boolean)));
}

function canCompleteMilestone({ userId, userRoles, requestId, milestoneKind }) {
    if (!userId) return { allowed: false, reason: 'unauthenticated' };
    if (Array.isArray(userRoles) && userRoles.includes('admin')) {
        return { allowed: true };
    }
    // Look up the kind if not supplied — the caller might have only
    // the request id handy and we still want to enforce the kind rule.
    let kind = milestoneKind;
    if (!kind && requestId) {
        const current = getOne(
            `SELECT m.kind FROM interview_milestones m
             WHERE m.interview_request_id = ?
             ORDER BY m.position DESC, m.id DESC LIMIT 1`,
            [requestId]
        );
        kind = current?.kind;
    }
    const req = getOne(
        `SELECT assigned_developer_id FROM interview_requests WHERE id = ?`,
        [requestId]
    );
    const isAssignedDeveloper = req?.assigned_developer_id === userId;
    if (!isAssignedDeveloper) {
        return { allowed: false, reason: 'not-assigned-developer' };
    }
    if (kind && !DEVELOPER_COMPLETABLE_KINDS.has(kind)) {
        return {
            allowed: false,
            reason: 'kind-not-developer-completable',
            kind
        };
    }
    return { allowed: true };
}

// A user is allowed to ADD a milestone if they are:
//   - an admin (any time)
//   - the application's owner (caller/user) — BUT only when the
//     previous milestone is completed (enforced by the caller)
//   - the developer assigned to the interview_request — also only
//     when the previous milestone is completed.
//
// Returns boolean for the simple admin/owner case. The caller is
// responsible for the "previous completed" check before delegating
// here — see `POST /api/user/milestones/:applicationId`.
function canAddMilestone({ userId, userRoles, applicationOwnerId, requestId }) {
    if (!userId) return false;
    if (Array.isArray(userRoles) && userRoles.includes('admin')) return true;
    if (applicationOwnerId === userId) return true;
    if (requestId) {
        const req = getOne(
            `SELECT assigned_developer_id FROM interview_requests WHERE id = ?`,
            [requestId]
        );
        if (req?.assigned_developer_id === userId) return true;
    }
    return false;
}

// -----------------------------------------------------------------------------
// Developer assignment
// -----------------------------------------------------------------------------

// Assign (or unassign) a developer to an interview_request. The target
// user MUST have role='developer' (either as their primary role or as
// an additional role via `user_roles`) — the caller is expected to
// enforce that, but we double-check here as defence in depth.
function assignDeveloper(requestId, developerUserId) {
    if (!requestId) throw new Error('requestId is required');
    if (developerUserId) {
        const u = getOne(
            `SELECT id FROM users
             WHERE id = ?
               AND (role = 'developer'
                    OR id IN (SELECT user_id FROM user_roles WHERE role = 'developer'))`,
            [developerUserId]
        );
        if (!u) throw new Error('Target user is not a developer');
    }
    runQuery(
        `UPDATE interview_requests
         SET assigned_developer_id = ?,
             assigned_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [developerUserId || null, developerUserId ? new Date().toISOString() : null, requestId]
    );
    return getOne(`SELECT * FROM interview_requests WHERE id = ?`, [requestId]);
}

// -----------------------------------------------------------------------------
// Application flags
// -----------------------------------------------------------------------------

// Toggle the success / failed / cancelled flags on an application.
// Non-terminal — all three flags can be set independently and the
// application stays editable. The admin can flip any of them on or
// off without locking the workflow.
function setApplicationFlags(applicationId, { success, failed, cancelled, setBy }) {
    if (!applicationId) throw new Error('applicationId is required');
    runQuery(
        `UPDATE job_applications
         SET success_flag = ?, failed_flag = ?, cancelled_flag = ?,
             flags_set_by = ?, flags_set_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [success ? 1 : 0, failed ? 1 : 0, cancelled ? 1 : 0, setBy || null, applicationId]
    );
    return getOne(`SELECT * FROM job_applications WHERE id = ?`, [applicationId]);
}

module.exports = {
    MILESTONE_KINDS,
    MILESTONE_KIND_LABELS,
    DEVELOPER_COMPLETABLE_KINDS,
    isMilestoneKind,
    labelForKind,
    getOrCreateRequestForApplication,
    listMilestonesForRequest,
    listMilestonesForApplication,
    getLatestMilestone,
    getLatestMilestonesForApplications,
    summariseMilestones,
    addMilestone,
    completeMilestone,
    uncompleteMilestone,
    deleteMilestone,
    approveMilestone,
    unapproveMilestone,
    payMilestone,
    unpayMilestone,
    totalApprovedDurationMinutes,
    canCompleteMilestone,
    canAddMilestone,
    assignDeveloper,
    setApplicationFlags,
    getUserRoles
};
