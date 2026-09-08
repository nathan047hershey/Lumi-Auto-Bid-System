/**
 * Shared fill → submit gate for Lumi Auto Bidder.
 * Used by background queue + autofillEngine paths (Node-testable).
 */

/** Keep in sync with autofillEngine.BID_HARD_LIMIT_MS */
export const FILL_VERIFY_BASE_LIMIT_MS = 90000;

/** Normalize fillStats from bidderFill / fill.js / engine collect into one shape. */
export function normalizeFillStats(raw = {}) {
    const requiredTotal = Number.isFinite(Number(raw.requiredTotal))
        ? Math.max(0, Number(raw.requiredTotal))
        : (Array.isArray(raw.missingRequired) && raw.requiredComplete === false
            ? Math.max(1, (raw.missingRequired || []).length)
            : 0);
    const requiredOk = Number.isFinite(Number(raw.requiredOk))
        ? Math.max(0, Number(raw.requiredOk))
        : (raw.requiredComplete === true
            ? requiredTotal
            : Math.max(0, requiredTotal - (Array.isArray(raw.missingRequired) ? raw.missingRequired.length : 0)));
    const missingRequired = stableMissingLabels(raw.missingRequired || raw.missing || []);
    let requiredComplete;
    if (typeof raw.requiredComplete === 'boolean') {
        requiredComplete = raw.requiredComplete;
    } else if (requiredTotal > 0) {
        requiredComplete = requiredOk >= requiredTotal && missingRequired.length === 0;
    } else {
        // No required fields detected — treat as complete only if something was filled.
        requiredComplete = Number(raw.filled || 0) > 0 || raw.incomplete === false;
    }
    // Explicit incomplete flag wins when required counts look complete but engine disagreed.
    if (raw.incomplete === true && requiredTotal > 0 && requiredOk < requiredTotal) {
        requiredComplete = false;
    }
    if (requiredTotal > 0 && requiredOk < requiredTotal) {
        requiredComplete = false;
    }
    return {
        ...raw,
        requiredComplete,
        requiredOk,
        requiredTotal,
        missingRequired,
        incomplete: !requiredComplete,
        filled: Number(raw.filled || 0) || 0,
        submitClicked: !!raw.submitClicked
    };
}

/** Stable, non-empty labels for Control / Bid Courses. */
export function stableMissingLabels(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach((item, i) => {
        let label = '';
        if (typeof item === 'string') label = item.trim();
        else if (item && typeof item === 'object') {
            label = String(item.label || item.name || item.id || item.kind || '').trim();
        }
        if (!label) label = `Required field ${i + 1}`;
        const key = label.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(label.slice(0, 120));
    });
    return out;
}

export function isFillIncomplete(stats) {
    const n = normalizeFillStats(stats || {});
    if (n.requiredComplete === false) return true;
    if (n.incomplete === true && n.requiredTotal > 0) return true;
    if (n.requiredTotal > 0 && n.requiredOk < n.requiredTotal) return true;
    return false;
}

/** Never auto-submit when required fields are incomplete. */
export function canAutoSubmit(stats, prefs = {}) {
    if (!prefs?.autoSubmit) return false;
    if (isFillIncomplete(stats)) return false;
    return true;
}

/**
 * Wall-clock budget: base 90s; bump when multi-page ATS or many pages expected.
 * Still hard-capped at 150s so one bid cannot stall the queue.
 */
export function bidLimitMsForAts(ats, { pageCount = 0 } = {}) {
    const id = String(ats || '').toLowerCase();
    let ms = FILL_VERIFY_BASE_LIMIT_MS;
    if (id === 'oracle' || id === 'workday') ms = 120000;
    else if (id === 'icims' || id === 'smartrecruiters') ms = 110000;
    else if (id === 'ashby' || id === 'lever') ms = 100000;
    if (Number(pageCount) > 2) ms = Math.min(150000, ms + 20000);
    if (Number(pageCount) > 4) ms = Math.min(150000, ms + 15000);
    return ms;
}

/** Longer SPA form waits for slow ATS. */
export function formWaitMsForAts(ats, baseMs = 12000) {
    const id = String(ats || '').toLowerCase();
    const base = Math.max(8000, Number(baseMs) || 12000);
    if (id === 'oracle' || id === 'workday') return Math.max(base, 18000);
    if (id === 'icims' || id === 'ashby' || id === 'lever') return Math.max(base, 15000);
    return base;
}

/** Poll budget after Submit click before declaring needs_manual. */
export const SUBMIT_SUCCESS_POLL_MS = 12000;
export const SUBMIT_SUCCESS_POLL_GAP_MS = 800;

export function submitSuccessPollPlan({
    totalMs = SUBMIT_SUCCESS_POLL_MS,
    gapMs = SUBMIT_SUCCESS_POLL_GAP_MS
} = {}) {
    const total = Math.max(2500, Number(totalMs) || SUBMIT_SUCCESS_POLL_MS);
    const gap = Math.max(400, Number(gapMs) || SUBMIT_SUCCESS_POLL_GAP_MS);
    const attempts = Math.max(2, Math.ceil(total / gap));
    return { totalMs: total, gapMs: gap, attempts };
}
