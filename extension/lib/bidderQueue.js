/**
 * Auto Bidder queue orchestration (independent of Autofill hotkeys).
 * Uses Autofill fill helpers via background runFillOnly.
 */
import {
    getSettings,
    saveSettings,
    listBidderReady,
    getBidderApplication,
    markApplicationApplied,
    logBidCourseFill,
    waitOutlookOtp
} from './api.js';
import {
    classifyCaptchaOrLogin,
    detectCaptchaVendor,
    captchaStrategyForVendor,
    vendorLabel,
    CAPTCHA_EXTENSION_CATALOG,
    recommendHelpersForVendor,
    isBlockingCaptchaWall,
    probeCaptchaHelpers
} from './captchaPass.js';
import { assistCaptchaHelpers as assistCaptchaHelpersImpl } from './captchaAssist.js';

export {
    classifyCaptchaOrLogin,
    detectCaptchaVendor,
    captchaStrategyForVendor,
    vendorLabel,
    CAPTCHA_EXTENSION_CATALOG,
    recommendHelpersForVendor,
    isBlockingCaptchaWall,
    probeCaptchaHelpers
};

async function bidderRequest(path, opts) {
    const settings = await getSettings();
    const base = settings.apiBaseUrl;
    const headers = { 'Content-Type': 'application/json' };
    if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
    const res = await fetch(`${base}${path}`, {
        method: opts?.method || 'GET',
        headers,
        body: opts?.body != null ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) {
        const err = new Error(data?.error || `HTTP ${res.status}`);
        err.status = res.status;
        if (res.status === 401) err.authExpired = true;
        throw err;
    }
    return data;
}

export const BIDDER_DEFAULTS = {
    maxTabs: 3,
    openGapMs: 4000,
    /** Base form wait; ATS-specific bumps applied via formWaitMsForAts. */
    formWaitMs: 15000,
    autoSubmit: true,
    autoNext: false,
    soundEnabled: true,
    /** Pause opening more tabs until CAPTCHA/login is cleared (human handoff). */
    captchaFocus: true,
    captchaPollMs: 1500,
    captchaTimeoutMs: 60 * 60 * 1000,
    /**
     * Unattended / AFK mode: keep bidding without the user at the keyboard.
     * With captchaHelper ON, holds the apply tab focused for NopeCHA/CapSolver
     * so CAPTCHA can clear AFK. Without helper, short grace then park/skip.
     */
    unattended: false,
    /** Grace period before abandoning CAPTCHA in unattended mode (ms). 0 = skip immediately. */
    captchaGraceMs: 45 * 1000,
    /**
     * Wait for a CAPTCHA helper extension (NopeCHA / Buster).
     * Default ON — free path when CapSolver/2Captcha keys are empty.
     */
    captchaHelper: true,
    /** Extra wait when captchaHelper is on (ms). Default 90s — enough for NopeCHA, not a 5m stall. */
    captchaHelperWaitMs: 90 * 1000,
    /** CapSolver API key — built-in token solve (preferred when set). */
    capsolverApiKey: '',
    /** 2Captcha API key — fallback token solve. */
    twocaptchaApiKey: '',
    /** Built-in solver poll budget (ms). */
    captchaSolverTimeoutMs: 180000,
    /** Keep Job Links tab focused; apply pages open in background tabs. */
    stayInApp: true,
    /** Optional cover letter upload — OFF by default (required CL slots still upload). */
    uploadCoverLetter: false,
    /** Seconds to wait after fill before after_fill screenshot (form paint). */
    screenshotSettleSec: 2
};

const QUEUE_LOCK_KEY = 'bidderQueueLock';
const QUEUE_STATE_KEY = 'bidderQueueState';

export async function getBidderPrefs() {
    const data = await chrome.storage.local.get([
        'bidderAutoSubmit',
        'bidderAutoNext',
        'bidderSoundEnabled',
        'bidderCaptchaFocus',
        'bidderUnattended',
        'bidderCaptchaGraceSec',
        'bidderCaptchaHelper',
        'bidderCaptchaHelperWaitSec',
        'bidderCapsolverApiKey',
        'bidderTwocaptchaApiKey',
        'bidderCaptchaSolverTimeoutSec',
        'bidderUploadCoverLetter',
        'bidderStayInApp',
        'bidderScreenshotSettleSec',
        'bidderDisabledFillLessons'
        // Do NOT read Mode-1 `autoSubmit` — popup default historically false
        // and would override Auto Bidder's default-on submit behavior.
    ]);
    const graceSec = Number(data.bidderCaptchaGraceSec);
    const helperWaitSec = Number(data.bidderCaptchaHelperWaitSec);
    const solverTimeoutSec = Number(data.bidderCaptchaSolverTimeoutSec);
    // Explicit false stays off; unset / null → default ON (BIDDER_DEFAULTS).
    const autoSubmit = data.bidderAutoSubmit === false
        ? false
        : (data.bidderAutoSubmit === true ? true : BIDDER_DEFAULTS.autoSubmit);
    let disabledFillLessons = {};
    try {
        const raw = data.bidderDisabledFillLessons;
        if (raw && typeof raw === 'object') disabledFillLessons = raw;
        else if (typeof raw === 'string' && raw.trim()) disabledFillLessons = JSON.parse(raw);
    } catch (_) {
        disabledFillLessons = {};
    }
    return {
        autoSubmit,
        autoNext: !!data.bidderAutoNext,
        soundEnabled: data.bidderSoundEnabled != null ? !!data.bidderSoundEnabled : true,
        // Default ON: freeze queue on CAPTCHA until you solve it (or click Resume).
        captchaFocus: data.bidderCaptchaFocus != null ? !!data.bidderCaptchaFocus : true,
        unattended: !!data.bidderUnattended,
        captchaGraceMs: Number.isFinite(graceSec) && graceSec >= 0
            ? Math.round(graceSec * 1000)
            : BIDDER_DEFAULTS.captchaGraceMs,
        captchaHelper: data.bidderCaptchaHelper != null
            ? !!data.bidderCaptchaHelper
            : BIDDER_DEFAULTS.captchaHelper,
        captchaHelperWaitMs: Number.isFinite(helperWaitSec) && helperWaitSec >= 0
            ? Math.round(helperWaitSec * 1000)
            : BIDDER_DEFAULTS.captchaHelperWaitMs,
        capsolverApiKey: String(data.bidderCapsolverApiKey || '').trim(),
        twocaptchaApiKey: String(data.bidderTwocaptchaApiKey || '').trim(),
        captchaSolverTimeoutMs: Number.isFinite(solverTimeoutSec) && solverTimeoutSec > 0
            ? Math.round(solverTimeoutSec * 1000)
            : BIDDER_DEFAULTS.captchaSolverTimeoutMs,
        stayInApp: data.bidderStayInApp != null ? !!data.bidderStayInApp : true,
        uploadCoverLetter: !!data.bidderUploadCoverLetter,
        disabledFillLessons,
        screenshotSettleSec: Number(data.bidderScreenshotSettleSec) > 0
            ? Number(data.bidderScreenshotSettleSec)
            : BIDDER_DEFAULTS.screenshotSettleSec
    };
}

export async function saveBidderPrefs(patch) {
    await chrome.storage.local.set(patch);
}

/** Events that should not trigger a Live screenshot / status bump. */
const LIVE_STATUS_NOISE_RE = /^(screenshot|screenshot_failed|live|queue_enqueued|qa_admin_access_check)$/i;

let liveStatusShotTimer = null;
let liveStatusShotDeadline = 0;
let liveStatusShotPending = null;

function isLiveStatusEvent(eventType) {
    const t = String(eventType || '');
    return !!t && !LIVE_STATUS_NOISE_RE.test(t);
}

/**
 * Capture Live frame soon after a status change (≤500ms from first request in a burst).
 * Coalesces rapid events so we do not spam uploads.
 */
function scheduleLiveShotOnStatus(applicationId, opts = {}) {
    if (!applicationId) return;
    const now = Date.now();
    liveStatusShotPending = {
        applicationId,
        tabId: Number(opts.tabId) || null,
        eventType: opts.eventType || null
    };
    if (!liveStatusShotDeadline) liveStatusShotDeadline = now + 450;
    const remaining = Math.max(0, liveStatusShotDeadline - now);
    // First tick ~50ms (paint), coalesced bursts still fire before the 450ms deadline.
    const delay = liveStatusShotTimer
        ? Math.min(120, remaining)
        : Math.min(50, remaining);
    if (liveStatusShotTimer) clearTimeout(liveStatusShotTimer);
    liveStatusShotTimer = setTimeout(() => {
        liveStatusShotTimer = null;
        liveStatusShotDeadline = 0;
        const pending = liveStatusShotPending;
        liveStatusShotPending = null;
        if (!pending?.applicationId) return;
        void (async () => {
            try {
                const st = await getQueueState();
                const appId = pending.applicationId;
                const mapped = Number(st?.tabsByAppId?.[String(appId)] || 0) || 0;
                const sameJob = String(st?.currentId || '') === String(appId)
                    || String(st?.captchaApplicationId || '') === String(appId);
                const tid = Number(pending.tabId)
                    || mapped
                    || (sameJob ? (Number(st?.currentTabId || st?.captchaTabId || 0) || 0) : 0);
                if (!tid) return;
                const ok = await uploadScreenshot(appId, 'live', tid, {
                    settleMs: 0,
                    stayInApp: true
                });
                if (ok) {
                    const cur = (await chrome.storage.local.get([QUEUE_STATE_KEY]))[QUEUE_STATE_KEY] || {};
                    await chrome.storage.local.set({
                        [QUEUE_STATE_KEY]: {
                            ...cur,
                            liveShotAt: Date.now(),
                            updatedAt: Date.now()
                        }
                    });
                }
            } catch (_) { /* ignore */ }
        })();
    }, delay);
}

async function setQueueState(patch) {
    const cur = (await chrome.storage.local.get([QUEUE_STATE_KEY]))[QUEUE_STATE_KEY] || {};
    const statusChanged = patch?.status != null
        && String(patch.status) !== String(cur.status || '');
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    // Remember which Chrome tab belongs to which application (Open tab must not jump jobs).
    const tabId = Number(patch?.currentTabId || patch?.captchaTabId || 0) || 0;
    const appId = Number(patch?.currentId || patch?.captchaApplicationId || cur.currentId || 0) || 0;
    if (tabId && appId) {
        next.tabsByAppId = {
            ...(cur.tabsByAppId || {}),
            ...(patch.tabsByAppId || {}),
            [String(appId)]: tabId
        };
    } else if (patch?.tabsByAppId && typeof patch.tabsByAppId === 'object') {
        next.tabsByAppId = { ...(cur.tabsByAppId || {}), ...patch.tabsByAppId };
    }
    await chrome.storage.local.set({ [QUEUE_STATE_KEY]: next });
    if (statusChanged && appId) {
        scheduleLiveShotOnStatus(appId, { eventType: `queue_${patch.status}`, tabId: tabId || undefined });
    }
}

export async function getQueueState() {
    return (await chrome.storage.local.get([QUEUE_STATE_KEY]))[QUEUE_STATE_KEY] || null;
}

/** Explicit per-application run phase for Control / resume after SW kill. */
export const APP_RUN_STATES = Object.freeze([
    'opening',
    'gating',
    'captcha',
    'filling',
    'verifying',
    'submitting',
    'success',
    'incomplete',
    'failed',
    'paused_captcha'
]);

/**
 * Persist runState for one application (+ optional tab/url/missingRequired).
 * Also mirrors onto top-level queue fields for the active job.
 */
export async function setAppRunState(applicationId, status, extra = {}) {
    const appId = Number(applicationId) || 0;
    if (!appId || !status) return getQueueState();
    const phase = String(status);
    const cur = (await chrome.storage.local.get([QUEUE_STATE_KEY]))[QUEUE_STATE_KEY] || {};
    const prevRow = (cur.runByAppId && cur.runByAppId[String(appId)]) || {};
    const row = {
        ...prevRow,
        status: phase,
        at: Date.now(),
        tabId: extra.tabId != null ? Number(extra.tabId) || prevRow.tabId || null : (prevRow.tabId || null),
        url: extra.url != null ? String(extra.url || '') : (prevRow.url || null),
        missingRequired: Array.isArray(extra.missingRequired)
            ? extra.missingRequired.slice(0, 8)
            : (prevRow.missingRequired || undefined),
        captcha: extra.captcha != null ? !!extra.captcha : prevRow.captcha,
        requiredOk: extra.requiredOk != null ? extra.requiredOk : prevRow.requiredOk,
        requiredTotal: extra.requiredTotal != null ? extra.requiredTotal : prevRow.requiredTotal
    };
    const patch = {
        runState: phase,
        runByAppId: {
            ...(cur.runByAppId || {}),
            [String(appId)]: row
        },
        currentId: appId,
        lastStatusEvent: extra.eventType || `run_${phase}`,
        lastStatusAt: Date.now(),
        lastStatusMeta: {
            runState: phase,
            missingRequired: row.missingRequired,
            requiredOk: row.requiredOk,
            requiredTotal: row.requiredTotal,
            captcha: row.captcha
        }
    };
    if (row.tabId) {
        patch.currentTabId = row.tabId;
        patch.tabsByAppId = { ...(cur.tabsByAppId || {}), [String(appId)]: row.tabId };
    }
    if (row.url) patch.currentJobUrl = row.url;
    if (phase === 'paused_captcha' || phase === 'captcha') {
        patch.status = 'awaiting_captcha';
        patch.captchaTabId = row.tabId || cur.captchaTabId || null;
        patch.captchaApplicationId = appId;
    }
    await setQueueState(patch);
    return getQueueState();
}

async function acquireQueueLock() {
    const data = await chrome.storage.local.get([QUEUE_LOCK_KEY, QUEUE_STATE_KEY]);
    const lock = data[QUEUE_LOCK_KEY];
    const st = data[QUEUE_STATE_KEY];
    const lockFresh = !!(lock?.at && Date.now() - lock.at < 30 * 60 * 1000);
    if (lockFresh) {
        const status = String(st?.status || '');
        const activelyRunning = !!(
            st?.running
            || /^(?:running|awaiting_captcha|awaiting_next)$/i.test(status)
        );
        // Hold the lock only when a real queue is in progress. After an MV3
        // service-worker kill, running=false with a leftover lock used to
        // block Process for up to 30 minutes — steal that stale lock.
        if (activelyRunning) return false;
    }
    await chrome.storage.local.set({ [QUEUE_LOCK_KEY]: { at: Date.now() } });
    return true;
}

async function releaseQueueLock() {
    await chrome.storage.local.remove([QUEUE_LOCK_KEY]);
}

export async function logCourseEvent(applicationId, eventType, meta = {}) {
    try {
        const body = {
            application_id: applicationId,
            event_type: eventType,
            meta
        };
        // Promote common fields so server can set company_name / job_url without Unknown clobber.
        if (meta?.company || meta?.company_name) {
            body.company_name = meta.company_name || meta.company;
        }
        if (meta?.url || meta?.job_url) {
            body.job_url = meta.job_url || meta.url;
        }
        if (meta?.job_role || meta?.role) {
            body.job_role = meta.job_role || meta.role;
        }
        await bidderRequest('/user/bid-courses/event', {
            method: 'POST',
            body
        });
        // Status events → Live frame within ~0.5s (no 3s polling).
        if (applicationId && isLiveStatusEvent(eventType)) {
            const slimMeta = meta && typeof meta === 'object'
                ? {
                    count: meta.count,
                    questions: meta.questions,
                    filled: meta.filled,
                    fresh: meta.fresh,
                    requiredOk: meta.requiredOk,
                    requiredTotal: meta.requiredTotal,
                    missing: Array.isArray(meta.missing)
                        ? meta.missing.filter(Boolean).slice(0, 5)
                        : (Array.isArray(meta.missingRequired)
                            ? meta.missingRequired.filter(Boolean).slice(0, 5)
                            : undefined),
                    error: meta.error ? String(meta.error).slice(0, 200) : undefined,
                    reason: meta.reason ? String(meta.reason).slice(0, 120) : undefined,
                    limitMs: meta.limitMs,
                    remainingMs: meta.remainingMs,
                    willRetry: typeof meta.willRetry === 'boolean' ? meta.willRetry : undefined
                }
                : null;
            try {
                const cur = (await chrome.storage.local.get([QUEUE_STATE_KEY]))[QUEUE_STATE_KEY] || {};
                await chrome.storage.local.set({
                    [QUEUE_STATE_KEY]: {
                        ...cur,
                        lastStatusEvent: String(eventType),
                        lastStatusAt: Date.now(),
                        lastStatusMeta: slimMeta,
                        updatedAt: Date.now()
                    }
                });
            } catch (_) { /* ignore */ }
            scheduleLiveShotOnStatus(applicationId, { eventType });
        }
    } catch (err) {
        console.warn('[bidder] event log failed', err);
        if (err.authExpired) throw err;
    }
}

const pageDebuggerTabs = new Set();

function isJobApplyAppUrl(u) {
    return /localhost:5173|127\.0\.0\.1:5173|localhost:3000|127\.0\.0\.1:3000/i.test(u || '');
}

export async function attachPageDebugger(tabId) {
    if (!tabId) return false;
    try {
        await chrome.debugger.attach({ tabId }, '1.3');
        pageDebuggerTabs.add(tabId);
        return true;
    } catch (err) {
        if (/already attached/i.test(String(err?.message || err))) {
            pageDebuggerTabs.add(tabId);
            return true;
        }
        console.warn('[bidder] debugger attach', err);
        return false;
    }
}

export async function releasePageDebugger(tabId) {
    if (!tabId) return;
    try {
        await chrome.debugger.detach({ tabId });
    } catch (_) { /* ignore */ }
    pageDebuggerTabs.delete(tabId);
}

export async function releaseAllPageDebuggers() {
    const ids = [...pageDebuggerTabs];
    pageDebuggerTabs.clear();
    await Promise.all(ids.map((id) => chrome.debugger.detach({ tabId: id }).catch(() => {})));
}

async function captureTabScreenshot(tabId, opts = {}) {
    const stayInApp = opts.stayInApp !== false;
    let tab;
    try {
        tab = await chrome.tabs.get(tabId);
    } catch (err) {
        throw new Error(`tab gone: ${err?.message || err}`);
    }
    const url = String(tab.pendingUrl || tab.url || '');
    if (url && /^(chrome|chrome-extension|edge|about|devtools|chrome-error):/i.test(url)) {
        throw new Error(`cannot capture restricted url: ${url.slice(0, 120)}`);
    }
    if (/chromewebdata|chrome-error/i.test(url)) {
        throw new Error('cannot capture Chrome error page (site failed to load)');
    }

    const holdCaptchaFocus = async () => {
        try {
            const { captchaUserFocusHoldUntil } = await chrome.storage.session.get('captchaUserFocusHoldUntil');
            return Date.now() < Number(captchaUserFocusHoldUntil || 0);
        } catch {
            return false;
        }
    };

    // Never yank the Job Apply SPA back to Job Links — that made typing/nav unusable.
    const restoreFocusAfterCapture = async (prevWindowId) => {
        if (await holdCaptchaFocus()) return;
        let bgId = null;
        try {
            bgId = (await chrome.storage.session.get(['bidderBgWindowId']))?.bidderBgWindowId || null;
        } catch (_) { /* ignore */ }

        try {
            const focusedWin = prevWindowId != null
                ? await chrome.windows.get(prevWindowId).catch(() => null)
                : await chrome.windows.getLastFocused().catch(() => null);
            const winId = focusedWin?.id;
            if (winId != null) {
                const [active] = await chrome.tabs.query({ active: true, windowId: winId });
                if (isJobApplyAppUrl(active?.url) && !/job-links/i.test(active.url || '')) {
                    return;
                }
            }
        } catch (_) { /* ignore */ }

        const wasOnApplyOrBg = prevWindowId != null && (
            prevWindowId === tab.windowId
            || (bgId != null && prevWindowId === bgId)
        );

        if (prevWindowId != null && !wasOnApplyOrBg) {
            try {
                await chrome.windows.update(prevWindowId, { focused: true });
            } catch (_) { /* ignore */ }
        }
    };

    if (stayInApp) {
        await attachPageDebugger(tabId);
        try {
            const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
                format: 'png',
                fromSurface: true
            });
            return `data:image/png;base64,${result.data}`;
        } catch (err) {
            const msg = String(err?.message || err || '');
            if (/showing error page|chrome-error/i.test(msg)) {
                throw new Error('cannot capture Chrome error page (site failed to load)');
            }
            throw err;
        }
    }

    const prevTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const prev = prevTabs[0];
    const settleMs = Math.max(0, Number(opts.settleMs) || 800);

    try {
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    } catch (_) { /* best-effort focus */ }
    await new Promise((r) => setTimeout(r, settleMs));

    const windowId = tab.windowId != null ? tab.windowId : null;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
        throw new Error('captureVisibleTab returned empty image');
    }

    if (opts.restoreFocus !== false && prev?.id && prev.id !== tabId) {
        try {
            await chrome.tabs.update(prev.id, { active: true });
            if (prev.windowId != null) {
                await chrome.windows.update(prev.windowId, { focused: true });
            }
        } catch (_) { /* ignore */ }
    }
    return dataUrl;
}

