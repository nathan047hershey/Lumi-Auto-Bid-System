/** Human-readable Auto Bidder / bid-course failure helpers (shared UI). */

const ATS_LABELS = {
    greenhouse: 'Greenhouse',
    workday: 'Workday',
    lever: 'Lever',
    ashby: 'Ashby',
    linkedin: 'LinkedIn',
    oracle: 'Oracle Cloud HCM',
    icims: 'iCIMS',
    smartrecruiters: 'SmartRecruiters',
    bamboohr: 'BambooHR',
    generic: 'Generic / custom ATS',
    other: 'Unknown ATS'
};

/** ATS types Auto Bidder will attempt (LinkedIn Easy Apply is excluded). */
const SUPPORTED_ATS = new Set([
    'greenhouse',
    'workday',
    'lever',
    'ashby',
    'oracle',
    'icims',
    'smartrecruiters',
    'bamboohr',
    'generic',
    'other'
]);

export function atsLabel(id) {
    const key = String(id || '').toLowerCase();
    return ATS_LABELS[key] || (key ? key : 'Unknown ATS');
}

export function hostFromUrl(url) {
    try {
        return new URL(String(url || '')).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

export function detectAtsFromUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return { id: 'generic', label: ATS_LABELS.generic, supported: true };
    if (/greenhouse\.io/i.test(u)) {
        return { id: 'greenhouse', label: ATS_LABELS.greenhouse, supported: true };
    }
    if (/oraclecloud\.com|\.oracle\.com\/hcm|fa\.[a-z0-9]+\.oraclecloud/i.test(u)) {
        return { id: 'oracle', label: ATS_LABELS.oracle, supported: true };
    }
    if (/myworkdayjobs\.com|workday/i.test(u)) {
        return { id: 'workday', label: ATS_LABELS.workday, supported: true };
    }
    if (/lever\.co/i.test(u)) {
        return { id: 'lever', label: ATS_LABELS.lever, supported: true };
    }
    if (/ashbyhq\.com/i.test(u)) {
        return { id: 'ashby', label: ATS_LABELS.ashby, supported: true };
    }
    if (/linkedin\.com/i.test(u)) {
        return { id: 'linkedin', label: ATS_LABELS.linkedin, supported: false };
    }
    if (/icims\.com/i.test(u)) {
        return { id: 'icims', label: ATS_LABELS.icims, supported: true };
    }
    if (/smartrecruiters\.com/i.test(u)) {
        return { id: 'smartrecruiters', label: ATS_LABELS.smartrecruiters, supported: true };
    }
    if (/bamboohr\.com/i.test(u)) {
        return { id: 'bamboohr', label: ATS_LABELS.bamboohr, supported: true };
    }
    return { id: 'generic', label: ATS_LABELS.generic, supported: true };
}

/** Ashby Overview / JD URL (not already /application). */
export function isAshbyJobDescriptionUrl(url) {
    const u = String(url || '');
    if (!/ashbyhq\.com/i.test(u)) return false;
    if (/\/application\/?($|\?|#)/i.test(u)) return false;
    return /ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{8,}/i.test(u);
}

/** Ashby Overview → Application form URL (.../uuid/application). */
export function ashbyApplicationUrl(url) {
    try {
        const u = new URL(url);
        if (/\/application\/?$/i.test(u.pathname)) return u.toString();
        u.pathname = `${u.pathname.replace(/\/$/, '')}/application`;
        return u.toString();
    } catch {
        return `${String(url || '').replace(/\/?([?#].*)?$/, '')}/application`;
    }
}

/** Prefer Ashby /application when given Overview JD URL. */
export function resolveApplyOpenUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return raw;
    if (isAshbyJobDescriptionUrl(raw)) return ashbyApplicationUrl(raw);
    return raw;
}

/** Greenhouse board landing / closed-job error pages — not a usable apply URL. */
export function isBrokenApplyLandingUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return true;
    try {
        const u = new URL(raw);
        const path = u.pathname || '';
        const err = u.searchParams.get('error');
        if (/\/embed\/job_board\/?$/i.test(path) || /\/job_board\/?$/i.test(path)) return true;
        if (err === 'true' || err === '1') return true;
        if (/\/jobs\/?$/i.test(path) && /greenhouse\.io/i.test(u.hostname) && !u.searchParams.get('token')) {
            return true;
        }
    } catch {
        return /error=true|\/job_board/i.test(raw);
    }
    return false;
}

/** Pick the first usable apply URL from candidates (skips empty / board-error pages). */
export function pickApplyOpenUrl(...candidates) {
    for (const c of candidates) {
        const resolved = resolveApplyOpenUrl(c);
        if (resolved && !isBrokenApplyLandingUrl(resolved)) return resolved;
    }
    for (const c of candidates) {
        const resolved = resolveApplyOpenUrl(c);
        if (resolved) return resolved;
    }
    return '';
}

export function isAtsSupported(atsId) {
    const key = String(atsId || '').toLowerCase();
    if (key === 'linkedin') return false;
    return SUPPORTED_ATS.has(key) || key === 'generic' || key === 'other';
}

export function isCaptchaAttention(eventType, meta) {
    const t = String(eventType || '');
    if (/needs_captcha|captcha_abandoned|login_wall/i.test(t)) return true;
    const m = meta && typeof meta === 'object' ? meta : {};
    const err = String(m.error || m.reason || '');
    return /captcha_needs_manual|captcha/i.test(err) && /fill_failed|needs_manual/i.test(t);
}

/** Meta/error text that means the bid hit the wall-clock budget. */
export function isBudgetExceededMeta(meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const err = String(m.error || m.reason || '');
    return /bid_time_budget|bid_budget|time_budget_exceeded|budget_exceeded/i.test(err);
}

/** Apply tab gone mid-bid (user close / unattended skip) — recoverable via Open tab. */
export function isTabClosedEvent(eventType, meta) {
    const t = String(eventType || '');
    if (/^tab_closed$/i.test(t)) return true;
    const m = meta && typeof meta === 'object' ? meta : {};
    const err = String(m.error || m.reason || '');
    return /item_aborted/i.test(t) && /Tab closed/i.test(err);
}

/** Hard stop: bid wall-clock budget used up. */
export function isBudgetExceededEvent(eventType, meta) {
    const t = String(eventType || '');
    if (/bid_budget_exceeded/i.test(t)) return true;
    if (/fill_failed|item_aborted/i.test(t) && isBudgetExceededMeta(meta)) return true;
    return false;
}

export function isFailureEvent(eventType, meta) {
    const t = String(eventType || '');
    // Do not treat captcha_cleared / assist as failures (old regex matched bare "captcha").
    if (/captcha_cleared|captcha_assist/i.test(t)) return false;
    if (isCaptchaAttention(t, meta)) return false;
    // Recoverable skips — shown as ATTENTION, not hard FAILED.
    if (isTabClosedEvent(t, meta)) return false;
    if (/^item_aborted$/i.test(t) && !isBudgetExceededMeta(meta)) return false;
    if (isBudgetExceededEvent(t, meta)) return true;
    if (/reautofill_failed/i.test(t)) return true;
    return /blocked_ats|open_failed|fill_failed|ai_failed|needs_captcha|captcha_abandoned|needs_manual|login_wall|no_form|cv_regenerate_failed/i.test(
        t
    );
}

export function isSuccessEvent(eventType) {
    const t = String(eventType || '');
    if (/success_revoked|false_success_cleared/i.test(t)) return false;
    return /marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(t);
}

export function isFilledEvent(eventType) {
    return /awaiting_manual_submit|fill_done|after_fill_done|ready_to_submit|reautofill_done/i.test(
        String(eventType || '')
    );
}

/** Incomplete required fields — not FILLED and not hard FAILED. */
export function isIncompleteFillEvent(eventType, meta) {
    const t = String(eventType || '');
    if (/fill_incomplete|submit_blocked_incomplete/i.test(t)) return true;
    const m = meta && typeof meta === 'object' ? meta : {};
    if (m.incomplete === true) return true;
    const rt = Number(m.requiredTotal);
    const ro = Number(m.requiredOk);
    if (rt > 0 && Number.isFinite(ro) && ro < rt && /submit_blocked|fill_done|package_saved|mid_fill/i.test(t)) {
        return true;
    }
    return false;
}

/** Stages that prove bidding outcome (prefer these when reviewing a course). */
export function isProofScreenshotStage(stage) {
    return /^(after_submit|success|submitted|thank_you)$/i.test(String(stage || ''));
}

/**
 * Order screenshot frames for the Live monitor:
 * early pipeline first → live mid → fill done → site success proof last
 * so “follow live” lands on the thank-you / success message by default.
 */
export function orderMonitorScreenshotFrames(shots) {
    const list = Array.isArray(shots) ? shots : [];
    if (!list.length) return [];
    const byStage = new Map();
    for (const s of list) {
        const st = String(s.stage || 'shot').toLowerCase() || 'shot';
        const prev = byStage.get(st);
        if (!prev || String(s.created_at || '') >= String(prev.created_at || '')) {
            byStage.set(st, s);
        }
    }
    const order = [
        'opened',
        'form_revealed',
        'form_detected',
        'mid_fill',
        'pre_submit',
        'after_fill',
        'captcha',
        'login_wall',
        'captcha_cleared',
        'after_fill_done',
        'reautofill_after',
        // Keep live near the end so "follow live" shows the updating apply-tab frame
        // instead of a frozen autofill_page_* / after_fill shot.
        'live',
        'after_submit',
        'success',
        'submitted',
        'thank_you',
        'done',
        'shot'
    ];
    const out = [];
    for (const st of order) {
        if (byStage.has(st)) {
            out.push(byStage.get(st));
            byStage.delete(st);
        }
    }
    const rest = [...byStage.values()].sort((a, b) =>
        String(a.created_at || '').localeCompare(String(b.created_at || ''))
    );
    return [...out, ...rest];
}

/** Index of the preferred review frame (success proof > fill done > last). */
export function preferredProofFrameIndex(frames) {
    const list = Array.isArray(frames) ? frames : [];
    if (!list.length) return 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        if (isProofScreenshotStage(list[i]?.stage)) return i;
    }
    for (let i = list.length - 1; i >= 0; i -= 1) {
        if (/after_fill_done|after_fill/i.test(String(list[i]?.stage || ''))) return i;
    }
    return list.length - 1;
}

