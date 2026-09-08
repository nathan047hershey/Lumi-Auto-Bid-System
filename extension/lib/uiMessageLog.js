/**
 * Persistent UI notification log for Lumi Control / popup.
 * Newest entries first. Caps length so storage stays small.
 */

const UI_LOG_KEY = 'uiMessageLog';
const LAST_KEY = 'lastUiMessage';
const MAX_ENTRIES = 50;
const MAX_SHORT = 72;

function clip(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t.length <= MAX_SHORT) return t;
    return `${t.slice(0, MAX_SHORT - 1).trim()}…`;
}

/** Shorten messy title+message for Control feed. */
export function shortUiMessage(title, message) {
    let s = String(message || '').replace(/\s+/g, ' ').trim();
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:Lumi|Bidder|Auto Bidder)\s*[:—-]\s*/i, '');
    if (/^Lumi$/i.test(t) || /^Bidder$/i.test(t)) {
        /* drop redundant title */
    } else if (t && !s.toLowerCase().startsWith(t.toLowerCase())) {
        s = s ? `${t}: ${s}` : t;
    }

    const rules = [
        [/incomplete fill[^.]*\((\d+)\/(\d+)/i, (_, a, b) => `Incomplete fill · ${a}/${b} required`],
        [/fill done[^.]*fields?[^.]*tab closed/i, 'Fill done — review Live monitor'],
        [/submit clicked[^.]*confirm success/i, 'Submit clicked — confirm if needed'],
        [/form filled \(not SUCCESS yet\)/i, 'Filled — waiting for thank-you'],
        [/queue finished/i, 'Queue finished'],
        [/click next in auto bidder/i, 'Waiting — click Next'],
        [/paused.*captcha/i, 'Paused — CAPTCHA / login'],
        [/nothing to bid/i, 'Nothing to bid'],
        [/log in via the extension/i, 'Log in via Lumi popup'],
        [/choose a bid profile/i, 'Choose a bid profile in popup']
    ];
    for (const [re, out] of rules) {
        if (re.test(s) || re.test(`${t} ${s}`)) {
            return clip(typeof out === 'function' ? s.replace(re, out) : out);
        }
    }
    return clip(s || t);
}

export function inferUiKind(title, message) {
    const blob = `${title} ${message}`;
    if (/fail|error|nothing|no cv|blocked|incomplete|abort|auth|login_required/i.test(blob)) {
        return 'error';
    }
    if (/captcha|paused|waiting|manual|FILLED|skip|warn/i.test(blob)) return 'warn';
    if (/learn|learned|lesson|instruction/i.test(blob)) return 'learn';
    return 'ok';
}

/**
 * Append one notification; updates lastUiMessage + uiMessageLog.
 * @returns {Promise<{at: string, title: string, message: string, short: string, kind: string}>}
 */
export async function appendUiMessage(title, message) {
    const short = shortUiMessage(title, message);
    const kind = inferUiKind(title, message);
    const entry = {
        id: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        at: new Date().toISOString(),
        title: String(title || 'Lumi').slice(0, 80),
        message: String(message || '').slice(0, 250),
        short: short || String(message || title || '').slice(0, MAX_SHORT),
        kind
    };

    try {
        const data = await chrome.storage.local.get([UI_LOG_KEY]);
        const prev = Array.isArray(data[UI_LOG_KEY]) ? data[UI_LOG_KEY] : [];
        const head = prev[0];
        let next = prev;
        if (
            head
            && head.short === entry.short
            && Date.now() - new Date(head.at).getTime() < 2000
        ) {
            next = [{ ...entry, id: head.id }, ...prev.slice(1)];
        } else {
            next = [entry, ...prev].slice(0, MAX_ENTRIES);
        }
        await chrome.storage.local.set({
            [LAST_KEY]: {
                at: entry.at,
                title: entry.title,
                message: entry.message,
                short: entry.short,
                kind: entry.kind
            },
            [UI_LOG_KEY]: next
        });
    } catch (_) { /* ignore */ }

    return entry;
}

export async function getUiMessageLog() {
    try {
        const data = await chrome.storage.local.get([UI_LOG_KEY]);
        return Array.isArray(data[UI_LOG_KEY]) ? data[UI_LOG_KEY] : [];
    } catch {
        return [];
    }
}