/**
 * Greenhouse phone dial Country* needs a *trusted* click+type+Enter.
 * Synthetic content-script events often leave the control empty while Phone fills.
 * Uses the same chrome.debugger permission already required for stay-in-app screenshots.
 */
export async function ensureUsDialCodeTrusted(tabId) {
    if (!tabId) return false;
    const target = { tabId };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const evaluate = async (expression) => {
        const res = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: false
        });
        if (res?.exceptionDetails) {
            throw new Error(res.exceptionDetails.text || 'evaluate failed');
        }
        return res?.result?.value;
    };

    try {
        await attachPageDebugger(tabId);

        const already = await evaluate(`(() => {
            const shell = document.querySelector('.phone-input__country .select-shell')
                || document.getElementById('country')?.closest('.select-shell');
            if (!shell) return !document.getElementById('country');
            const sv = (shell.querySelector('.select__single-value')?.textContent || '').replace(/\\s+/g, ' ').trim();
            return /\\+1\\b/.test(sv) || /^united states/i.test(sv)
                || !!(shell.querySelector('.select__value-container--has-value') && sv);
        })()`);
        if (already) return true;

        const box = await evaluate(`(() => {
            const el = document.querySelector('.phone-input__country .select__control')
                || document.querySelector('label[for="country"]')
                || document.getElementById('country');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 18) };
        })()`);
        if (!box || box.x == null) return false;

        const clickAt = async (x, y) => {
            await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
                type: 'mousePressed', x, y, button: 'left', clickCount: 1
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased', x, y, button: 'left', clickCount: 1
            });
        };

        await clickAt(box.x, box.y);
        await sleep(180);

        // Focus filter input explicitly
        await evaluate(`(() => { document.getElementById('country')?.focus?.(); return true; })()`);
        await sleep(60);

        // Select-all then type United States
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA',
            windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
        });
        await sleep(40);
        await chrome.debugger.sendCommand(target, 'Input.insertText', { text: 'United States' });
        await sleep(350);

        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
        await sleep(280);

        let ok = await evaluate(`(() => {
            const shell = document.querySelector('.phone-input__country .select-shell')
                || document.getElementById('country')?.closest('.select-shell');
            const sv = (shell?.querySelector('.select__single-value')?.textContent || '').replace(/\\s+/g, ' ').trim();
            return /\\+1\\b/.test(sv) || /^united states/i.test(sv)
                || !!(shell?.querySelector('.select__value-container--has-value') && sv);
        })()`);

        // Retry: ArrowDown + Enter after re-type
        if (!ok) {
            await clickAt(box.x, box.y);
            await sleep(150);
            await evaluate(`(() => { document.getElementById('country')?.focus?.(); return true; })()`);
            await chrome.debugger.sendCommand(target, 'Input.insertText', { text: 'United States' });
            await sleep(300);
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown',
                windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown',
                windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40
            });
            await sleep(80);
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'keyDown', key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
            });
            await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
            });
            await sleep(280);
            ok = await evaluate(`(() => {
                const shell = document.querySelector('.phone-input__country .select-shell')
                    || document.getElementById('country')?.closest('.select-shell');
                const sv = (shell?.querySelector('.select__single-value')?.textContent || '').replace(/\\s+/g, ' ').trim();
                return /\\+1\\b/.test(sv) || /^united states/i.test(sv)
                    || !!(shell?.querySelector('.select__value-container--has-value') && sv);
            })()`);
        }

        // Last resort: trusted click on the United States option
        if (!ok) {
            const optBox = await evaluate(`(() => {
                const opt = [...document.querySelectorAll('[role="option"], .select__option')]
                    .find((n) => /united states/i.test(n.textContent || '') && /\\+1/.test(n.textContent || ''));
                if (!opt) return null;
                try { opt.scrollIntoView({ block: 'nearest' }); } catch (_) {}
                const r = opt.getBoundingClientRect();
                if (!r.width || !r.height) return null;
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            })()`);
            if (optBox) {
                await clickAt(optBox.x, optBox.y);
                await sleep(250);
                ok = await evaluate(`(() => {
                    const shell = document.querySelector('.phone-input__country .select-shell')
                        || document.getElementById('country')?.closest('.select-shell');
                    const sv = (shell?.querySelector('.select__single-value')?.textContent || '').replace(/\\s+/g, ' ').trim();
                    return /\\+1\\b/.test(sv) || /^united states/i.test(sv)
                        || !!(shell?.querySelector('.select__value-container--has-value') && sv);
                })()`);
            }
        }

        return !!ok;
    } catch (err) {
        console.warn('[bidder] ensureUsDialCodeTrusted', err);
        return false;
    }
}

