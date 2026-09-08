const { initDatabase, getAll, getOne, runQuery } = require('../../server/config/database');
const svc = require('../../server/services/bidCourseService');

function isCaptchaAttention(eventType, meta) {
    const t = String(eventType || '');
    if (/needs_captcha|captcha_abandoned|login_wall/i.test(t)) return true;
    const m = meta && typeof meta === 'object' ? meta : {};
    const err = String(m.error || m.reason || '');
    return /captcha_needs_manual|captcha/i.test(err) && /fill_failed|needs_manual/i.test(t);
}

function classify(c) {
    const status = svc.listEvents(c.id).reverse().find((e) =>
        !/^(screenshot|screenshot_failed|live|queue_enqueued|qa_admin_access_check)$/i.test(e.event_type || '')
    );
    const t = String(status?.event_type || c.last_event_type || '');
    const meta = status?.meta || null;
    const outcome = String(c.outcome || '').toLowerCase();
    if (outcome === 'applied' || /marked_applied|submitted_ok/i.test(t)) return 'applied';
    if (/awaiting_manual_submit|fill_done|after_fill_done/i.test(t) || (c.filled_at && !/fail|captcha|blocked|no_form/i.test(t))) {
        if (/awaiting_manual|fill_done|after_fill|package_saved/i.test(t) || c.filled_at) {
            if (/fail|blocked|no_form|open_failed/i.test(t) && !isCaptchaAttention(t, meta)) return 'failed';
            if (/captcha_abandoned|needs_captcha|login_wall/i.test(t) || isCaptchaAttention(t, meta)) return 'captcha';
            if (/package_saved/i.test(t) && !c.filled_at) return 'package';
            return 'filled';
        }
    }
    if (/needs_captcha|captcha_abandoned|login_wall/i.test(t) || isCaptchaAttention(t, meta)) return 'captcha';
    if (/fill_failed|open_failed|blocked_ats|ai_failed|no_form|cv_regenerate_failed/i.test(t)) return 'failed';
    if (/generate_done|package_saved|cv_regenerat|bidder_answers_ready/i.test(t)) return 'ready';
    if (/^stale_run$/i.test(t)) return 'stale';
    const ageMs = c.updated_at ? Date.now() - new Date(c.updated_at).getTime() : Infinity;
    if (/^autofill_engine$/i.test(t)) return ageMs > 10 * 60 * 1000 ? 'stale' : 'running';
    if (/queue_|opened|form_|answers_generating|mid_fill|fill_retry|dial_/i.test(t)) {
        return ageMs > 45 * 60 * 1000 ? 'stale' : 'running';
    }
    return 'unknown';
}

(async () => {
    await initDatabase();
    const courses = svc.listCoursesAll({ limit: 200 });
    const report = [];
    const issues = [];

    for (const c of courses) {
        const kind = classify(c);
        const events = svc.listEvents(c.id);
        const lastReal = [...events].reverse().find((e) =>
            !/^(screenshot|screenshot_failed|live|queue_enqueued|qa_admin_access_check)$/i.test(e.event_type || '')
        );
        const failEv = [...events].reverse().find((e) =>
            /fill_failed|open_failed|blocked_ats|ai_failed|no_form|needs_captcha|captcha_abandoned/i.test(e.event_type || '')
        );
        const row = {
            id: c.id,
            app: c.application_id,
            company: c.company_name,
            role: (c.job_role || '').slice(0, 40),
            kind,
            last: c.last_event_type,
            lastReal: lastReal?.event_type,
            outcome: c.outcome,
            filled: !!c.filled_at,
            url: (c.job_url || '').slice(0, 60),
            failMeta: failEv?.meta || null,
            eventCount: events.length
        };
        report.push(row);

        if (/^(unknown|engineering|company|job)$/i.test(String(c.company_name || '')) || !c.company_name) {
            issues.push({ id: c.id, type: 'bad_company', company: c.company_name, url: c.job_url });
        }
        if (kind === 'failed' && failEv?.meta?.error) {
            issues.push({ id: c.id, type: 'fail', event: failEv.event_type, error: failEv.meta.error });
        }
        if (c.filled_at && /fill_failed|needs_captcha|captcha_abandoned/i.test(c.last_event_type || '')) {
            issues.push({ id: c.id, type: 'filled_but_fail_status', last: c.last_event_type });
        }
        if (c.last_event_type !== lastReal?.event_type && lastReal) {
            issues.push({
                id: c.id,
                type: 'status_mismatch',
                sqlLast: c.last_event_type,
                realLast: lastReal.event_type
            });
        }
        // Dup shots
        const dups = getAll(
            `SELECT stage, COUNT(1) n FROM bid_course_screenshots WHERE course_id = ? GROUP BY stage HAVING n > 1`,
            [c.id]
        );
        if (dups.length) {
            issues.push({ id: c.id, type: 'dup_shots', dups });
        }
    }

    const byKind = {};
    for (const r of report) byKind[r.kind] = (byKind[r.kind] || 0) + 1;

    console.log(JSON.stringify({ total: report.length, byKind, issues, report }, null, 2));
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
