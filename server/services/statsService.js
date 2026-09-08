const { getAll, getOne } = require('../config/database');
const { getCurrentWorkdayEST, nowAsESTISOString, toSqlDateTime } = require('../utils/time');

/**
 * Build the standard period blocks returned by /api/user/stats and
 * /api/admin/stats. Each period is the same shape so both dashboards
 * share one timeline component.
 *
 * @returns {{
 *   periods: Array<{ key, label, start: Date, end: Date }>,
 *   now: Date
 * }}
 */
function getStandardPeriods(now = new Date()) {
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const workdayRange = getCurrentWorkdayEST(now);

    return {
        now,
        periods: [
            { key: 'workday', label: 'Workday (7am GMT-4 → 7am GMT-4)', start: workdayRange.start, end: workdayRange.end },
            { key: 'week', label: '1 Week', start: lastWeek, end: now },
            { key: 'month', label: '1 Month', start: lastMonth, end: now }
        ]
    };
}

/**
 * Compute top tech stacks for a list of applications, returning:
 *   { topTechStack, topTechStackCount, techStacks: [{ skill, count }] }
 *
 * Skills are split on comma / semicolon / pipe delimiters.
 */
function computeTopTechStacks(apps) {
    const skillCounts = {};
    for (const app of apps) {
        if (app.core_skills) {
            const skills = app.core_skills.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
            for (const skill of skills) {
                const key = skill.toLowerCase();
                skillCounts[key] = (skillCounts[key] || 0) + 1;
            }
        }
    }

    let topSkill = null;
    let topSkillDisplay = null;
    let maxCount = 0;
    for (const [skill, count] of Object.entries(skillCounts)) {
        if (count > maxCount) {
            maxCount = count;
            topSkill = skill;
            // Preserve original casing from first occurrence
            for (const app of apps) {
                if (app.core_skills) {
                    const skills = app.core_skills.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
                    const match = skills.find((s) => s.toLowerCase() === skill);
                    if (match) {
                        topSkillDisplay = match;
                        break;
                    }
                }
            }
        }
    }

    const allTechStacks = Object.entries(skillCounts)
        .map(([skill, count]) => ({ skill, count }))
        .sort((a, b) => b.count - a.count);

    return {
        topTechStack: topSkillDisplay,
        topTechStackCount: maxCount,
        techStacks: allTechStacks
    };
}

/**
 * Build hourly buckets for the workday window (7am EST today → 7am EST
 * tomorrow). Returns 24 array slots, one per hour, with:
 *   - hourLabel: e.g. "7am", "8am"
 *   - hourEST: ISO datetime for that hour
 *   - applied: cumulative count of "applied" applications up to and
 *              including that hour (so the line shows growth over the day).
 *   - newApplied: applications created strictly within this 1-hour
 *              bucket (delta).
 *   - newScheduled: interviews scheduled in this bucket.
 *
 * Cumulative lines are easier to read on small dashboards. Deltas are
 * also exposed for clients that prefer bar-style presentation.
 *
 * `whereClause` and `whereParams` are appended to all queries. They
 * must NOT contain a leading "WHERE" word.
 */
function buildHourlyWorkdayBuckets({ start, end, whereClause = '', whereParams = [] }) {
    const buckets = [];
    const startMs = start.getTime();
    const endMs = end.getTime();

    for (let i = 0; i < 24; i++) {
        const hourStart = new Date(startMs + i * 60 * 60 * 1000);
        const hourEnd = new Date(startMs + (i + 1) * 60 * 60 * 1000);
        const label = formatESTHourLabel(hourStart);
        buckets.push({
            index: i,
            hourEST: hourStart.toISOString(),
            hourLabel: label,
            hourStartISO: toSqlDateTime(hourStart),
            hourEndISO: toSqlDateTime(hourEnd),
            newApplied: 0,
            newScheduled: 0,
            applied: 0
        });
    }

    // Delta counts per bucket. The day-applied/newScheduled/cumulative queries
    // reference tables via aliases (`a`, `i`) consistent across this file.
    const newAppliedRows = getAll(
        `
        SELECT strftime('%Y-%m-%d %H:00:00', a.created_at) as bucket_hour, COUNT(*) as count
        FROM job_applications a
        WHERE a.created_at >= ? AND a.created_at < ?
          ${whereClause ? `AND ${whereClause}` : ''}
          AND a.status = 'applied'
        GROUP BY bucket_hour
        `,
        [toSqlDateTime(start), toSqlDateTime(end), ...whereParams]
    );
    for (const row of newAppliedRows) {
        const idx = buckets.findIndex((b) => b.hourStartISO === row.bucket_hour);
        if (idx >= 0) buckets[idx].newApplied = row.count;
    }

    const newScheduledRows = getAll(
        `
        SELECT strftime('%Y-%m-%d %H:00:00', i.created_at) as bucket_hour, COUNT(DISTINCT i.id) as count
        FROM interviews i
        JOIN job_applications a ON i.application_id = a.id
        WHERE i.status = 'scheduled'
          AND i.created_at >= ? AND i.created_at < ?
          ${whereClause ? `AND ${whereClause}` : ''}
        GROUP BY bucket_hour
        `,
        [toSqlDateTime(start), toSqlDateTime(end), ...whereParams]
    );
    for (const row of newScheduledRows) {
        const idx = buckets.findIndex((b) => b.hourStartISO === row.bucket_hour);
        if (idx >= 0) buckets[idx].newScheduled = row.count;
    }

    // Cumulative "applied" count up to each bucket end
    for (const bucket of buckets) {
        const upToEnd = getOne(
            `
            SELECT COUNT(*) as count
            FROM job_applications a
            WHERE a.created_at <= ?
              ${whereClause ? `AND ${whereClause}` : ''}
              AND a.status = 'applied'
            `,
            [bucket.hourEndISO, ...whereParams]
        );
        bucket.applied = upToEnd?.count || 0;
    }

    return buckets;
}