export async function uploadScreenshot(applicationId, stage, tabId, opts = {}) {
    try {
        let tid = Number(tabId) || 0;
        // Live frames must track THIS application’s tab — not a later queue job’s tab.
        if (String(stage) === 'live' && applicationId) {
            try {
                const st = await getQueueState();
                const appId = String(applicationId);
                const mapped = Number(st?.tabsByAppId?.[appId] || 0) || 0;
                const sameJob = String(st?.currentId || '') === appId
                    || String(st?.captchaApplicationId || '') === appId;
                const preferred = mapped
                    || (sameJob ? (Number(st?.currentTabId || st?.captchaTabId || 0) || 0) : 0)
                    || tid;
                if (preferred) {
                    try {
                        await chrome.tabs.get(preferred);
                        tid = preferred;
                    } catch (_) { /* keep tid */ }
                }
            } catch (_) { /* keep tid */ }
        }
        if (!tid) {
            throw new Error('tabId required for screenshot');
        }
        const dataUrl = await captureTabScreenshot(tid, opts);
        await bidderRequest('/user/bid-courses/screenshot', {
            method: 'POST',
            body: { application_id: applicationId, stage, image_base64: dataUrl }
        });
        return true;
    } catch (err) {
        console.warn('[bidder] screenshot failed', err);
        if (String(stage) !== 'live') {
            await logCourseEvent(applicationId, 'screenshot_failed', {
                stage,
                error: err?.message || String(err),
                tabId
            });
        }
        return false;
    }
}