/**
 * Sort shots for the Screenshots grid: success proof first, then fill, then rest.
 */
export function sortScreenshotsForReview(shots) {
    const list = Array.isArray(shots) ? [...shots] : [];
    const rank = (stage) => {
        const s = String(stage || '').toLowerCase();
        if (/^(after_submit|success|submitted|thank_you)$/.test(s)) return 0;
        if (/after_fill_done/.test(s)) return 1;
        if (/after_fill|pre_submit/.test(s)) return 2;
        if (/opened|form_/.test(s)) return 4;
        if (/^live$/.test(s)) return 5;
        return 3;
    };
    return list.sort((a, b) => {
        const d = rank(a.stage) - rank(b.stage);
        if (d !== 0) return d;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
}

/** Human label for screenshot stages in Live monitor / Bid courses. */
export function screenshotStageLabel(stage) {
    const s = String(stage || '').toLowerCase();
    if (/^(after_submit|success|submitted|thank_you)$/.test(s)) return 'Success / thank-you (proof)';
    if (s === 'after_fill_done') return 'Filled form (ready to submit)';
    if (s === 'after_fill') return 'After fill';
    if (s === 'pre_submit') return 'Pre-submit';
    if (s === 'opened') return 'Opened apply page';
    if (s === 'live') return 'Live';
    if (s === 'captcha' || s === 'login_wall') return 'CAPTCHA / login';
    if (s === 'captcha_cleared') return 'CAPTCHA cleared';
    if (/^autofill_page_/i.test(s)) return s.replace(/_/g, ' ');
    return stage || 'Screenshot';
}

/**
 * Short live-monitor status line so bidding state is readable even when the
 * screenshot frame is frozen.
 */
export function liveStatusComment({
    eventType = '',
    meta = null,
    queueStatus = '',
    captchaKind = ''
} = {}) {
    const qs = String(queueStatus || '');
    if (/awaiting_captcha/i.test(qs)) {
        if (captchaKind === 'login') {
            return 'Paused — login wall on apply tab. Open tab → sign in → Resume.';
        }
        return 'CAPTCHA wait — apply tab held for NopeCHA/CapSolver (or click Resume). Fill starts when the form is ready.';
    }
    const t = String(eventType || '').toLowerCase();
    const m = meta && typeof meta === 'object' ? meta : {};
    if (/bidder_answers_ready/i.test(t)) {
        const n = Number(m.count ?? m.questions ?? NaN);
        return Number.isFinite(n)
            ? `Answers ready (${n}) — filling form…`
            : 'Answers ready — filling form…';
    }
    if (/profile_fill_started/i.test(t)) {
        const n = Number(m.questions ?? NaN);
        return Number.isFinite(n)
            ? `Filling profile & resume… (AI answering ${n} in parallel)`
            : 'Filling profile & resume… (AI answers in parallel)';
    }
    if (/answers_generating/i.test(t)) {
        const n = Number(m.count ?? m.questions ?? NaN);
        return Number.isFinite(n)
            ? `AI answering ${n} question(s)… (profile fill starts as soon as resume is ready)`
            : 'AI drafting answers… (profile fill starts as soon as resume is ready)';
    }
    if (/ai_skipped_budget/i.test(t)) {
        const n = Number(m.fresh ?? m.count ?? NaN);
        return Number.isFinite(n)
            ? `AI skipped for ${n} new question(s) (time budget) — filling with profile only`
            : 'AI answers skipped (time budget) — continuing profile fill';
    }
    if (isBudgetExceededEvent(t, m)) {
        const lim = Number(m.limitMs);
        const sec = Number.isFinite(lim) ? Math.round(lim / 1000) : 90;
        return `Time budget hit (~${sec}s) — stopped this bid, queue continues`;
    }
    if (isTabClosedEvent(t, m)) {
        return 'Apply tab closed — Open tab, then Re-autofill';
    }
    if (/item_aborted/i.test(t)) {
        const err = String(m.error || '').trim();
        if (/Tab closed|bid_time_budget|budget/i.test(err)) {
            return isBudgetExceededMeta(m)
                ? 'Stopped — bid time budget. Open tab or Process next.'
                : 'Apply tab closed — Open tab, then Re-autofill';
        }
        return err ? `Skipped — ${err}` : 'Bid skipped — see Bid course log';
    }
    if (/reautofill_failed/i.test(t)) {
        const err = String(m.error || '').trim();
        if (/Tab closed/i.test(err)) {
            return 'Re-autofill failed — apply tab missing. Open tab, then try again';
        }
        return err ? `Re-autofill failed — ${err}` : 'Re-autofill failed — Open tab and try again';
    }
    if (/fill_retry/i.test(t)) {
        const filled = m.filled != null ? ` · ${m.filled} filled` : '';
        if (m.willRetry === true) {
            return `Fill disconnected — retrying${filled}…`;
        }
        if (m.willRetry === false) {
            return `Fill retry stopped${filled} — check Open tab`;
        }
        if (/low_coverage/i.test(String(m.reason || ''))) {
            return `Low fill coverage — retrying page${filled}…`;
        }
        return `Fill retry${filled}…`;
    }
    if (/autofill_page|mid_fill/i.test(t)) {
        const filled = m.filled != null ? ` · ${m.filled} filled` : '';
        return `Filling apply form${filled}…`;
    }
    if (/fill_incomplete|submit_blocked_incomplete/i.test(t)) {
        const ro = m.requiredOk;
        const rt = m.requiredTotal;
        const missing = Array.isArray(m.missing) ? m.missing : (Array.isArray(m.missingRequired) ? m.missingRequired : []);
        const missHint = missing.filter(Boolean).slice(0, 3).join('; ');
        if (Number.isFinite(Number(ro)) && Number(rt) > 0) {
            return missHint
                ? `Fill incomplete — ${ro}/${rt} required. Missing: ${missHint}`
                : `Fill incomplete — ${ro}/${rt} required. Open tab to finish.`;
        }
        return missHint
            ? `Fill incomplete — Missing: ${missHint}`
            : 'Fill incomplete — many fields still empty. Open tab to review.';
    }
    if (/ready_to_submit|awaiting_manual_submit|after_fill|state_refreshed/i.test(t)) {
        return 'Form filled — waiting for submit / site thank-you.';
    }
    if (/marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(t)) {
        return 'SUCCESS — site thank-you confirmed.';
    }
    if (/submit_clicked/i.test(t)) {
        return 'Submitted — checking site confirmation…';
    }
    if (/submit_no_click|submit_blocked_incomplete/i.test(t)) {
        return 'Submit did not run — missing required fields or no Submit button. Use Control → Submit.';
    }
    if (/needs_captcha|captcha_abandoned|login_wall/i.test(t)) {
        return 'CAPTCHA / login blocked this job.';
    }
    if (/needs_manual/i.test(t)) {
        if (/apply_gate|apply_visible/i.test(String(m.reason || ''))) {
            return 'Apply gate — click Apply / create account on the tab, then Resume';
        }
        return 'Needs manual step on apply tab';
    }
    if (/queue_started|running/i.test(qs) || /queue_started/i.test(t)) {
        return 'Bidding in progress…';
    }
    if (t) return t.replace(/_/g, ' ');
    return '';
}

export function isNoiseEvent(eventType) {
    return /^(screenshot|screenshot_failed|live|queue_enqueued|qa_admin_access_check)$/i.test(
        String(eventType || '')
    );
}

/**
 * Timeline noise for *outcome* display — still logged, but should not hide
 * fill/submit results (e.g. package_saved after awaiting_manual_submit).
 */
export function isSecondaryStatusEvent(eventType) {
    return /^(package_saved|dial_country|cv_regenerate_needed|cv_regenerated|ai_skipped_budget)$/i.test(
        String(eventType || '')
    );
}

/** Prefer last non-screenshot event from a course or event list. */
export function lastStatusEvent(courseOrEvents) {
    if (Array.isArray(courseOrEvents)) {
        // From the end: an explicit SUCCESS revoke beats an older marked_applied.
        // Otherwise terminal SUCCESS still wins over later reautofill_done.
        let latestSuccess = null;
        let latestRevokeIdx = -1;
        for (let i = courseOrEvents.length - 1; i >= 0; i -= 1) {
            const e = courseOrEvents[i];
            const t = e?.event_type || e?.type || '';
            if (/success_revoked|false_success_cleared/i.test(t)) {
                if (latestRevokeIdx < 0) latestRevokeIdx = i;
                continue;
            }
            if (isSuccessEvent(t) && !latestSuccess) {
                latestSuccess = { event_type: t, meta: e.meta || e.last_event_meta || null, index: i };
            }
        }
        if (latestSuccess && latestSuccess.index > latestRevokeIdx) {
            return { event_type: latestSuccess.event_type, meta: latestSuccess.meta };
        }
        let fallback = { event_type: '', meta: null };
        let lastPrimary = null;
        for (let i = courseOrEvents.length - 1; i >= 0; i -= 1) {
            const e = courseOrEvents[i];
            const t = e?.event_type || e?.type || '';
            if (!t || isNoiseEvent(t)) continue;
            if (isSuccessEvent(t) && latestRevokeIdx >= 0 && i < latestRevokeIdx) continue;
            if (!fallback.event_type) {
                fallback = { event_type: t, meta: e.meta || e.last_event_meta || null };
            }
            if (isSecondaryStatusEvent(t)) continue;
            lastPrimary = { event_type: t, meta: e.meta || e.last_event_meta || null };
            break;
        }
        // False FAILED: incomplete fill → queue_retry Submit → needs_manual.
        // Prefer the incomplete signal so monitor shows INCOMPLETE.
        if (
            lastPrimary
            && /needs_manual/i.test(lastPrimary.event_type)
            && /submit_no_thanks/i.test(String(lastPrimary.meta?.reason || ''))
        ) {
            for (let i = courseOrEvents.length - 1; i >= 0; i -= 1) {
                const e = courseOrEvents[i];
                const t = e?.event_type || e?.type || '';
                if (/fill_incomplete|submit_blocked_incomplete/i.test(t)) {
                    return { event_type: t, meta: e.meta || null };
                }
                if (/mid_fill/i.test(t) && isIncompleteFillEvent(t, e.meta)) {
                    return {
                        event_type: 'fill_incomplete',
                        meta: { ...(e.meta || {}), reason: 'required_fields_incomplete' }
                    };
                }
            }
        }
        return lastPrimary || fallback;
    }
    const course = courseOrEvents || {};
    // Applied outcome / applied_at always beat a stale last_event (e.g. reautofill_done).
    if (
        String(course.outcome || '').toLowerCase() === 'applied'
        || course.applied_at
    ) {
        return { event_type: 'marked_applied', meta: course.last_event_meta || null };
    }
    const t = String(course.last_event_type || '');
    // List rows often store package_saved as last_event — prefer outcome/filled signals.
    if (isSecondaryStatusEvent(t) || isNoiseEvent(t)) {
        if (course.filled_at) {
            return { event_type: 'awaiting_manual_submit', meta: course.last_event_meta || null };
        }
    }
    if (isSuccessEvent(t)) {
        return { event_type: t, meta: course.last_event_meta || null };
    }
    return {
        event_type: course.last_event_type || '',
        meta: course.last_event_meta || null
    };
}

/**
 * Classify a bid course for Auto Bidder list/detail.
 * @returns {{ kind: 'success'|'filled'|'failed'|'attention'|'running'|'unknown', label: string, short: string }}
 */
export function courseRunStatus(course) {
    const status = lastStatusEvent(course);
    const event = String(status.event_type || course?.last_event_type || '');
    const outcome = String(course?.outcome || '').toLowerCase();
    const meta = status.meta || course?.last_event_meta;
    const appStatus = String(course?.application_status || course?.status || '').toLowerCase();

    // True site success only — never conflate with “filled form”.
    if (
        outcome === 'applied'
        || appStatus === 'applied'
        || isSuccessEvent(event)
    ) {
        return { kind: 'success', label: 'SUCCESS — Site confirmed the application', short: 'SUCCESS' };
    }
    if (isCaptchaAttention(event, meta)) {
        return {
            kind: 'attention',
            label: failureLabel(event, meta) || 'Needs CAPTCHA / login',
            short: /login/i.test(event) ? 'LOGIN' : 'CAPTCHA'
        };
    }
    if (isTabClosedEvent(event, meta)) {
        return {
            kind: 'attention',
            label: 'TAB CLOSED — Open tab, then Re-autofill',
            short: 'TAB CLOSED'
        };
    }
    if (/^item_aborted$/i.test(event) && !isBudgetExceededMeta(meta)) {
        const err = String(meta?.error || '').trim();
        return {
            kind: 'attention',
            label: err ? `SKIPPED — ${err}` : 'SKIPPED — Bid aborted (see log)',
            short: 'SKIPPED'
        };
    }
    if (isBudgetExceededEvent(event, meta)) {
        const lim = Number(meta?.limitMs);
        const sec = Number.isFinite(lim) ? Math.round(lim / 1000) : 90;
        return {
            kind: 'failed',
            label: `TIME LIMIT — Bid stopped (~${sec}s budget)`,
            short: 'TIME LIMIT'
        };
    }
    if (/reautofill_failed/i.test(event)) {
        const err = String(meta?.error || '').trim();
        return {
            kind: 'failed',
            label: /Tab closed/i.test(err)
                ? 'RE-FILL FAIL — Apply tab missing. Open tab, then try again'
                : (err ? `RE-FILL FAIL — ${err}` : 'RE-FILL FAIL — Open tab and try again'),
            short: 'RE-FILL FAIL'
        };
    }
    // Apply still on JD / account create — keep as ATTENTION so Resume/Open stay useful.
    if (/needs_manual/i.test(event) && /apply_gate|apply_visible/i.test(String(meta?.reason || ''))) {
        return {
            kind: 'attention',
            label: 'APPLY — Click Apply / create account, then Resume',
            short: 'APPLY'
        };
    }
    // Incomplete required fields — before FAILED / FILLED so a later package_saved
    // or accidental needs_manual does not hide the real outcome.
    if (isIncompleteFillEvent(event, meta)) {
        const ro = meta?.requiredOk;
        const rt = meta?.requiredTotal;
        const ratio = Number.isFinite(Number(ro)) && Number(rt) > 0
            ? ` (${ro}/${rt} required)`
            : '';
        const missing = Array.isArray(meta?.missing)
            ? meta.missing
            : (Array.isArray(meta?.missingRequired) ? meta.missingRequired : []);
        const missHint = missing.filter(Boolean).slice(0, 2).join('; ');
        return {
            kind: 'attention',
            label: missHint
                ? `Fill incomplete${ratio} — ${missHint}`
                : `Fill incomplete${ratio} — finish empty required fields`,
            short: 'INCOMPLETE'
        };
    }
    if (isFailureEvent(event, meta) || outcome === 'rejected' || appStatus === 'rejected') {
        return {
            kind: 'failed',
            label: failureLabel(event, meta) || 'Failed',
            short: 'FAILED'
        };
    }
    // FILLED = form filled / package saved — NOT the same as SUCCESS (site thank-you).
    // Ignore package_saved when the fill was incomplete (e.g. only 2 fields).
    const packageIncomplete = /^package_saved$/i.test(event)
        && (meta?.incomplete === true
            || (Number.isFinite(Number(meta?.filled)) && Number(meta.filled) < 5));
    if (
        (course?.filled_at
            || isFilledEvent(event)
            || (/^package_saved$/i.test(event) && !packageIncomplete))
        && !packageIncomplete
    ) {
        return {
            kind: 'filled',
            label: 'Filled — waiting for thank-you',
            short: 'FILLED'
        };
    }
    if (/fill_incomplete/i.test(event) || packageIncomplete) {
        return {
            kind: 'attention',
            label: 'Fill incomplete — many required fields still empty',
            short: 'INCOMPLETE'
        };
    }
    if (/generate_done|cv_regenerat|bidder_answers_ready/i.test(event)) {
        return {
            kind: 'unknown',
            label: /cv_regenerate_needed/i.test(event)
                ? 'CV quality warning — regenerate then Process'
                : /bidder_answers_ready/i.test(event)
                    ? 'Answers ready — still filling (not done yet)'
                    : 'CV ready — not bid yet',
            short: /cv_regenerate/i.test(event) ? 'CV WARN' : /bidder_answers_ready/i.test(event) ? 'ANSWERS' : 'READY'
        };
    }
    if (/^stale_run$/i.test(event)) {
        const prior = String(meta?.prior || '');
        const reason = String(meta?.reason || '');
        if (/blocked_ats/i.test(prior) && /greenhouse-only|greenhouse_only|use_autofill/i.test(reason)) {
            return {
                kind: 'unknown',
                label: 'Stale run — reload Lumi v1.8.65+ and click Process again',
                short: 'RETRY'
            };
        }
        return {
            kind: 'unknown',
            label: 'Stale run — reload Lumi and click Process again',
            short: 'STALE'
        };
    }
    const updatedMs = course?.updated_at ? new Date(course.updated_at).getTime() : 0;
    const ageMs = updatedMs ? Date.now() - updatedMs : Infinity;
    if (/^autofill_engine$/i.test(event)) {
        if (ageMs > 10 * 60 * 1000) {
            return {
                kind: 'unknown',
                label: 'Stale autofill run — reload Lumi and click Process again',
                short: 'STALE'
            };
        }
        return { kind: 'running', label: 'Autofill starting…', short: 'RUNNING' };
    }
    if (
        /queue_|opened|form_|answers_generating|mid_fill|after_fill|fill_retry|dial_|ai_skipped_budget|profile_fill/i.test(event)
        && ageMs <= 45 * 60 * 1000
    ) {
        return { kind: 'running', label: 'In progress…', short: 'RUNNING' };
    }
    if (
        /queue_|opened|form_|answers_generating|mid_fill|after_fill|fill_retry|dial_|ai_skipped_budget|profile_fill/i.test(event)
        && ageMs > 45 * 60 * 1000
    ) {
        return {
            kind: 'unknown',
            label: 'Stale run — click Process again',
            short: 'STALE'
        };
    }
    if (outcome && outcome !== 'unknown') {
        return { kind: 'unknown', label: outcome, short: String(outcome).toUpperCase() };
    }
    return { kind: 'unknown', label: 'No result yet', short: '—' };
}

/** Tailwind classes for outcome pills (list + filters). */
export function runStatusBadgeClass(kind) {
    switch (kind) {
        case 'success':
            return 'border-emerald-500/60 bg-emerald-500/20 text-emerald-200';
        case 'filled':
            return 'border-sky-500/50 bg-sky-500/15 text-sky-200';
        case 'failed':
            return 'border-red-500/60 bg-red-500/20 text-red-200';
        case 'attention':
            return 'border-amber-500/60 bg-amber-500/20 text-amber-100';
        case 'running':
            return 'border-primary/50 bg-primary/15 text-primary';
        default:
            return 'border-border/70 bg-muted/40 text-muted-foreground';
    }
}

/** Left border / row tint so success vs failure is obvious at a glance. */
export function runStatusRowClass(kind) {
    switch (kind) {
        case 'success':
            return 'border-l-4 border-l-emerald-500';
        case 'filled':
            return 'border-l-4 border-l-sky-500';
        case 'failed':
            return 'border-l-4 border-l-red-500';
        case 'attention':
            return 'border-l-4 border-l-amber-500';
        case 'running':
            return 'border-l-4 border-l-primary';
        default:
            return 'border-l-4 border-l-border';
    }
}

export function runStatusBannerClass(kind) {
    switch (kind) {
        case 'success':
            return 'border-emerald-500/60 bg-emerald-500/15 text-emerald-50';
        case 'filled':
            return 'border-sky-500/50 bg-sky-500/15 text-sky-50';
        case 'failed':
            return 'border-red-500/60 bg-red-500/15 text-red-100';
        case 'attention':
            return 'border-amber-400/60 bg-amber-500/15 text-amber-50';
        case 'running':
            return 'border-sky-500/40 bg-sky-500/10 text-sky-100';
        default:
            return 'border-border/70 bg-muted/30 text-muted-foreground';
    }
}

export function runStatusHeadline(kind, short) {
    switch (kind) {
        case 'success':
            return 'SUCCESS — Applied on site';
        case 'filled':
            return 'Filled — waiting for thank-you';
        case 'failed':
            if (short === 'TIME LIMIT') return 'TIME LIMIT — Bid budget used';
            if (short === 'RE-FILL FAIL') return 'RE-FILL FAIL — Could not re-autofill';
            return 'FAILED — Did not complete';
        case 'attention':
            if (short === 'INCOMPLETE') return 'INCOMPLETE — Required fields still empty';
            if (short === 'TAB CLOSED') return 'TAB CLOSED — Apply tab gone';
            if (short === 'SKIPPED') return 'SKIPPED — Bid aborted';
            if (short === 'APPLY') return 'APPLY — Click Apply / create account';
            return 'NEEDS ATTENTION — CAPTCHA / login';
        case 'running':
            return 'RUNNING — Still in progress';
        default:
            return short && short !== '—' ? String(short) : 'NO CLEAR RESULT YET';
    }
}

/** Ordered bid pipeline steps (shown under the progress bar). */
export const BID_PROGRESS_STEPS = [
    { id: 'open', label: 'Open' },
    { id: 'form', label: 'Form' },
    { id: 'answers', label: 'Answers' },
    { id: 'fill', label: 'Fill' },
    { id: 'done', label: 'Done' }
];

/**
 * Map course events (+ optional Lumi queue state) to a progress bar model
 * matching Auto Bidder bidding-state copy.
 *
 * @returns {{
 *   pct: number,
 *   label: string,
 *   tone: 'sky'|'amber'|'emerald'|'rose'|'muted',
 *   stepIndex: number,
 *   steps: typeof BID_PROGRESS_STEPS,
 *   queueIndex: number|null,
 *   queueTotal: number|null,
 *   queueLabel: string
 * }}
 */
export function bidStageProgress({
    events,
    lastEventType,
    lastEventMeta,
    queueState,
    courseOutcome = '',
    appliedAt = null
} = {}) {
    const list = Array.isArray(events) ? events : [];
    // Prefer terminal SUCCESS over a later reautofill_done / ready_to_submit,
    // unless a later success_revoked cleared a false positive.
    let last = null;
    let revokeIdx = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const et = list[i]?.event_type;
        if (/success_revoked|false_success_cleared/i.test(et || '')) {
            if (revokeIdx < 0) revokeIdx = i;
            continue;
        }
        if (isSuccessEvent(et) && (revokeIdx < 0 || i > revokeIdx)) {
            last = list[i];
            break;
        }
    }
    if (!last) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const et = list[i]?.event_type;
            if (isNoiseEvent(et) || isSecondaryStatusEvent(et)) continue;
            last = list[i];
            break;
        }
    }
    if (!last) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (!isNoiseEvent(list[i]?.event_type)) {
                last = list[i];
                break;
            }
        }
    }
    if (!last && (lastEventType || lastEventMeta)) {
        last = { event_type: lastEventType, meta: lastEventMeta };
    }
    const qs = queueState && typeof queueState === 'object' ? queueState : null;
    const queueSuccess = isSuccessEvent(qs?.lastStatusEvent);
    const courseApplied = String(courseOutcome || '').toLowerCase() === 'applied' || !!appliedAt;
    let t = String(last?.event_type || lastEventType || '');
    if (courseApplied || queueSuccess) {
        t = 'marked_applied';
    } else if (isSuccessEvent(qs?.lastStatusEvent) && !isSuccessEvent(t)) {
        t = String(qs.lastStatusEvent);
    }
    const meta = (last?.meta && typeof last.meta === 'object' ? last.meta : null)
        || (lastEventMeta && typeof lastEventMeta === 'object' ? lastEventMeta : {})
        || {};

    const qStatus = String(qs?.status || '');
    const queueTotal = Number(qs?.total) > 0 ? Number(qs.total) : null;
    const queueIndex = Number(qs?.index) > 0 ? Number(qs.index) : null;
    const processed = Number(qs?.processed);
    const queueLabel = queueTotal
        ? `Job ${Math.min(queueIndex || processed || 0, queueTotal) || 0} of ${queueTotal}`
        : '';

    let stepIndex = -1;
    let pct = 0;
    let label = '';
    let tone = 'muted';

    const bump = (idx, p, text, nextTone = 'sky') => {
        stepIndex = idx;
        pct = p;
        label = text;
        tone = nextTone;
    };

    if (/marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(t) || courseApplied) {
        bump(4, 100, 'SUCCESS — Applied on site', 'emerald');
    } else if (isTabClosedEvent(t, meta)) {
        bump(Math.max(stepIndex, 1), Math.max(pct, 40), 'TAB CLOSED — Open tab, then Re-autofill', 'amber');
    } else if (isBudgetExceededEvent(t, meta)) {
        const lim = Number(meta.limitMs);
        const sec = Number.isFinite(lim) ? Math.round(lim / 1000) : 90;
        bump(Math.max(stepIndex, 2), Math.max(pct, 55), `TIME LIMIT — Bid stopped (~${sec}s)`, 'rose');
    } else if (/reautofill_failed/i.test(t)) {
        const err = String(meta.error || '').trim();
        bump(
            Math.max(stepIndex, 2),
            Math.max(pct, 50),
            /Tab closed/i.test(err)
                ? 'RE-FILL FAIL — Apply tab missing'
                : (err ? `RE-FILL FAIL — ${err}` : 'RE-FILL FAIL — Open tab and retry'),
            'rose'
        );
    } else if (/^item_aborted$/i.test(t)) {
        const err = String(meta.error || '').trim();
        bump(Math.max(stepIndex, 1), Math.max(pct, 35), err ? `SKIPPED — ${err}` : 'SKIPPED — Bid aborted', 'amber');
    } else if (/fill_failed|open_failed|blocked_ats|cv_regenerate_failed/i.test(t)) {
        bump(Math.max(stepIndex, 1), Math.max(pct, 35), `FAILED — ${meta.error || t}`, 'rose');
    } else if (/needs_captcha|captcha_abandoned|login_wall/i.test(t) || /awaiting_captcha/i.test(qStatus)) {
        bump(2, 48, /login/i.test(t) || meta.kind === 'login'
            ? 'Paused — login wall'
            : /awaiting_captcha/i.test(qStatus)
                ? 'CAPTCHA wait — helpers / Resume (fill starts when form ready)'
                : 'Paused — CAPTCHA / login', 'amber');
    } else if (/done/i.test(qStatus)) {
        // Queue ended — classify outcome even if last event is still mid-fill.
        if (/marked_applied|submitted_ok|submitted/i.test(t)) {
            bump(4, 100, 'SUCCESS — Applied on site', 'emerald');
        } else if (/awaiting_manual_submit|after_fill|fill_done|ready_to_submit|reautofill_done/i.test(t)) {
            bump(4, 100, 'Filled — waiting for thank-you', 'sky');
        } else if (/fill_incomplete|submit_blocked_incomplete/i.test(t)) {
            const ro = Number(meta.requiredOk);
            const rt = Number(meta.requiredTotal);
            const ratio = rt > 0 && Number.isFinite(ro) ? ` ${ro}/${rt}` : '';
            const missing = Array.isArray(meta.missing)
                ? meta.missing
                : (Array.isArray(meta.missingRequired) ? meta.missingRequired : []);
            const missHint = missing.filter(Boolean).slice(0, 2).join('; ');
            bump(4, 90, missHint
                ? `INCOMPLETE —${ratio} ${missHint}`
                : `INCOMPLETE — required fields empty${ratio}`, 'amber');
        } else if (/fill_failed|open_failed|blocked_ats|cv_regenerate_failed|captcha_abandoned|bid_budget_exceeded|reautofill_failed/i.test(t)
            || isBudgetExceededEvent(t, meta)) {
            bump(4, 100, isBudgetExceededEvent(t, meta)
                ? 'TIME LIMIT — Bid stopped'
                : /reautofill_failed/i.test(t)
                    ? `RE-FILL FAIL — ${meta.error || t}`
                    : `FAILED — ${meta.error || t}`, 'rose');
        } else if (/tab_closed|item_aborted/i.test(t) || isTabClosedEvent(t, meta)) {
            bump(4, 90, isTabClosedEvent(t, meta)
                ? 'TAB CLOSED — Open tab, then Re-autofill'
                : `SKIPPED — ${meta.error || t}`, 'amber');
        } else if (/needs_captcha|login_wall/i.test(t)) {
            bump(4, 90, 'Needs CAPTCHA / login — not finished', 'amber');
        } else {
            bump(4, 100, 'Queue finished — NOT confirmed success (open Bid course)', 'muted');
        }
    } else if (/stopped/i.test(qStatus)) {
        bump(Math.max(stepIndex, 0), Math.max(pct, 20), 'Queue stopped — not a confirmed success', 'muted');
    } else if (/fill_incomplete|submit_blocked_incomplete/i.test(t)) {
        const ro = Number(meta.requiredOk);
        const rt = Number(meta.requiredTotal);
        const ratio = rt > 0 && Number.isFinite(ro) ? ` ${ro}/${rt} required` : '';
        const missing = Array.isArray(meta.missing)
            ? meta.missing
            : (Array.isArray(meta.missingRequired) ? meta.missingRequired : []);
        const missHint = missing.filter(Boolean).slice(0, 2).join('; ');
        bump(3, Math.min(90, 62 + (rt > 0 ? Math.round((ro / rt) * 28) : 10)),
            missHint
                ? `INCOMPLETE —${ratio} ${missHint}`
                : `INCOMPLETE — finish empty fields${ratio}`, 'amber');
    } else if (/awaiting_manual_submit|after_fill|ready_to_submit|fill_done|reautofill_done/i.test(t)) {
        bump(4, 92, 'Filled — waiting for thank-you', 'sky');
    } else if (/autofill|dial_country|fill_retry|mid_fill/i.test(t)) {
        const ro = Number(meta.requiredOk);
        const rt = Number(meta.requiredTotal);
        if (/fill_retry/i.test(t) && meta.willRetry === true) {
            bump(3, 68, 'Fill disconnected — retrying…', 'sky');
        } else if (/fill_retry/i.test(t) && meta.willRetry === false) {
            bump(3, 60, 'Fill retry stopped — check Open tab', 'amber');
        } else if (rt > 0 && Number.isFinite(ro)) {
            const fillPct = 62 + Math.round(Math.min(1, ro / rt) * 28);
            bump(3, fillPct, `Filling fields… ${ro}/${rt} required`, 'sky');
        } else {
            bump(3, 72, 'Filling application form…', 'sky');
        }
    } else if (/ai_skipped_budget/i.test(t)) {
        bump(3, 68, 'AI skipped (time budget) — filling with profile…', 'sky');
    } else if (/bidder_answers_ready/i.test(t)) {
        bump(3, 62, 'Answers ready — filling fields…', 'sky');
    } else if (/profile_fill_started/i.test(t)) {
        bump(3, 55, 'Filling profile & resume…', 'sky');
    } else if (/package_saved/i.test(t)) {
        // package_saved often lands after fill — do not call it “answers ready”.
        bump(4, 88, 'FILLED — Package saved (confirm on site for SUCCESS)', 'sky');
    } else if (/answers_generating/i.test(t)) {
        bump(2, 48, 'Generating answers… (fill starts in parallel)', 'sky');
    } else if (/form_revealed|form_detected/i.test(t)) {
        bump(1, 36, 'Application form ready — starting fill', 'sky');
    } else if (/opened/i.test(t)) {
        bump(0, 22, 'Opened apply page — revealing form…', 'sky');
    } else if (/queue_started|queue_enqueued/i.test(t)) {
        bump(0, 12, 'Starting bid…', 'sky');
    } else if (/running/i.test(qStatus)) {
        bump(0, 10, 'Bidding in progress…', 'sky');
    } else if (!t && !qStatus) {
        return {
            pct: 0,
            label: '',
            tone: 'muted',
            stepIndex: -1,
            steps: BID_PROGRESS_STEPS,
            queueIndex,
            queueTotal,
            queueLabel
        };
    }

    // Blend queue position with current-job stage so multi-job Process advances the bar.
    if (queueTotal && queueIndex != null && tone !== 'rose') {
        const stageFrac = Math.min(1, Math.max(0, pct / 100));
        const overall = ((Math.max(0, queueIndex - 1) + stageFrac) / queueTotal) * 100;
        if (/done/i.test(qStatus)) {
            pct = 100;
            // Keep outcome label from the done-branch above — don't re-prefix mid-fill text.
            if (queueLabel && label && !/SUCCESS|FAILED|FILLED|TIME LIMIT|TAB CLOSED|SKIPPED|RE-FILL|Queue finished|Needs CAPTCHA|INCOMPLETE/i.test(label)) {
                label = `${queueLabel} · ${label}`;
            }
        } else {
            pct = Math.round(Math.min(99, Math.max(pct, overall)));
            if (queueLabel && label && !/Queue finished/i.test(label)) {
                label = `${queueLabel} · ${label}`;
            } else if (queueLabel && !label) {
                label = queueLabel;
            }
        }
    } else if (queueLabel && label && !/done|stopped/i.test(qStatus) && !/Queue finished/i.test(label)) {
        label = `${queueLabel} · ${label}`;
    }

    pct = Math.max(0, Math.min(100, Math.round(pct)));

    // Never show 100% while still mid-fill (answers ready / filling) — that reads as false success.
    if (
        pct >= 100
        && !/done|stopped/i.test(qStatus)
        && /answers ready|filling fields|filling application|generating answers|starting bid|in progress/i.test(label)
    ) {
        pct = 96;
        tone = tone === 'emerald' ? 'sky' : tone;
    }

    if (Array.isArray(list) && list.length && tone !== 'rose' && tone !== 'emerald' && !/done|stopped/i.test(qStatus)) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            const ev = list[i];
            if (isNoiseEvent(ev?.event_type)) continue;
            if (!/mid_fill|fill_done|awaiting_manual_submit|ready_to_submit|reautofill_done/i.test(ev?.event_type || '')) {
                continue;
            }
            const m = ev.meta && typeof ev.meta === 'object' ? ev.meta : {};
            const rt = Number(m.requiredTotal);
            const ro = Number(m.requiredOk);
            if (rt > 0 && Number.isFinite(ro)) {
                const fillPct = 62 + Math.round(Math.min(1, ro / rt) * 28);
                if (fillPct > pct) {
                    pct = fillPct;
                    if (/mid_fill/i.test(ev.event_type)) {
                        label = `Filling fields… ${ro}/${rt} required`;
                        tone = 'sky';
                        stepIndex = 3;
                    }
                }
            }
            break;
        }
    }

    return {
        pct,
        label,
        tone,
        stepIndex,
        steps: BID_PROGRESS_STEPS,
        queueIndex,
        queueTotal,
        queueLabel
    };
}