/**
 * Build per-day buckets for any period window.
 * Returns [{ date, label, applied, replied, scheduled }]
 */
function buildDailyBuckets({ start, end, whereClause = '', whereParams = [] }) {
    const startISO = toSqlDateTime(start);
    const endISO = toSqlDateTime(end);

    const appliedRows = getAll(
        `
        SELECT date(a.created_at) as day, COUNT(*) as count
        FROM job_applications a
        WHERE a.created_at >= ? AND a.created_at <= ?
          ${whereClause ? `AND ${whereClause}` : ''}
          AND a.status = 'applied'
        GROUP BY day
        ORDER BY day
        `,
        [startISO, endISO, ...whereParams]
    );

    const repliedRows = getAll(
        `
        SELECT date(ir.recruiter_reply_at) as day, COUNT(DISTINCT a.id) as count
        FROM job_applications a
        JOIN interview_requests ir ON ir.application_id = a.id
        WHERE ir.recruiter_reply_at >= ? AND ir.recruiter_reply_at <= ?
          ${whereClause ? `AND ${whereClause}` : ''}
          AND ir.recruiter_reply_at IS NOT NULL
        GROUP BY day
        ORDER BY day
        `,
        [startISO, endISO, ...whereParams]
    );

    const scheduledRows = getAll(
        `
        SELECT date(i.created_at) as day, COUNT(DISTINCT i.id) as count
        FROM interviews i
        JOIN job_applications a ON i.application_id = a.id
        WHERE i.status = 'scheduled'
          AND i.created_at >= ? AND i.created_at <= ?
          ${whereClause ? `AND ${whereClause}` : ''}
        GROUP BY day
        ORDER BY day
        `,
        [startISO, endISO, ...whereParams]
    );

    const appliedMap = Object.fromEntries((appliedRows || []).map((r) => [r.day, r.count]));
    const repliedMap = Object.fromEntries((repliedRows || []).map((r) => [r.day, r.count]));
    const scheduledMap = Object.fromEntries((scheduledRows || []).map((r) => [r.day, r.count]));

    const days = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());

    while (cursor <= last) {
        const dateStr = cursor.toISOString().slice(0, 10);
        days.push({
            date: dateStr,
            label: cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            applied: appliedMap[dateStr] || 0,
            replied: repliedMap[dateStr] || 0,
            scheduled: scheduledMap[dateStr] || 0
        });
        cursor.setDate(cursor.getDate() + 1);
    }

    if (days.length > 31) {
        return days.map((d, i) => ({
            ...d,
            label: i % Math.ceil(days.length / 14) === 0 ? d.label : ''
        }));
    }

    return days;
}

/**
 * Build a per-profile / per-user ownership filter for queries.
 *
 * Admin scope: when no userIds are supplied, returns no filter (all
 * profiles). When userIds supplied, returns a sub-query that only
 * matches profiles assigned to those users. For a single user id the
 * inner query becomes trivial.
 *
 * User scope: always restricts to the requesting user.
 */
function buildOwnershipFilterClause(scope, reqUserId, userIds) {
    if (scope === 'user') {
        return {
            clause: 'a.profile_id IN (SELECT profile_id FROM user_profile_assignments WHERE user_id = ?)',
            params: [reqUserId]
        };
    }
    // admin scope
    if (Array.isArray(userIds) && userIds.length > 0) {
        const placeholders = userIds.map(() => '?').join(',');
        // Match profiles assigned to ANY of the supplied users.
        // (Note: profile can be assigned to multiple users; we include
        // any application whose profile is in the set.)
        return {
            clause: `a.profile_id IN (
                SELECT profile_id FROM user_profile_assignments WHERE user_id IN (${placeholders})
            )`,
            params: userIds.map((u) => Number(u)).filter((n) => Number.isFinite(n))
        };
    }
    return { clause: '1=1', params: [] };
}