export async function savePackage(applicationId, answers, meta) {
    try {
        return await bidderRequest('/user/bid-courses/package', {
            method: 'POST',
            body: { application_id: applicationId, answers, meta }
        });
    } catch (err) {
        console.warn('[bidder] package save failed', err);
        return null;
    }
}

/**
 * Thank-you / submitted confirmation only.
 * NEVER match bare "success" / "customer success" / "enterprise success".
 */
const SUCCESS_RE = /\b(?:thank\s*you\s+for\s+(?:your\s+)?(?:application|applying|submitting)|thanks\s+for\s+(?:your\s+)?(?:application|applying|submitting)|application\s+(?:has\s+been\s+)?(?:received|submitted|complete(?:d)?)|your\s+application\s+(?:has\s+been\s+)?(?:submitted|received|sent|complete(?:d)?)|we\s*(?:['’]?ve|have)\s+received\s+(?:your\s+)?application|successfully\s+submitted(?:\s+your\s+application)?|application\s+submitted\s+successfully|submission\s+(?:was\s+)?successful|confirmation\s+of\s+your\s+application)\b/i;

/** Short confirmation headings only — never bare "Success" (too many false positives). */
const SUCCESS_HEADING_RE = /^(?:application\s+)?(?:submitted|received|complete(?:d)?)!?$|^(?:thank\s*you|thanks)(?:\s+for\s+(?:applying|your\s+application))?[!.,]?$/i;

/**
 * Hard NO — validation / open-form copy must never count as submit SUCCESS.
 * Catches Ashby "Missing entry for required field: … enterprise success …".
 */
const SUCCESS_NEGATIVE_RE = /\b(?:missing\s+entry\s+for\s+required\s+field|please\s+(?:complete|fill|answer)\s+(?:all\s+)?required|required\s+field(?:s)?\s+(?:are\s+)?missing|field\s+is\s+required|this\s+field\s+is\s+required|form\s+contain(?:s)?\s+errors?|fix\s+out\s+this\s+field|you\s+must\s+(?:select|answer|complete))\b/i;

/**
 * Pure success classifier (unit-tested). Rejects open apply forms even if
 * the word "success" appears in a question label or validation error.
 */
function evaluateSubmitSuccessPage({
    text = '',
    headings = [],
    radioCount = 0,
    visibleFieldCount = 0,
    hasSubmitControl = false,
    emptyVisibleFields = 0,
    hasValidationErrors = false
} = {}) {
    const body = String(text || '');
    if (hasValidationErrors || SUCCESS_NEGATIVE_RE.test(body)) {
        return { ok: false, reason: 'validation_errors' };
    }
    const headingHit = (Array.isArray(headings) ? headings : [])
        .some((h) => SUCCESS_HEADING_RE.test(String(h || '').replace(/\s+/g, ' ').trim()));
    const bodyHit = SUCCESS_RE.test(body);
    if (!bodyHit && !headingHit) return { ok: false, reason: 'no_match' };

    // Active multi-field apply form → never SUCCESS (even if a phrase matched).
    const formOpen = (radioCount >= 2 || visibleFieldCount >= 2) && hasSubmitControl;
    if (formOpen) {
        return { ok: false, reason: 'form_still_open' };
    }
    // Extra guard: unanswered radios alone mean not submitted.
    if (radioCount >= 2 && emptyVisibleFields >= 0 && hasSubmitControl) {
        return { ok: false, reason: 'form_still_open' };
    }
    return { ok: true, reason: bodyHit ? 'body' : 'heading' };
}

function collectSubmitSuccessSignalsInPage(successReSource, headingReSource, negativeReSource) {
    const successRe = new RegExp(successReSource, 'i');
    const headingRe = new RegExp(headingReSource, 'i');
    const negativeRe = new RegExp(negativeReSource, 'i');
    const text = (document.body?.innerText || '').slice(0, 16000);
    if (negativeRe.test(text)) {
        return {
            ok: false,
            reason: 'validation_errors',
            sample: text.slice(0, 200)
        };
    }
    const headings = [...document.querySelectorAll('h1, h2, h3, [role="heading"], [role="alert"], [role="status"]')]
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length >= 2 && t.length <= 120)
        .slice(0, 20);
    const isVisible = (el) => {
        try {
            if (!el || el.disabled) return false;
            const st = window.getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        } catch (_) {
            return false;
        }
    };
    // Ashby / modern ATS often use role=radio instead of input[type=radio].
    const radios = [...document.querySelectorAll(
        'input[type="radio"], [role="radio"], [aria-checked][role="radio"], button[aria-checked]'
    )].filter(isVisible);
    const fields = [...document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea, select'
    )].filter(isVisible);
    const emptyVisibleFields = fields.filter((el) => !String(el.value || '').trim()).length;
    const hasSubmitControl = !![...document.querySelectorAll(
        'button[type="submit"], input[type="submit"], button, a[role="button"], [data-qa*="submit" i], [data-testid*="submit" i]'
    )].find((el) => {
        if (!isVisible(el)) return false;
        const t = `${el.innerText || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
        return /submit|apply|send application|finish application/.test(t) || el.type === 'submit';
    });
    const headingHit = headings.some((h) => headingRe.test(h));
    const bodyHit = successRe.test(text);
    if (!bodyHit && !headingHit) {
        return { ok: false, reason: 'no_match', sample: text.slice(0, 160) };
    }
    const formOpen = (radios.length >= 2 || fields.length >= 2) && hasSubmitControl;
    if (formOpen || (radios.length >= 2 && hasSubmitControl)) {
        return {
            ok: false,
            reason: 'form_still_open',
            sample: text.slice(0, 160),
            radioCount: radios.length,
            visibleFieldCount: fields.length,
            emptyVisibleFields
        };
    }
    return {
        ok: true,
        reason: bodyHit ? 'body' : 'heading',
        sample: text.slice(0, 160),
        radioCount: radios.length,
        visibleFieldCount: fields.length
    };
}

/**
 * Scroll the site success / thank-you message into view so the proof
 * screenshot shows the confirmation banner (not a blank mid-page).
 */
export async function scrollSuccessMessageIntoView(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (reSource, headingReSource, negativeReSource) => {
                const re = new RegExp(reSource, 'i');
                const headingRe = new RegExp(headingReSource, 'i');
                const negativeRe = negativeReSource ? new RegExp(negativeReSource, 'i') : null;
                // Clear prior false outlines (e.g. "customer success" question).
                try {
                    document.querySelectorAll('[data-lumi-success-proof]').forEach((el) => {
                        el.removeAttribute('data-lumi-success-proof');
                        el.style.outline = '';
                        el.style.outlineOffset = '';
                    });
                } catch (_) { /* ignore */ }
                const pageText = (document.body?.innerText || '').slice(0, 16000);
                if (negativeRe && negativeRe.test(pageText)) {
                    return { found: false, sample: pageText.slice(0, 160), reason: 'validation_errors' };
                }
                const candidates = [];
                // Do NOT include bare `.success` — Ashby/form CSS classes false-match.
                const nodes = document.querySelectorAll(
                    'h1, h2, h3, [role="alert"], [role="status"], .alert, .banner, .confirmation, p, div, section'
                );
                for (const el of nodes) {
                    if (!el || el.closest('script, style, noscript')) continue;
                    // Never outline an open question / radio group.
                    try {
                        if (el.querySelector?.(
                            'input[type="radio"], input[type="checkbox"], textarea, select, input[type="text"], [role="radio"]'
                        )) {
                            continue;
                        }
                    } catch (_) { /* ignore */ }
                    const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (t.length < 4 || t.length > 280) continue;
                    if (negativeRe && negativeRe.test(t)) continue;
                    if (
                        /\?\s*$/.test(t)
                        || /(?:customer|enterprise)\s+success|\byears\s+have\s+you\b|\bhow\s+many\s+years\b|missing\s+entry/i.test(t)
                    ) {
                        continue;
                    }
                    // Never outline solely because the word "success" appears.
                    if (/\bsuccess\b/i.test(t) && !re.test(t)) continue;
                    const isHeading = /^H[1-3]$/i.test(el.tagName) || /alert|status|heading/i.test(el.getAttribute('role') || '');
                    if (!(re.test(t) || (isHeading && headingRe.test(t)))) continue;
                    const tag = `${el.tagName} ${el.className || ''} ${el.getAttribute('role') || ''}`.toLowerCase();
                    let score = 1;
                    if (/h[1-3]/.test(el.tagName.toLowerCase())) score += 3;
                    if (/alert|status|confirm|banner|thank/.test(tag)) score += 4;
                    if (t.length < 180) score += 1;
                    if (re.test(t)) score += 5;
                    candidates.push({ el, score, sample: t.slice(0, 180) });
                }
                candidates.sort((a, b) => b.score - a.score);
                const best = candidates[0];
                if (best?.el) {
                    try {
                        best.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                    } catch (_) {
                        try { best.el.scrollIntoView(true); } catch (_) { /* ignore */ }
                    }
                    try {
                        best.el.setAttribute('data-lumi-success-proof', '1');
                        best.el.style.outline = '3px solid #22c55e';
                        best.el.style.outlineOffset = '4px';
                    } catch (_) { /* ignore */ }
                    return { found: true, sample: best.sample };
                }
                try { window.scrollTo(0, 0); } catch (_) { /* ignore */ }
                return { found: false, sample: (document.body?.innerText || '').slice(0, 160) };
            },
            args: [SUCCESS_RE.source, SUCCESS_HEADING_RE.source, SUCCESS_NEGATIVE_RE.source]
        });
        return result || { found: false };
    } catch {
        return { found: false };
    }
}

export async function detectSubmitSuccess(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: collectSubmitSuccessSignalsInPage,
            args: [SUCCESS_RE.source, SUCCESS_HEADING_RE.source, SUCCESS_NEGATIVE_RE.source]
        });
        return !!result?.ok;
    } catch {
        return false;
    }
}

/**
 * Poll thank-you / SUCCESS after submit (redirects need more than a single 2.5s wait).
 * Returns { ok, reason, attempts, elapsedMs }.
 */
export async function pollDetectSubmitSuccess(tabId, {
    totalMs = 12000,
    gapMs = 800,
    onTick = null
} = {}) {
    const start = Date.now();
    const total = Math.max(2500, Number(totalMs) || 12000);
    const gap = Math.max(400, Number(gapMs) || 800);
    let attempts = 0;
    let last = { ok: false, reason: 'no_poll' };
    while (Date.now() - start < total) {
        attempts += 1;
        last = await detectSubmitSuccessDetail(tabId);
        if (typeof onTick === 'function') {
            try { onTick({ attempt: attempts, ...last }); } catch (_) { /* ignore */ }
        }
        if (last?.ok) {
            return { ok: true, reason: last.reason || 'ok', attempts, elapsedMs: Date.now() - start };
        }
        // Validation errors — stop early so caller can re-fill.
        if (last?.reason === 'validation_errors') {
            return {
                ok: false,
                reason: 'validation_errors',
                attempts,
                elapsedMs: Date.now() - start,
                sample: last.sample
            };
        }
        await new Promise((r) => setTimeout(r, gap));
    }
    return {
        ok: false,
        reason: last?.reason || 'timeout',
        attempts,
        elapsedMs: Date.now() - start,
        sample: last?.sample
    };
}

/** Full detect payload (reason) for Update state / revoke false SUCCESS. */
async function detectSubmitSuccessDetail(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: collectSubmitSuccessSignalsInPage,
            args: [SUCCESS_RE.source, SUCCESS_HEADING_RE.source, SUCCESS_NEGATIVE_RE.source]
        });
        return result || { ok: false, reason: 'no_result' };
    } catch (err) {
        return { ok: false, reason: err?.message || 'detect_failed' };
    }
}

/** Clear leftover green false-SUCCESS outlines on the apply tab. */
async function clearFalseSuccessOutlines(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                document.querySelectorAll('[data-lumi-success-proof]').forEach((el) => {
                    el.removeAttribute('data-lumi-success-proof');
                    el.style.outline = '';
                    el.style.outlineOffset = '';
                });
            }
        });
    } catch (_) { /* ignore */ }
}

/**
 * Capture the job-site success / thank-you message as the default proof shot
 * (`after_submit`). Scrolls the confirmation into view first.
 */
export async function uploadSuccessProofScreenshot(applicationId, tabId, opts = {}) {
    if (!applicationId || !tabId) return false;
    const waitMs = Math.max(800, Number(opts.waitMs) || 1500);
    await scrollSuccessMessageIntoView(tabId);
    await new Promise((r) => setTimeout(r, waitMs));
    // Second pass — SPA thank-you pages often paint late.
    await scrollSuccessMessageIntoView(tabId);
    await new Promise((r) => setTimeout(r, 400));
    return uploadScreenshot(applicationId, 'after_submit', tabId, {
        settleMs: opts.settleMs != null ? opts.settleMs : 900,
        stayInApp: opts.stayInApp !== false,
        restoreFocus: opts.restoreFocus
    });
}

/**
 * Pure CAPTCHA / login-wall heuristics (shared with unit tests via fixtures).
 */
/**
 * Pure CAPTCHA / login-wall heuristics — see captchaPass.js (re-exported above).
 */

export async function detectCaptchaOrLogin(tabId) {
    try {
        const frameResults = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                const text = (document.body?.innerText || '').toLowerCase().slice(0, 16000);
                const html = (document.body?.innerHTML || '').toLowerCase().slice(0, 40000);

                const widgetSel = [
                    'iframe[src*="recaptcha"]',
                    'iframe[src*="hcaptcha"]',
                    'iframe[src*="challenges.cloudflare"]',
                    'iframe[src*="turnstile"]',
                    'iframe[src*="arkoselabs"]',
                    'iframe[src*="funcaptcha"]',
                    'iframe[src*="datadome"]',
                    'iframe[src*="geetest"]',
                    'iframe[src*="mtcaptcha"]',
                    'iframe[src*="awswaf"]',
                    'iframe[src*="amazon.com/aaut"]',
                    'iframe[title*="captcha" i]',
                    'iframe[title*="challenge" i]',
                    '.g-recaptcha',
                    '#g-recaptcha',
                    '[data-sitekey]',
                    '.h-captcha',
                    '[class*="h-captcha"]',
                    '.cf-turnstile',
                    '[class*="cf-turnstile"]',
                    '#cf-challenge-running',
                    '#challenge-form',
                    '#challenge-running',
                    '.px-captcha',
                    '[id*="captcha" i]',
                    '[class*="captcha" i]',
                    '[data-callback*="captcha" i]',
                    'div[id*="arkose" i]',
                    'div[class*="arkose" i]',
                    '[class*="geetest"]',
                    '[id*="geetest"]',
                    '[class*="mtcaptcha"]',
                    '[class*="friendly-challenge"]',
                    '[class*="lemin"]',
                    '#amzn-captcha-verify-container',
                    '[id*="aws-waf"]'
                ].join(',');

                let widgetHit = false;
                try {
                    widgetHit = !!document.querySelector(widgetSel);
                } catch (_) {
                    widgetHit = false;
                }

                if (!widgetHit) {
                    try {
                        const walk = (root, depth = 0) => {
                            if (!root || depth > 4 || widgetHit) return;
                            const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
                            for (const el of nodes) {
                                if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
                                const id = `${el.id || ''} ${el.className || ''} ${el.tagName || ''}`.toLowerCase();
                                if (/turnstile|recaptcha|hcaptcha|captcha|challenge|arkose|funcaptcha|geetest|mtcaptcha|datadome|perimeterx|awswaf/.test(id)) {
                                    widgetHit = true;
                                    return;
                                }
                            }
                        };
                        walk(document.documentElement);
                    } catch (_) { /* ignore */ }
                }

                let widgetSolved = false;
                try {
                    const resp = [
                        ...document.querySelectorAll(
                            'textarea[name="g-recaptcha-response"], '
                            + 'textarea[id*="g-recaptcha-response"], '
                            + 'textarea[name="h-captcha-response"], '
                            + 'textarea[name="cf-turnstile-response"], '
                            + 'input[name="cf-turnstile-response"], '
                            + '[name="h-captcha-response"], '
                            + '[data-hcaptcha-response]'
                        )
                    ];
                    for (const el of resp) {
                        const v = String(el.value || el.getAttribute('data-hcaptcha-response') || '').trim();
                        if (v.length > 20) {
                            widgetSolved = true;
                            break;
                        }
                    }
                    if (!widgetSolved) {
                        if (document.querySelector(
                            '.recaptcha-checkbox-checked, '
                            + '[aria-checked="true"].recaptcha-checkbox, '
                            + '#recaptcha-anchor[aria-checked="true"]'
                        )) {
                            widgetSolved = true;
                        }
                    }
                } catch (_) { /* ignore */ }

                return {
                    text,
                    html,
                    widgetHit: !!widgetHit,
                    widgetSolved: !!widgetSolved,
                    isTop: window === window.top
                };
            }
        });

        let text = '';
        let html = '';
        let widgetHit = false;
        let widgetSolved = false;
        let iframeMiss = false;
        for (const entry of frameResults || []) {
            const r = entry?.result;
            if (!r) continue;
            if (r.isTop || (!text && r.text)) {
                text = r.text || text;
                html = r.html || html;
            }
            if (r.widgetHit) {
                if (!widgetHit && !r.isTop) iframeMiss = true;
                widgetHit = true;
            }
            if (r.widgetSolved) widgetSolved = true;
        }

        if (!text && !html && !widgetHit) {
            return { captcha: false, login: false, vendor: 'none' };
        }

        const classified = classifyCaptchaOrLogin({
            text,
            html,
            hasWidget: widgetHit,
            widgetSolved
        });
        if (iframeMiss && classified.captcha) {
            classified.iframeDetect = true;
        }
        return classified;
    } catch {
        return { captcha: false, login: false, vendor: 'none' };
    }
}

/**
 * Light assist for free Chrome helpers (NopeCHA / Buster) — see captchaAssist.js.
 */
export async function assistCaptchaHelpers(tabId, vendorHint = '') {
    return assistCaptchaHelpersImpl(tabId, vendorHint);
}

/** @deprecated use assistCaptchaHelpers — kept for callers */
export async function assistRecaptchaCheckbox(tabId) {
    return assistCaptchaHelpers(tabId, 'recaptcha');
}

/**
 * Block until CAPTCHA/login wall clears, user clicks Resume, Stop, or timeout.
 * Does not solve CAPTCHA — waits for the human or a helper extension.
 */
export async function waitForCaptchaOrLoginCleared(tabId, {
    applicationId = null,
    pollMs = BIDDER_DEFAULTS.captchaPollMs,
    timeoutMs = BIDDER_DEFAULTS.captchaTimeoutMs
} = {}) {
    const start = Date.now();
    let currentTabId = tabId;
    while (Date.now() - start < timeoutMs) {
        const st = await getQueueState();
        if (st?.stopRequested) {
            return { cleared: false, stopped: true };
        }
        if (st?.captchaAbandonRequested) {
            await setQueueState({ captchaAbandonRequested: false });
            return { cleared: false, abandoned: true, via: 'user_skip' };
        }
        if (st?.captchaResolved) {
            const force = !!st.captchaForceResume;
            await setQueueState({ captchaResolved: false, captchaForceResume: false });
            // Prefer the latest tab id (user may have reopened after close).
            if (st.captchaTabId) currentTabId = st.captchaTabId;
            const wall = await detectCaptchaOrLogin(currentTabId);
            if (force || (!wall.captcha && !wall.login)) {
                return { cleared: true, via: force ? 'manual_resume' : 'manual_resume_verified', ...wall };
            }
            // Still blocked — keep waiting unless they forced
        }

        // Follow tab id if Open apply tab reopened a closed page.
        if (st?.captchaTabId && st.captchaTabId !== currentTabId) {
            currentTabId = st.captchaTabId;
        }

        try {
            await chrome.tabs.get(currentTabId);
        } catch {
            // Tab gone — keep waiting for reopen (FOCUS_TAB) instead of dying immediately.
            await setQueueState({
                status: 'awaiting_captcha',
                captchaTabId: null,
                captchaApplicationId: applicationId,
                captchaKind: st?.captchaKind || 'captcha',
                captchaSince: st?.captchaSince || start,
                captchaTabMissing: true
            });
            await new Promise((r) => setTimeout(r, pollMs));
            continue;
        }

        const wall = await detectCaptchaOrLogin(currentTabId);
        if ((!wall.captcha && !wall.login) || wall.widgetSolved) {
            return { cleared: true, via: wall.widgetSolved ? 'widget_solved' : 'auto_detect', ...wall };
        }

        // Apply form appeared while a passive widget is still on the page (Greenhouse
        // reCAPTCHA). Do not hold AFK CAPTCHA forever — fill now; pause again at submit.
        let formReady = false;
        try {
            const detect = await chrome.tabs.sendMessage(currentTabId, { type: 'DETECT_APPLY_FORM' });
            formReady = !!(detect?.ok && detect?.data?.ok);
        } catch (_) { /* scripts loading */ }
        if (formReady && !wall.login && !isBlockingCaptchaWall(wall, { formReady: true })) {
            return {
                cleared: true,
                via: 'form_ready_nonblocking',
                formReady: true,
                ...wall
            };
        }

        await setQueueState({
            status: 'awaiting_captcha',
            captchaTabId: currentTabId,
            captchaApplicationId: applicationId,
            captchaKind: wall.captcha ? 'captcha' : 'login',
            captchaSince: st?.captchaSince || start,
            captchaTabMissing: false
        });
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return { cleared: false, timeout: true };
}

/**
 * Fill Greenhouse-style email security / verification code input.
 * Supports digit-only and alphanumeric codes (e.g. wFY53Ht3) across
 * single input OR multi-box (one character per box).
 */
export async function fillEmailSecurityCode(tabId, code) {
    const raw = String(code || '').trim();
    // Keep letters + digits; Greenhouse codes are often alphanumeric.
    const otp = raw.replace(/[^A-Za-z0-9]/g, '');
    if (!otp || otp.length < 4) return { filled: false, reason: 'empty_code' };
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            args: [otp],
            func: (otpCode) => {
                const setReactValue = (el, value) => {
                    const proto = el.tagName === 'TEXTAREA'
                        ? window.HTMLTextAreaElement.prototype
                        : window.HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc?.set) desc.set.call(el, value);
                    else el.value = value;
                    el.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        data: value,
                        inputType: 'insertText'
                    }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                };

                const isVisible = (el) => {
                    try {
                        if (!el) return false;
                        const st = window.getComputedStyle(el);
                        if (st.display === 'none' || st.visibility === 'hidden') return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    } catch (_) {
                        return false;
                    }
                };

                const allInputs = [...document.querySelectorAll('input')].filter((el) => {
                    const type = (el.type || '').toLowerCase();
                    if (['hidden', 'submit', 'checkbox', 'radio', 'file', 'button', 'image'].includes(type)) {
                        return false;
                    }
                    return isVisible(el);
                });

                // Prefer a horizontal row of short OTP boxes near "Security code".
                const shortBoxes = allInputs.filter((el) => {
                    const ml = Number(el.maxLength || 0);
                    const t = (el.type || '').toLowerCase();
                    if (!(t === 'text' || t === 'tel' || t === 'number' || t === 'password' || !t)) {
                        return false;
                    }
                    // maxlength 1 is ideal; also accept tiny boxes (Greenhouse sometimes omits maxlength)
                    const r = el.getBoundingClientRect();
                    const tiny = r.width > 0 && r.width <= 56;
                    return (ml === 1) || (ml > 0 && ml <= 2 && tiny) || (ml === 0 && tiny);
                });

                // Cluster boxes that share a parent / same Y row
                let boxes = [];
                if (shortBoxes.length >= 4) {
                    const byTop = new Map();
                    for (const el of shortBoxes) {
                        const top = Math.round(el.getBoundingClientRect().top / 8) * 8;
                        if (!byTop.has(top)) byTop.set(top, []);
                        byTop.get(top).push(el);
                    }
                    let best = [];
                    for (const row of byTop.values()) {
                        row.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                        if (row.length >= best.length) best = row;
                    }
                    if (best.length >= 4 && best.length <= 12) boxes = best;
                }

                if (boxes.length >= 4) {
                    const n = Math.min(boxes.length, otpCode.length);
                    // Clear first so leftover "1234" junk does not stick
                    boxes.forEach((el) => {
                        el.focus();
                        setReactValue(el, '');
                    });
                    for (let i = 0; i < n; i += 1) {
                        const ch = otpCode[i] || '';
                        const el = boxes[i];
                        el.focus();
                        setReactValue(el, ch);
                        try {
                            el.dispatchEvent(new KeyboardEvent('keyup', {
                                bubbles: true,
                                key: ch,
                                code: /^[0-9]$/.test(ch) ? `Digit${ch}` : `Key${ch.toUpperCase()}`
                            }));
                        } catch (_) { /* ignore */ }
                    }
                    const joined = boxes.map((el) => String(el.value || '')).join('');
                    return {
                        filled: joined.length >= Math.min(4, otpCode.length),
                        mode: 'multi_box',
                        boxes: boxes.length,
                        value: joined.slice(0, 16)
                    };
                }

                // Single input fallback
                const scored = allInputs.map((el) => {
                    const type = (el.type || '').toLowerCase();
                    const nearby = (() => {
                        try {
                            const root = el.closest(
                                'label, .field, .form-group, [class*="question"], [class*="Field"], div'
                            ) || el.parentElement;
                            return (root?.innerText || '').slice(0, 240);
                        } catch (_) {
                            return '';
                        }
                    })();
                    const lab = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('autocomplete') || ''} ${nearby}`.toLowerCase();
                    let score = 0;
                    if (/code|otp|token|verif|security|pin|confirmation/.test(lab)) score += 5;
                    if (type === 'tel' || type === 'number' || type === 'text' || type === 'one-time-code') score += 1;
                    if (el.autocomplete === 'one-time-code') score += 4;
                    if (el.inputMode === 'numeric' || el.inputMode === 'text') score += 1;
                    if (el.maxLength > 0 && el.maxLength <= 12) score += 2;
                    return { el, score };
                }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

                const target = scored[0]?.el;
                if (!target) return { filled: false, reason: 'no_input' };
                target.focus();
                setReactValue(target, '');
                setReactValue(target, otpCode);
                try {
                    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
                    target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
                } catch (_) { /* ignore */ }
                return {
                    filled: true,
                    mode: 'single',
                    name: target.name || target.id || null,
                    value: String(target.value || '').slice(0, 16)
                };
            }
        });
        return result || { filled: false };
    } catch (err) {
        return { filled: false, reason: err?.message || 'inject_failed' };
    }
}