export function describeBidCourseFailure(eventType, meta, ctx = {}) {
    const t = String(eventType || '');
    const m = meta && typeof meta === 'object' ? meta : {};
    const jobUrl = m.url || ctx.jobUrl || ctx.job_url || '';
    let atsId = m.ats ? String(m.ats).toLowerCase() : detectAtsFromUrl(jobUrl).id;
    if ((atsId === 'other' || atsId === 'unknown') && jobUrl) {
        atsId = detectAtsFromUrl(jobUrl).id;
    }
    const ats = atsLabel(atsId);
    const host = hostFromUrl(jobUrl);

    if (/blocked_ats/i.test(t)) {
        const where = host ? `${ats} (${host})` : ats;
        const reason = String(m.reason || m.error || '').trim();
        // Stale events from Greenhouse-only bidder-engine-v1 (pre multi-ATS autofill).
        if (/greenhouse-only|greenhouse_only|use_autofill/i.test(reason)) {
            const nowSupported = !['linkedin'].includes(atsId);
            if (nowSupported) {
                return (
                    `${where} was skipped by an older Lumi build. `
                    + 'Reload Lumi (chrome://extensions → Reload, need v1.8.50+), '
                    + 'then click Process selected again — Oracle / Workday / Lever / etc. autofill runs now.'
                );
            }
            return `An older Lumi build skipped this job (${where}). Reload Lumi v1.8.50+, then Process again.`;
        }
        if (atsId === 'linkedin') {
            return `LinkedIn Easy Apply is not supported. This job uses ${where}. Fix: open the employer's direct apply link, or apply manually.`;
        }
        if (reason) {
            return `Autofill blocked on ${where}: ${reason}`;
        }
        return `Autofill could not run on ${where}. Open the apply page and finish fields manually.`;
    }
    if (/open_failed/i.test(t)) {
        return m.error
            ? `Could not open the application tab: ${m.error}`
            : 'Could not open the application tab. Check the job URL and try again.';
    }
    if (isTabClosedEvent(t, m)) {
        return 'Apply tab was closed mid-bid. Click Open tab (or reopen the job), then Re-autofill.';
    }
    if (isBudgetExceededEvent(t, m)) {
        const lim = Number(m.limitMs);
        const sec = Number.isFinite(lim) ? Math.round(lim / 1000) : 90;
        return `Bid hit the ~${sec}s time budget and was stopped so the queue could continue. Open tab to finish manually, or Process the next job.`;
    }
    if (/reautofill_failed/i.test(t)) {
        const err = String(m.error || '').trim();
        if (/Tab closed/i.test(err)) {
            return 'Re-autofill failed because the apply tab is gone. Open tab, then try Re-autofill again.';
        }
        return err
            ? `Re-autofill failed: ${err}`
            : 'Re-autofill failed. Open the apply tab and try again.';
    }
    if (/^item_aborted$/i.test(t)) {
        const err = String(m.error || '').trim();
        return err
            ? `This bid was skipped: ${err}`
            : 'This bid was aborted. See Bid course log, or Open tab / Process next.';
    }
    if (/fill_failed/i.test(t)) {
        const err = String(m.error || '');
        if (/captcha_needs_manual|captcha/i.test(err)) {
            return 'CAPTCHA or bot check detected. Open the apply tab, solve it, then click Resume CAPTCHA — or wait; Lumi auto-detects when it clears.';
        }
        if (/already in progress/i.test(err)) {
            return 'Autofill collided with another fill (usually a double-start). Reload Lumi, then Process again — queue fill no longer races itself.';
        }
        if (/Tab closed/i.test(err)) {
            return 'Apply tab closed during fill. Open tab, then Re-autofill.';
        }
        return m.error
            ? `Autofill failed: ${m.error}`
            : 'Autofill failed on the application form. Open the job page and finish fields manually.';
    }
    if (/ai_failed/i.test(t)) {
        return m.error
            ? `AI answer generation failed: ${m.error}`
            : 'AI could not generate written answers. Check MiniMax/Ollama settings and retry.';
    }
    if (/cv_regenerate_failed/i.test(t)) {
        return m.error
            ? `CV regenerate failed: ${m.error}`
            : 'CV quality check asked for a regenerate but generation failed (resume queue may be down).';
    }
    if (/needs_captcha|captcha_abandoned/i.test(t)) {
        if (m.unattended) {
            return 'CAPTCHA appeared while Unattended — this job was skipped so the queue kept moving. Open Bid courses → Needs CAPTCHA later when you can solve it, or re-queue the job.';
        }
        return 'CAPTCHA or bot check detected. Open the apply tab (or click Open apply tab in Auto Bidder), solve it, then click Resume CAPTCHA — or wait; Lumi auto-detects when it clears.';
    }
    if (/login_wall/i.test(t)) {
        return 'Login wall detected — sign in on the apply tab, then click Resume CAPTCHA in Auto Bidder.';
    }
    if (/no_form/i.test(t)) {
        return 'No application form was detected on the page. The URL may be a job description only, or the ATS layout is unsupported.';
    }
    if (/needs_manual/i.test(t)) {
        if (/apply_gate|apply_visible/i.test(String(m.reason || ''))) {
            return 'Apply button was still on the job page (or account create needed). Open the tab → click Apply / create account → Resume in Control.';
        }
        return m.reason || m.error || 'Manual completion required on this application.';
    }
    if (m.error) return String(m.error);
    if (m.reason) return String(m.reason);
    return '';
}