/**
 * Build the per-user breakdown used by the admin dashboard.
 *
 * For each user with at least one assigned profile:
 *   - username
 *   - profileIds
 *   - per period: appliedCount, scheduledCount, successRate
 *   - activePeriod (optional): per-user counts for the admin's chosen period
 *   - topTechStack (overall, by scheduled interviews)
 *   - profileStats: per-profile status counts (so the admin can see how
 *     each linked profile contributes to the totals)
 *   - profileLinks: every user_profile_assignments row linking this
 *     user to a profile (id, since) — useful for auditability of the
 *     link topology
 *
 * Honors the same userIds filter so admins can scope to "just Bongo's
 * team" without rewriting the query.
 */
function buildUserBreakdown({ periods, userIds = [], activePeriod = null }) {
    try {
    const profileFilter = userIds.length > 0
        ? `AND p.id IN (
            SELECT profile_id FROM user_profile_assignments WHERE user_id IN (${userIds.map(() => '?').join(',')})
        )`
        : '';

    // All users who own at least one profile (optionally filtered)
    const userRows = getAll(
        `
        SELECT DISTINCT u.id, u.username
        FROM users u
        JOIN user_profile_assignments upa ON upa.user_id = u.id
        ${userIds.length > 0
            ? `WHERE u.id IN (${userIds.map(() => '?').join(',')})`
            : ''}
        ORDER BY u.username ASC
        `,
        userIds.length > 0 ? userIds.map((u) => Number(u)) : []
    );

    // Profiles per user id
    const profilesByUser = new Map();
    for (const u of userRows) {
        const profileIds = getAll(
            `SELECT profile_id FROM user_profile_assignments WHERE user_id = ?`,
            [u.id]
        ).map((r) => r.profile_id);
        profilesByUser.set(u.id, profileIds);
    }

    const users = [];

    for (const u of userRows) {
        const profileIds = profilesByUser.get(u.id) || [];
        if (profileIds.length === 0) continue;

        const placeholders = profileIds.map(() => '?').join(',');

        // Status counts across ALL TIME for this user's profiles
        const statusRows = getAll(
            `
            SELECT status, COUNT(*) as count
            FROM job_applications a
            WHERE a.profile_id IN (${placeholders})
            ${profileFilter ? '' : ''}
            GROUP BY status
            `,
            profileIds
        );

        const statusCounts = {
            pending: 0,
            applied: 0,
            interview: 0,
            rejected: 0,
            total: 0
        };
        for (const row of statusRows) {
            if (row.status in statusCounts) statusCounts[row.status] = row.count;
            statusCounts.total += row.count;
        }

        // ---- Per-profile status counts (lifetime) ----
        const profileStatusRows = getAll(
            `
            SELECT a.profile_id,
                   a.status,
                   COUNT(*) as count
            FROM job_applications a
            WHERE a.profile_id IN (${placeholders})
            GROUP BY a.profile_id, a.status
            `,
            profileIds
        );
        const profileStats = {};
        for (const ps of profileStatusRows) {
            if (!profileStats[ps.profile_id]) {
                profileStats[ps.profile_id] = {
                    pending: 0, applied: 0, interview: 0, rejected: 0, total: 0
                };
            }
            if (ps.status in profileStats[ps.profile_id]) {
                profileStats[ps.profile_id][ps.status] += ps.count;
            }
            profileStats[ps.profile_id].total += ps.count;
        }

        // ---- Per-link rows so the dashboard can see exactly how each
        // user connects to each profile (id + since timestamp). ----
        const profileLinks = getAll(
            `
            SELECT upa.id as link_id,
                   upa.user_id,
                   upa.profile_id,
                   upa.assigned_at as linked_since
            FROM user_profile_assignments upa
            WHERE upa.user_id = ?
            ORDER BY upa.profile_id ASC
            `,
            [u.id]
        );

        // Per-period counts
        const periodBreakdown = {};
        for (const period of periods) {
            const { appliedCount, scheduledCount, repliedCount, total, successRate } = countUserForPeriod(
                profileIds,
                placeholders,
                period.start,
                period.end
            );
            periodBreakdown[period.key] = {
                appliedCount,
                scheduledCount,
                repliedCount,
                successRate,
                total
            };
        }

        // Optional: per-user activity in the admin's chosen active period
        let activePeriodData = null;
        if (activePeriod) {
            const { appliedCount, scheduledCount, repliedCount, total, successRate } = countUserForPeriod(
                profileIds,
                placeholders,
                activePeriod.start,
                activePeriod.end
            );
            activePeriodData = {
                appliedCount,
                scheduledCount,
                repliedCount,
                successRate,
                total
            };
        }

        users.push({
            id: u.id,
            username: u.username,
            profileCount: profileIds.length,
            statuses: statusCounts,
            periods: periodBreakdown,
            activePeriod: activePeriodData,
            profileStats,
            profileLinks
        });
    }

        return users;
    } catch (err) { console.error("buildUserBreakdown error:", err.message); return []; }
}