/**
 * Poll Outlook inbox via API and fill the email OTP on the apply tab.
 */
export async function tryFillOutlookEmailOtp(tabId, { timeoutMs = 180000, applicationId = null } = {}) {
    try {
        const afterIso = new Date(Date.now() - 90 * 1000).toISOString();
        const hit = await waitOutlookOtp({
            timeoutMs,
            pollMs: 5000,
            afterIso,
            fromHint: 'greenhouse'
        });
        if (!hit?.ok || !hit?.code) {
            return { ok: false, error: hit?.error || 'no_code' };
        }
        const filled = await fillEmailSecurityCode(tabId, hit.code);
        return { ok: !!filled?.filled, code: hit.code, filled, subject: hit.subject };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

/**
 * Advance multi-step forms: click Next/Continue once if present (not Submit).
 */
export async function clickFormNextIfAny(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const buttons = [...document.querySelectorAll('button, a[role="button"], input[type="button"]')];
                const next = buttons.find((b) => {
                    const t = (b.innerText || b.value || '').trim().toLowerCase();
                    if (!t) return false;
                    if (/submit|apply|send application|withdraw|delete|cancel/.test(t)) return false;
                    return /^(next|continue|save and continue|review)$/i.test(t)
                        || /\bnext\b|\bcontinue\b/.test(t);
                });
                if (next) {
                    next.click();
                    return true;
                }
                return false;
            }
        });
        return !!result;
    } catch {
        return false;
    }
}

