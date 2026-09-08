/**
 * Short, clear Auto Bidder notification copy.
 * One fact per line — no stacked jargon.
 */

const MAX_SHORT = 72;

/** @typedef {'ok'|'warn'|'error'|'learn'|'info'} NotifKind */

/**
 * @param {string} raw
 * @returns {NotifKind}
 */
export function inferNotifKind(raw) {
    const s = String(raw || '');
    if (/fail|error|abort|blocked|incomplete|could not|did not|nothing to|login_required|auth/i.test(s)) {
        return 'error';
    }
    if (/captcha|paused|waiting|resume|manual|FILLED|incomplete|skip|time limit|tab closed/i.test(s)) {
        return 'warn';
    }
    if (/learn|learned|instruction|lesson/i.test(s)) return 'learn';
    if (/SUCCESS|thank-you|applied|queue started|OK\b|cleared|connected/i.test(s)) return 'ok';
    return 'info';
}

/**
 * Collapse long / messy bidder status into one short line.
 * @param {string} raw
 * @returns {string}
 */
export function shortenNotifyText(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';

    // Drop redundant product prefixes
    s = s.replace(/^(?:Lumi|Bidder|Auto Bidder)\s*[:—-]\s*/i, '');

    const rules = [
        [/queue already in progress|queue already running/i, 'Queue already running — use Live monitor'],
        [/restored — lumi paused on captcha/i, 'Restored — paused on CAPTCHA'],
        [/restored — lumi still running/i, 'Restored — still bidding'],
        [/queue started[^.]*?(\d+)\s*(?:ready application|job)/i, (_, n) => `Queue started · ${n} jobs`],
        [/queue finished[^.]*?(\d+)\s*processed/i, (_, n) => `Queue finished · ${n} processed`],
        [/bidding via lumi(?:\s*·\s*queued\s*(\d+))?/i, (_, n) => (n ? `Bidding · queued ${n}` : 'Bidding…')],
        [/re-autofilling current apply tab/i, 'Re-autofill…'],
        [/re-autofill done — submit clicked[^.]*?\((\d+)/i, (_, n) => `Re-fill OK · submit · ${n} fields`],
        [/re-autofill finished — still incomplete[^.]*?\((\d+)/i, (_, n) => `Re-fill incomplete · ${n} fields`],
        [/re-autofill filled (\d+)/i, (_, n) => `Re-fill · ${n} fields`],
        [/updating state from apply tab/i, 'Checking site state…'],
        [/update state — site thank-you detected/i, 'SUCCESS — thank-you on site'],
        [/update state — form open \(not SUCCESS\)/i, 'Form open — not SUCCESS yet'],
        [/clicking submit on apply tab/i, 'Clicking Submit…'],
        [/submit clicked — thank-you detected/i, 'SUCCESS — thank-you'],
        [/already submitted|already marked applied/i, 'Already submitted'],
        [/submit clicked — waiting for site confirmation/i, 'Submit clicked — waiting thank-you'],
        [/resuming after captcha/i, 'Resuming after CAPTCHA…'],
        [/checking captcha/i, 'Checking CAPTCHA…'],
        [/captcha resume signaled/i, 'CAPTCHA resume — fill continues when clear'],
        [/captcha job skipped/i, 'CAPTCHA job skipped — queue continues'],
        [/skipping captcha job/i, 'Skipping CAPTCHA job…'],
        [/opening apply tabs \(no lumi autofill\)/i, 'Opening tabs (manual fill)…'],
        [/opened (\d+) apply tab/i, (_, n) => `Opened ${n} apply tab(s)`],
        [/stopping current queue/i, 'Stopping queue, then restarting…'],
        [/no lumi history to clear/i, 'No history to clear'],
        [/cleared (\d+) bid course/i, (_, n) => `Cleared ${n} course(s)`],
        [/reconnecting lumi/i, 'Reconnecting Lumi…'],
        [/lumi v([\d.]+) connected/i, (_, v) => `Lumi v${v} connected`],
        [/applied (\d+) answer\(s\) to form \((\d+) fields\)/i, (_, a, f) => `Applied ${a} answers · ${f} fields`],
        [/apply answers/i, 'Applying answers…'],
        [/filled — form filled[^.]*not SUCCESS/i, 'Filled — waiting for thank-you'],
        [/FILLED — Form filled[^.]*not SUCCESS/i, 'Filled — waiting for thank-you'],
        [/SUCCESS — Applied on site/i, 'SUCCESS — applied on site'],
        [/incomplete fill[^.]*required/i, 'Incomplete — required fields empty'],
        [/fill done[^.]*tab closed/i, 'Fill done — tab closed'],
        [/form filled \(not SUCCESS yet\)/i, 'Filled — waiting for thank-you'],
        [/watch the live monitor/i, ''], // strip trailing CTA noise when combined
        [/dialog closed · live monitor[^.]+/i, ''],
        [/you can use other tabs\.?/i, ''],
        [/check bid courses for success \/ failed\.?/i, ''],
        [/no response from lumi|postmessage_timeout|extension unavailable|bridge/i, 'Lumi offline — Reload extension, then Check Lumi'],
        [/fill incomplete[^.]*(\d+)\/(\d+)[^.]*missing:\s*(.+)/i, (_, a, b, miss) => {
            const m = String(miss || '').split(/[;,]|\s{2,}/)[0].trim().slice(0, 28);
            return m ? `Incomplete · ${a}/${b} · ${m}` : `Incomplete · ${a}/${b} required`;
        }],
        [/required fields still empty/i, 'Incomplete — required fields empty'],
        [/incomple?te\s*—\s*required/i, 'Incomplete — required fields empty']
    ];

    for (const [re, out] of rules) {
        const m = s.match(re);
        if (!m) continue;
        if (typeof out === 'function') return clip(out(...m));
        if (out === '') {
            s = s.replace(re, '').replace(/\s*[·.]\s*$/, '').trim();
            continue;
        }
        return clip(out);
    }

    // Generic tidy
    s = s
        .replace(/\s*[·|]\s*Watch the Live monitor[^.]*\.?/gi, '')
        .replace(/\s*\(not SUCCESS[^.]*\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    return clip(s);
}

function clip(s) {
    const t = String(s || '').trim();
    if (t.length <= MAX_SHORT) return t;
    return `${t.slice(0, MAX_SHORT - 1).trim()}…`;
}

/**
 * Short labels for queue / course outcome banners.
 * @param {string} label
 * @returns {string}
 */
export function shortenOutcomeLabel(label) {
    const s = String(label || '').trim();
    if (!s) return '';
    if (/^FILLED/i.test(s)) return 'Filled — waiting for thank-you';
    if (/^SUCCESS/i.test(s)) return 'SUCCESS — applied on site';
    if (/^FAILED/i.test(s)) return s.replace(/^FAILED\s*[—:-]\s*/i, 'Failed — ').slice(0, MAX_SHORT);
    if (/incomplete/i.test(s)) return 'Incomplete — required fields empty';
    if (/CAPTCHA|Paused/i.test(s)) return 'Paused — CAPTCHA / login';
    if (/TAB CLOSED/i.test(s)) return 'Tab closed — Open tab, then Re-fill';
    if (/TIME LIMIT/i.test(s)) return 'Time limit — bid stopped';
    return shortenNotifyText(s);
}

/**
 * Map course / queue event → short feed line.
 * @param {{ eventType?: string, meta?: object, queueStatus?: string }} opts
 * @returns {string}
 */
export function shortEventNotify({ eventType = '', meta = null, queueStatus = '' } = {}) {
    const t = String(eventType || '').toLowerCase();
    const m = meta && typeof meta === 'object' ? meta : {};
    const qs = String(queueStatus || '');

    if (/awaiting_email_otp/i.test(qs)) return 'Paused — email security code';
    if (/awaiting_captcha/i.test(qs)) return 'Paused — CAPTCHA / login';
    if (/awaiting_next/i.test(qs)) return 'Waiting — click Next';
    if (/marked_applied|submit_success/i.test(t)) return 'SUCCESS — thank-you';
    if (/submit_clicked/i.test(t)) return 'Submit clicked';
    if (/submit_blocked_incomplete|fill_incomplete/i.test(t)) {
        const miss = Array.isArray(m.missing) ? m.missing[0] : (m.reason || '');
        if (/location/i.test(String(miss))) return 'Blocked — Location needs city, ST, ZIP';
        if (miss) return clip(`Blocked — ${String(miss).slice(0, 40)}`);
        return 'Blocked — required fields incomplete';
    }
    if (/checkout_blocked/i.test(t)) return 'Checkout blocked — fix before submit';
    if (/checkout_ok/i.test(t)) return 'Checkout OK';
    if (/awaiting_manual_submit|package_saved|after_fill|reautofill_done|fill_done/i.test(t)) {
        return 'Filled — waiting for thank-you';
    }
    if (/submit_no_click/i.test(t)) return 'Could not click Submit';
    if (/form_detected|form_revealed/i.test(t)) return 'Form ready';
    if (/opened|queue_started/i.test(t)) return 'Job opened';
    if (/bidder_answers_ready/i.test(t)) {
        const n = Number(m.count ?? m.questions ?? NaN);
        return Number.isFinite(n) ? `Answers ready · ${n}` : 'Answers ready';
    }
    if (/fill_failed|reautofill_failed/i.test(t)) {
        return clip(`Fill failed — ${String(m.error || 'see Open tab').slice(0, 40)}`);
    }
    if (/tab_closed/i.test(t)) return 'Tab closed';
    if (/bid_budget_exceeded/i.test(t)) return 'Time limit — next job';
    if (/user_instruction|instruction_applied/i.test(t)) return 'Instruction applied';
    if (/fill_lesson_applied|learned/i.test(t)) return 'Lesson applied';
    if (/needs_manual/i.test(t)) return 'Needs manual finish';
    if (!t) return '';
    return clip(t.replace(/_/g, ' '));
}

/**
 * Merge extension uiMessageLog + local pushes; newest first; dedupe near-identical.
 * @param {Array<{at?: string|number, short?: string, message?: string, title?: string, kind?: string, id?: string}>} remote
 * @param {Array<{id: string, at: number, short: string, kind: string}>} local
 * @returns {Array<{id: string, at: number, short: string, kind: string}>}
 */
export function mergeNotifFeeds(remote = [], local = []) {
    const mapped = (Array.isArray(remote) ? remote : []).map((e, i) => {
        const short = shortenNotifyText(e.short || e.message || '')
            || shortenNotifyText([e.title, e.message].filter(Boolean).join(': '));
        const at = e.at ? new Date(e.at).getTime() : Date.now() - i;
        return {
            id: e.id || `ext-${at}-${i}`,
            at: Number.isFinite(at) ? at : Date.now(),
            short,
            kind: e.kind || inferNotifKind(short)
        };
    }).filter((e) => e.short);

    const all = [...local, ...mapped].sort((a, b) => b.at - a.at);
    const out = [];
    for (const row of all) {
        const prev = out[out.length - 1];
        if (prev && prev.short === row.short && Math.abs(prev.at - row.at) < 2500) continue;
        out.push(row);
        if (out.length >= 50) break;
    }
    return out;
}