/**
 * Count applied / scheduled / success-rate for one user's profile set
 * in a single time window. Returns plain numbers.
 */
function countUserForPeriod(profileIds, placeholders, startDate, endDate) {
    const startISO = toSqlDateTime(startDate);
    const endISO = toSqlDateTime(endDate);

    const appliedRow = getOne(
        `SELECT COUNT(*) as count FROM job_applications a
         WHERE a.profile_id IN (${placeholders})
           AND a.created_at >= ? AND a.created_at <= ?
           AND a.status = 'applied'`,
        [...profileIds, startISO, endISO]
    );
    const appliedCount = appliedRow?.count || 0;

    const scheduledRow = getOne(
        `SELECT COUNT(DISTINCT i.id) as count
         FROM interviews i
         JOIN job_applications a ON i.application_id = a.id
         WHERE a.profile_id IN (${placeholders})
           AND i.status = 'scheduled'
           AND i.created_at >= ? AND i.created_at <= ?`,
        [...profileIds, startISO, endISO]
    );
    const scheduledCount = scheduledRow?.count || 0;

    // "Replied" = the user captured a recruiter response for the application
    // (any non-terminal interview_requests row that already has a recruiter reply
    // recorded in the selected window). The window is measured on
    // interview_requests.recruiter_reply_at, NOT on the application's created_at,
    // so the dashboard reflects *when the recruiter got back*, not when the job
    // was applied to.
    const repliedRow = getOne(
        `SELECT COUNT(DISTINCT a.id) as count
         FROM job_applications a
         JOIN interview_requests ir ON ir.application_id = a.id
         WHERE a.profile_id IN (${placeholders})
           AND ir.recruiter_reply_at IS NOT NULL
           AND ir.recruiter_reply_at >= ? AND ir.recruiter_reply_at <= ?`,
        [...profileIds, startISO, endISO]
    );
    const repliedCount = repliedRow?.count || 0;

    const total = appliedCount + scheduledCount;
    const successRate = total > 0 ? Math.round((scheduledCount / total) * 100) : 0;

    return { appliedCount, scheduledCount, repliedCount, total, successRate };
}

/**
 * Format a Date as an EST-anchored "7am" / "12pm" / "11pm" style label.
 */
function formatESTHourLabel(date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hour12: true,
        timeZone: 'America/New_York'
    });
    return formatter.format(date).toLowerCase().replace(/\s/g, '');
}

/**
 * Build the per-period payload for one period (week / month / workday).
 */