/**
 * Greenhouse often shows an email security-code step AFTER the first Submit.
 * Detect that UI so we keep the tab open and do a second submit.
 */
export async function detectEmailSecurityCodePage(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const text = (document.body?.innerText || '').slice(0, 8000).toLowerCase();
                const copyHit = /security\s*code|verification\s*code|confirm you'?re a human|code was sent to|enter the code|one[-\s]?time/.test(text)
                    && /email|inbox|@|gmail|outlook|sent to/.test(text);
                const inputs = [...document.querySelectorAll('input')].filter((el) => {
                    const type = (el.type || '').toLowerCase();
                    if (['hidden', 'submit', 'checkbox', 'radio', 'file', 'button'].includes(type)) return false;
                    try {
                        const st = window.getComputedStyle(el);
                        if (st.display === 'none' || st.visibility === 'hidden') return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    } catch (_) {
                        return false;
                    }
                });
                const shortBoxes = inputs.filter((el) => {
                    const ml = Number(el.maxLength || 0);
                    const r = el.getBoundingClientRect();
                    return ml === 1 || (r.width > 0 && r.width <= 56);
                });
                const labeled = inputs.some((el) => {
                    const lab = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
                    return /code|otp|verif|security|pin/.test(lab);
                });
                const nearLabel = /security\s*code/.test(text);
                return {
                    emailOtp: !!(copyHit || (nearLabel && (shortBoxes.length >= 4 || labeled))),
                    shortBoxes: shortBoxes.length,
                    labeled: !!labeled,
                    sample: text.slice(0, 120)
                };
            }
        });
        return result || { emailOtp: false };
    } catch {
        return { emailOtp: false };
    }
}