export function failureSummary(eventType, meta, ctx = {}) {
    const t = String(eventType || '');
    if (!isFailureEvent(t, meta)) return '';
    const full = describeBidCourseFailure(t, meta, ctx);
    if (full) return full;

    const m = meta && typeof meta === 'object' ? meta : {};
    if (/blocked_ats/i.test(t)) {
        const ats = m.ats ? atsLabel(m.ats) : detectAtsFromUrl(m.url || ctx.jobUrl).label;
        return `Autofill blocked — ${ats}`;
    }
    return failureLabel(t);
}

export function failureLabel(eventType, meta) {
    const t = String(eventType || '');
    const m = meta && typeof meta === 'object' ? meta : {};
    if (isTabClosedEvent(t, m)) return 'Tab closed';
    if (isBudgetExceededEvent(t, m)) return 'Time limit';
    if (/reautofill_failed/i.test(t)) return 'Re-autofill failed';
    if (/^item_aborted$/i.test(t)) return 'Skipped';
    if (/blocked_ats/i.test(t)) {
        const reason = String(m.reason || m.error || '');
        if (/greenhouse-only|greenhouse_only|use_autofill/i.test(reason)) return 'Retry with new Lumi';
        if (String(m.ats || '').toLowerCase() === 'linkedin') return 'LinkedIn unsupported';
        return 'Autofill blocked';
    }
    if (/open_failed/i.test(t)) return 'Open failed';
    if (/fill_failed/i.test(t)) {
        if (/captcha_needs_manual|captcha/i.test(String(m.error || m.reason || ''))) return 'Needs CAPTCHA';
        if (/Tab closed/i.test(String(m.error || ''))) return 'Tab closed';
        if (isBudgetExceededMeta(m)) return 'Time limit';
        return 'Fill failed';
    }
    if (/ai_failed/i.test(t)) return 'AI failed';
    if (/cv_regenerate_needed/i.test(t)) return 'CV quality warning';
    if (/cv_regenerate_failed/i.test(t)) return 'CV regenerate failed';
    if (/needs_captcha|captcha_abandoned/i.test(t)) return 'Needs CAPTCHA';
    if (/needs_manual|login_wall|no_form/i.test(t)) {
        if (/apply_gate|apply_visible/i.test(String(m.reason || ''))) return 'Needs Apply click';
        return 'Needs manual';
    }
    return 'Failed';
}