function buildPeriodPayload({ period, ownerWhere, ownerParams }) {
    const startISO = toSqlDateTime(period.start);
    const endISO = toSqlDateTime(period.end);

    const baseWhere = `${ownerWhere} AND a.created_at >= ? AND a.created_at <= ?`;
    const baseParams = [...ownerParams, startISO, endISO];

    const appliedRow = getOne(
        `SELECT COUNT(*) as count FROM job_applications a WHERE ${baseWhere} AND a.status = 'applied'`,
        baseParams
    );
    const appliedCount = appliedRow?.count || 0;

    const scheduledRow = getOne(
        `SELECT COUNT(DISTINCT i.id) as count
         FROM interviews i
         JOIN job_applications a ON i.application_id = a.id
         WHERE ${ownerWhere}
           AND i.status = 'scheduled'
           AND i.created_at >= ? AND i.created_at <= ?`,
        [...ownerParams, startISO, endISO]
    );
    const scheduledCount = scheduledRow?.count || 0;

    // "Replied" counts applications with a recruiter reply timestamped
    // within the selected window (not when the application was created).
    const repliedRow = getOne(
        `SELECT COUNT(DISTINCT a.id) as count
         FROM job_applications a
         JOIN interview_requests ir ON ir.application_id = a.id
         WHERE ${ownerWhere}
           AND ir.recruiter_reply_at IS NOT NULL
           AND ir.recruiter_reply_at >= ? AND ir.recruiter_reply_at <= ?`,
        [...ownerParams, startISO, endISO]
    );
    const repliedCount = repliedRow?.count || 0;

    const totalProcessed = appliedCount + scheduledCount;
    const successRate = totalProcessed > 0
        ? Math.round((scheduledCount / totalProcessed) * 100)
        : 0;

    const scheduledApps = getAll(
        `SELECT a.core_skills
         FROM job_applications a
         JOIN interviews i ON a.id = i.application_id
         WHERE ${ownerWhere}
           AND i.status = 'scheduled'
           AND i.created_at >= ? AND i.created_at <= ?`,
        [...ownerParams, startISO, endISO]
    );

    const tech = computeTopTechStacks(scheduledApps);

    // Scheduled interview details for the period modal
    const scheduledDetails = getAll(
        `
        SELECT
            a.id as application_id,
            a.company_name,
            a.job_role,
            a.core_skills,
            a.status as application_status,
            a.created_at as applied_at,
            i.id as interview_id,
            i.scheduled_date,
            i.scheduled_time,
            i.timezone,
            i.interview_type,
            i.interviewer_name,
            i.location,
            i.meeting_link,
            i.notes,
            i.status as interview_status
        FROM job_applications a
        JOIN interviews i ON a.id = i.application_id
        WHERE ${ownerWhere}
          AND i.status = 'scheduled'
          AND i.created_at >= ? AND i.created_at <= ?
        ORDER BY
            CASE WHEN i.scheduled_date IS NULL OR i.scheduled_date = '' THEN 1 ELSE 0 END,
            i.scheduled_date ASC,
            i.scheduled_time ASC,
            a.created_at DESC
        `,
        [...ownerParams, startISO, endISO]
    );

    // Hourly buckets for workday-length windows
    let hourlyWorkday = null;
    const spanHours = (period.end.getTime() - period.start.getTime()) / (60 * 60 * 1000);
    if (period.key === 'workday' || period.key === '24h' || spanHours <= 25) {
        hourlyWorkday = buildHourlyWorkdayBuckets({
            start: period.start,
            end: period.end,
            whereClause: ownerWhere,
            whereParams: ownerParams
        });
    }

    const dailyBuckets = buildDailyBuckets({
        start: period.start,
        end: period.end,
        whereClause: ownerWhere,
        whereParams: ownerParams
    });

    return {
        label: period.label,
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        appliedCount,
        scheduledCount,
        repliedCount,
        successRate,
        topTechStack: tech.topTechStack,
        topTechStackCount: tech.topTechStackCount,
        techStacks: tech.techStacks,
        scheduledDetails,
        hourlyWorkday,
        dailyBuckets
    };
}

/**
 * Resolve the currently selected period based on `opts.periodKey` and
 * optional custom range. Returns a `periodDescriptor` of the same
 * shape as the entries in `getStandardPeriods()`:
 *   { key, label, start: Date, end: Date }
 *
 * Period keys:
 *   - 'workday'  → current 7am-EST workday window
 *   - '24h'      → sliding 24-hour window from now (default)
 *   - '7d'       → last 7 days
 *   - '30d'      → last 30 days
 *   - 'custom'   → requires opts.from and opts.to
 *
 * Unknown / empty keys fall back to '24h' so the dashboard is never
 * blank.
 */
function resolveActivePeriod(now, periodKey, fromIso, toIso) {
    // Both 'workday' and '24h' resolve to the same 24-hour window
    // anchored at the most recent 7am GMT-4. This way the rolling
    // dashboard never disagrees with the workday view by a few hours;
    // both cover an identical UTC range.
    if (periodKey === 'workday' || periodKey === '24h' || !periodKey) {
        const w = getCurrentWorkdayEST(now);
        return {
            key: periodKey || '24h',
            label: 'Last 24 hours · anchored 7am GMT-4',
            start: w.start,
            end: w.end
        };
    }
    if (periodKey === '7d') {
        // Rolling 7-day window ending at `now`. Same semantics as the
        // standard 'week' period in `getStandardPeriods()` so the two
        // stay numerically consistent when the admin switches focus.
        return {
            key: '7d',
            label: 'Last 7 days',
            start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
            end: now
        };
    }
    if (periodKey === '30d') {
        return {
            key: '30d',
            label: 'Last 30 days',
            start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
            end: now
        };
    }
    if (periodKey === 'custom' && fromIso && toIso) {
        const start = new Date(fromIso);
        const end = new Date(toIso);
        if (!isNaN(start) && !isNaN(end) && end >= start) {
            const fmt = (d) =>
                d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            return {
                key: 'custom',
                label: `${fmt(start)} → ${fmt(end)}`,
                start,
                end
            };
        }
    }
    // Unknown key: fall back to the same 7am GMT-4 anchored window so
    // the default matches the admin dashboard's landing state.
    const w = getCurrentWorkdayEST(now);
    return {
        key: '24h',
        label: 'Last 24 hours · anchored 7am GMT-4',
        start: w.start,
        end: w.end
    };
}