/** Second Submit / Confirm after Greenhouse email security code is filled. */
export async function clickPostOtpSubmit(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const buttons = [...document.querySelectorAll(
                    'button, input[type="submit"], a[role="button"]'
                )];
                const scored = buttons.map((el) => {
                    const t = `${el.innerText || el.value || el.getAttribute('aria-label') || ''}`.trim().toLowerCase();
                    let score = 0;
                    if (/submit application|submit your application/.test(t)) score += 10;
                    if (/^(submit|confirm|verify|continue)$/.test(t)) score += 8;
                    if (/verify code|confirm code|submit/.test(t)) score += 5;
                    if (/cancel|withdraw|back|edit/.test(t)) score -= 20;
                    const st = window.getComputedStyle(el);
                    if (st.display === 'none' || st.visibility === 'hidden') score = -1;
                    if (el.disabled || el.getAttribute('aria-disabled') === 'true') score -= 2;
                    return { el, score, t };
                }).filter((x) => x.score > 0);
                scored.sort((a, b) => b.score - a.score);
                const btn = scored[0]?.el;
                if (!btn) return { clicked: false, reason: 'no_button' };
                try {
                    btn.disabled = false;
                    btn.removeAttribute('disabled');
                    btn.setAttribute('aria-disabled', 'false');
                } catch (_) { /* ignore */ }
                btn.scrollIntoView({ block: 'center', inline: 'nearest' });
                btn.click();
                return { clicked: true, label: (btn.innerText || btn.value || '').trim().slice(0, 80) };
            }
        });
        return result || { clicked: false };
    } catch (err) {
        return { clicked: false, reason: err?.message || 'inject_failed' };
    }
}