export function describeEventMeta(eventType, meta, ctx = {}) {
    const detail = describeBidCourseFailure(eventType, meta, ctx);
    if (detail) return detail;
    const m = meta && typeof meta === 'object' ? meta : {};
    if (typeof meta === 'string' && meta.trim()) return meta.trim();
    const bits = [m.error, m.reason, m.ats && atsLabel(m.ats), m.stage].filter(Boolean);
    return bits.join(' · ');
}

/** Format elapsed time from course start: "after 1s", "after 2m 15s", "after 10m". */
export function formatElapsedSince(startAt, eventAt) {
    const start = startAt ? new Date(startAt).getTime() : NaN;
    const at = eventAt ? new Date(eventAt).getTime() : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(at)) return '';
    const sec = Math.max(0, Math.round((at - start) / 1000));
    if (sec < 60) return `after ${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? `after ${m}m ${s}s` : `after ${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `after ${h}h ${rm}m` : `after ${h}h`;
}

/** Compact duration for Live monitor totals: "12s", "2m 15s", "1h 3m". */
export function formatDurationCompact(seconds) {
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Total elapsed between two timestamps (ISO string, Date, or ms).
 * Uses endAt when provided (finished job); otherwise Date.now() for a live clock.
 */
export function formatTotalElapsed(startAt, endAt = null) {
    const start = startAt instanceof Date
        ? startAt.getTime()
        : (typeof startAt === 'number' ? startAt : new Date(startAt).getTime());
    if (!Number.isFinite(start) || start <= 0) return '';
    const end = endAt == null
        ? Date.now()
        : (endAt instanceof Date
            ? endAt.getTime()
            : (typeof endAt === 'number' ? endAt : new Date(endAt).getTime()));
    if (!Number.isFinite(end)) return '';
    return formatDurationCompact(Math.max(0, (end - start) / 1000));
}