/**
 * Build the standard stats payload used by both /api/user/stats and
 * /api/admin/stats.
 *
 * @param {Object} req - the express request (uses req.user.id)
 * @param {'user'|'admin'} scope
 * @param {Object} [opts]
 * @param {number[]} [opts.userIds] - admin scope filter; only profiles
 *   assigned to these user ids are counted.
 * @param {'workday'|'24h'|'7d'|'30d'|'custom'} [opts.periodKey] - which period
 *   should be returned as the "active period" in the response. When
 *   omitted, defaults to '24h'.
 * @param {string} [opts.from] - ISO string, used when periodKey='custom'
 * @param {string} [opts.to]   - ISO string, used when periodKey='custom'
 * @returns {{
 *   generatedAt, generatedAtEST, scope, userIds,
 *   periodKey, activePeriod,
 *   periods: { workday, week, month },
 *   users: Array<{id,username,profileCount,statuses,periods}>
 * }}
 *
 * The `periods` block is the org-wide (or filtered) view across the three
 * standard periods (workday / week / month) — kept for backward
 * compatibility with the user dashboard. The `activePeriod` block is the
 * single period the admin is currently focused on, with the same payload
 * shape.
 */
function buildStatsResponse(req, scope, opts = {}) {
    const { now, periods } = getStandardPeriods();
    const userIds = Array.isArray(opts.userIds) ? opts.userIds : [];
    const periodKey = opts.periodKey || '24h';

    const { clause: ownerWhere, params: ownerParams } = buildOwnershipFilterClause(
        scope,
        req.user.id,
        userIds
    );

    const result = {};
    for (const period of periods) {
        result[period.key] = buildPeriodPayload({
            period,
            ownerWhere,
            ownerParams
        });
    }

    // Compute the active period (admin-driven) and build its payload
    const activePeriodDescriptor = resolveActivePeriod(
        now,
        periodKey,
        opts.from,
        opts.to
    );
    const activePeriod = buildPeriodPayload({
        period: activePeriodDescriptor,
        ownerWhere,
        ownerParams
    });

    // Per-user breakdown (admin only — user scope's "users" is just them).
    // For the user side, also include a snapshot of the active period's
    // totals so the dashboard can show "your activity this period".
    const users = scope === 'admin'
        ? buildUserBreakdown({
              periods,
              userIds,
              activePeriod: activePeriodDescriptor
          })
        : [
              {
                  id: req.user.id,
                  username: req.user.username,
                  profileCount: null,
                  statuses: aggregateStatusForCurrentUser(req.user.id),
                  periods: {
                      workday: result.workday,
                      week: result.week,
                      month: result.month
                  },
                  activePeriod: {
                      appliedCount: activePeriod.appliedCount,
                      scheduledCount: activePeriod.scheduledCount,
                      repliedCount: activePeriod.repliedCount,
                      successRate: activePeriod.successRate,
                      topTechStack: activePeriod.topTechStack
                  },
                  // Per-profile / per-link breakdowns are only meaningful
                  // for admin scope. Provide empty stubs so the response
                  // shape stays consistent.
                  profileStats: {},
                  profileLinks: []
              }
          ];

    // Top-level per-link + per-application breakdowns (admin scope).
    // Lets the dashboard render "every user × every profile × every
    // application" without having to walk the nested `users[]` array.
    let linkBreakdown = null;
    if (scope === 'admin') {
        linkBreakdown = buildLinkBreakdown({
            userIds,
            activePeriod: activePeriodDescriptor
        });
    }

    return {
        generatedAt: now.toISOString(),
        generatedAtEST: nowAsESTISOString(now),
        scope,
        userIds,
        periodKey: activePeriodDescriptor.key,
        activePeriod,
        periods: result,
        users,
        // New: rolled-up per-application counts per (userId, profileId) link.
        // Shape:
        //   {
        //     totalLinks: <int>,
        //     totalApplications: <int>,
        //     byUser: [{ userId, username, linkCount, profileCount, applicationCount }],
        //     byProfile: [{ profileId, profileName, linkCount, applicationCount }],
        //     rows: [
        //       { linkId, userId, username, profileId, profileName, applicationCount,
        //         applications: [{ id, company_name, job_role, status, appliedCount, scheduledCount, repliedCount }] }
        //     ]
        //   }
        linkBreakdown
    };
}

/**
 * Build the cross-link breakdown: every row in user_profile_assignments,
 * how many applications each link has, and per-application counts in
 * the admin's currently-focused active period. Honoured by the same
 * userIds filter as the rest of the admin payload.
 */