/** True when security-code inputs already have enough characters (manual / Instruct). */
export async function emailOtpInputsFilled(tabId) {
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const inputs = [...document.querySelectorAll('input')].filter((el) => {
                    const type = (el.type || '').toLowerCase();
                    if (['hidden', 'submit', 'checkbox', 'radio', 'file', 'button'].includes(type)) return false;
                    try {
                        const st = window.getComputedStyle(el);
                        if (st.display === 'none' || st.visibility === 'hidden') return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    } catch (_) {
                        return false;
                    }
                });
                const shortBoxes = inputs.filter((el) => {
                    const ml = Number(el.maxLength || 0);
                    const r = el.getBoundingClientRect();
                    return ml === 1 || (r.width > 0 && r.width <= 56);
                });
                if (shortBoxes.length >= 4) {
                    const chars = shortBoxes.map((el) => String(el.value || '').trim()).join('');
                    return { filled: chars.replace(/[^A-Za-z0-9]/g, '').length >= 4, chars: chars.length };
                }
                const labeled = inputs.find((el) => {
                    const lab = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
                    return /code|otp|verif|security|pin/.test(lab);
                });
                if (labeled) {
                    const v = String(labeled.value || '').replace(/[^A-Za-z0-9]/g, '');
                    return { filled: v.length >= 4, chars: v.length };
                }
                return { filled: false, chars: 0 };
            }
        });
        return result || { filled: false };
    } catch {
        return { filled: false };
    }
}

export {
    acquireQueueLock,
    releaseQueueLock,
    setQueueState,
    bidderRequest,
    SUCCESS_RE,
    SUCCESS_HEADING_RE,
    SUCCESS_NEGATIVE_RE,
    evaluateSubmitSuccessPage,
    detectSubmitSuccessDetail,
    clearFalseSuccessOutlines
};