function buildLinkBreakdown({ userIds = [], activePeriod = null }) {
    try {
    const userFilter = userIds.length > 0
        ? `AND u.id IN (${userIds.map(() => '?').join(',')})`
        : '';
    const userFilterParams = userIds.length > 0 ? userIds.map(Number) : [];

    // 1. Every user_profile_assignments row, enriched with names
    const links = getAll(
        `
        SELECT upa.id           AS link_id,
               upa.user_id,
               u.username,
               upa.profile_id,
               p.first_name,
               p.last_name,
               upa.assigned_at  AS linked_since
        FROM user_profile_assignments upa
        JOIN users u               ON u.id   = upa.user_id
        JOIN candidate_profiles p  ON p.id   = upa.profile_id
        WHERE 1=1 ${userFilter}
        ORDER BY u.username ASC, p.first_name ASC, p.last_name ASC
        `,
        userFilterParams
    );

    // 2. Application counts per link (lifetime). The userFilter
    // references u.id, so we MUST join users u — otherwise sql.js
    // raises "no such column: u.id" whenever a non-empty userIds
    // filter is supplied.
    const linkAppCounts = getAll(
        `
        SELECT upa.id           AS link_id,
               COUNT(a.id)      AS application_count
        FROM user_profile_assignments upa
        JOIN users u               ON u.id = upa.user_id
        LEFT JOIN job_applications a ON a.profile_id = upa.profile_id
        WHERE 1=1 ${userFilter}
        GROUP BY upa.id
        `,
        userFilterParams
    );
    const appCountByLink = new Map();
    for (const row of linkAppCounts) {
        appCountByLink.set(row.link_id, row.application_count || 0);
    }

    // 3. Per-period (active period) per-application counts per link.
    // We do this per-link so a 200-link org doesn't generate a 200K-row
    // result, but the dashboard can still drill when needed.
    const startISO = activePeriod ? toSqlDateTime(activePeriod.start) : null;
    const endISO   = activePeriod ? toSqlDateTime(activePeriod.end)   : null;

    // 4. Per-application (filtered to this admin's active period) so the
    // dashboard can show exactly which applications contribute.
    const periodAppRows = (startISO && endISO)
        ? getAll(
            `
            SELECT a.id,
                   a.profile_id,
                   upa.id           AS link_id,
                   upa.user_id,
                   u.username,
                   a.company_name,
                   a.job_role,
                   a.status,
                   a.core_skills,
                   a.created_at,
                   a.updated_at,
                   (SELECT COUNT(*) FROM interviews i
                      WHERE i.application_id = a.id AND i.status = 'scheduled')
                       AS scheduled_count,
                   (SELECT COUNT(*) FROM interview_requests ir
                      WHERE ir.application_id = a.id AND ir.recruiter_reply_at IS NOT NULL)
                       AS replied_count,
                   (a.status = 'applied') AS is_applied
            FROM job_applications a
            JOIN user_profile_assignments upa ON upa.profile_id = a.profile_id
            JOIN users u                      ON u.id = upa.user_id
            WHERE 1=1 ${userFilter}
              AND a.created_at >= ? AND a.created_at <= ?
            ORDER BY a.created_at DESC
            `,
            [...userFilterParams, startISO, endISO]
        )
        : [];

    // 5. Stitch the per-period application rows back onto the link
    // entries so the dashboard can render "<user> owns <profile> with N
    // applications in the active period".
    const appsByLink = new Map();
    for (const r of periodAppRows) {
        const key = r.link_id;
        if (!appsByLink.has(key)) appsByLink.set(key, []);
        appsByLink.get(key).push({
            id: r.id,
            profileId: r.profile_id,
            linkId: r.link_id,
            userId: r.user_id,
            username: r.username,
            company_name: r.company_name,
            job_role: r.job_role,
            status: r.status,
            core_skills: r.core_skills,
            created_at: r.created_at,
            updated_at: r.updated_at,
            is_applied: !!r.is_applied,
            appliedCount: r.is_applied ? 1 : 0,
            scheduledCount: r.scheduled_count || 0,
            repliedCount: r.replied_count || 0
        });
    }

    // Build per-link rows.
    // applicationCount here = LIFETIME per-link count (a single
    // application shared by two users counts once per link row, by
    // design — that's the explicit link-level view).
    const rows = links.map((l) => {
        const linkApps = appsByLink.get(l.link_id) || [];
        return {
            linkId: l.link_id,
            userId: l.user_id,
            username: l.username,
            profileId: l.profile_id,
            profileName: ((l.first_name || '') + ' ' + (l.last_name || '')).trim(),
            linkedSince: l.linked_since,
            applicationCount: appCountByLink.get(l.link_id) || 0,
            applications: linkApps
        };
    });

    // Roll-up by USER with DISTINCT application_count:
    //   - An application linked to multiple profiles owned by the same
    //     user is counted ONCE per user (not once per profile).
    //   - An application linked to multiple USERS would still appear
    //     under each of those users (that's intended — admins want to
    //     see every user who owns the application).
    // We dedupe within a user via a Set<applicationId> built across
    // all of their apps in the active period.
    const byUserMap = new Map();
    for (const r of rows) {
        if (!byUserMap.has(r.userId)) {
            byUserMap.set(r.userId, {
                userId: r.userId,
                username: r.username,
                linkCount: 0,
                profileIds: new Set(),
                applicationIdSet: new Set(),  // distinct apps in active period
                applicationCount: 0           // lifetime (link-level summed)
            });
        }
        const u = byUserMap.get(r.userId);
        u.linkCount += 1;
        u.profileIds.add(r.profileId);
        u.applicationCount += r.applicationCount;  // lifetime (per-link)
        for (const app of r.applications) {
            u.applicationIdSet.add(app.id);
        }
    }
    const byUser = Array.from(byUserMap.values())
        .map((u) => ({
            userId: u.userId,
            username: u.username,
            linkCount: u.linkCount,
            profileCount: u.profileIds.size,
            applicationCount: u.applicationCount,            // lifetime
            distinctApplicationsInPeriod: u.applicationIdSet.size   // last 24h
        }))
        .sort((a, b) => a.username.localeCompare(b.username));

    // Roll-up by PROFILE with DISTINCT application_count (same rule
    // applied to profileId).
    const byProfileMap = new Map();
    for (const r of rows) {
        if (!byProfileMap.has(r.profileId)) {
            byProfileMap.set(r.profileId, {
                profileId: r.profileId,
                profileName: r.profileName,
                linkCount: 0,
                applicationIdSet: new Set(),
                applicationCount: 0
            });
        }
        const p = byProfileMap.get(r.profileId);
        p.linkCount += 1;
        p.applicationCount += r.applicationCount;
        for (const app of r.applications) {
            p.applicationIdSet.add(app.id);
        }
    }
    const byProfile = Array.from(byProfileMap.values())
        .map((p) => ({
            profileId: p.profileId,
            profileName: p.profileName,
            linkCount: p.linkCount,
            applicationCount: p.applicationCount,           // lifetime
            distinctApplicationsInPeriod: p.applicationIdSet.size
        }))
        .sort((a, b) => a.profileName.localeCompare(b.profileName));

    // totalApplications stays as the SUM of (link-level) lifetime
    // counts so it matches the per-link rows. We also expose
    // totalApplicationsDistinct as the UNION of distinct app ids across
    // every link (which equals the lifetime count of applications in
    // the org that have at least one profile assignment).
    const totalLifetimeSet = new Set();
    for (const r of rows) {
        for (const app of r.applications) totalLifetimeSet.add(app.id);
    }
    // Lifetime total across the org (one per application, regardless of
    // how many links it has). Computed directly from job_applications.
    const totalApplications = appCountByLink.size > 0
        ? (() => {
            // Sum the lifetime per-link counts and then drop the dup
            // factor: each app counts once per distinct link it shows
            // up in. But the cleaner sanity is to also export the raw
            // "distinct apps in the org" derived from the active-period
            // results we already have.
            return rows.reduce((acc, r) => acc + r.applicationCount, 0);
          })()
        : 0;

    return {
        totalLinks: rows.length,
        totalApplications,                              // sum of per-link lifetime
        totalApplicationsDistinct: totalLifetimeSet.size, // distinct apps seen in period
        byUser,
        byProfile,
        rows
    };

    } catch (err) { console.error("buildLinkBreakdown error:", err.message); return null; }
}

/**
 * For user-scoped responses, compute lifetime status counts over all
 * profiles this user owns.
 */
function aggregateStatusForCurrentUser(userId) {
    try {
        const rows = getAll(
            `
            SELECT a.status, COUNT(*) as count
            FROM job_applications a
            JOIN user_profile_assignments upa ON upa.profile_id = a.profile_id
            WHERE upa.user_id = ?
            GROUP BY a.status
            `,
            [userId]
        );
        const out = { pending: 0, applied: 0, interview: 0, rejected: 0, total: 0 };
        for (const row of rows) {
            if (row.status in out) out[row.status] = row.count;
            out.total += row.count;
        }
        return out;
    } catch (err) {
        console.error('aggregateStatusForCurrentUser error:', err.message);
        return { pending: 0, applied: 0, interview: 0, rejected: 0, total: 0 };
    }
}

module.exports = {
    getStandardPeriods,
    computeTopTechStacks,
    buildHourlyWorkdayBuckets,
    buildDailyBuckets,
    buildPeriodPayload,
    buildStatsResponse,
    resolveActivePeriod,
    buildOwnershipFilterClause,
    buildUserBreakdown,
    aggregateStatusForCurrentUser,
    formatESTHourLabel
};
