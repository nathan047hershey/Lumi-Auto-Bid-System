/**
 * Talk to Lumi extension via content/app-bridge.js on localhost:5173.
 * After Reload Lumi, the orphaned bridge may die — we reinject via
 * chrome.runtime.sendMessage (externally_connectable) using the saved
 * extension id, so the user does not need Ctrl+Shift+R.
 */

const PAGE_TO_EXT = {
    JOB_APPLY_BIDDER_PROCESS_QUEUE: 'PROCESS_READY_QUEUE',
    JOB_APPLY_BIDDER_NEXT: 'BIDDER_NEXT',
    JOB_APPLY_BIDDER_STOP: 'BIDDER_STOP',
    JOB_APPLY_BIDDER_PAUSE: 'BIDDER_PAUSE',
    JOB_APPLY_BIDDER_RESUME: 'BIDDER_RESUME',
    JOB_APPLY_BIDDER_QUEUE_STATE: 'BIDDER_QUEUE_STATE',
    JOB_APPLY_BIDDER_CAPTCHA_RESUME: 'BIDDER_CAPTCHA_RESUME',
    JOB_APPLY_BIDDER_CAPTCHA_FOCUS_TAB: 'BIDDER_CAPTCHA_FOCUS_TAB',
    JOB_APPLY_BIDDER_CAPTCHA_SKIP: 'BIDDER_CAPTCHA_SKIP',
    JOB_APPLY_BIDDER_REAUTOFILL: 'BIDDER_REAUTOFILL',
    JOB_APPLY_BIDDER_APPLY_ANSWERS: 'BIDDER_APPLY_ANSWERS',
    JOB_APPLY_BIDDER_INSTRUCT: 'BIDDER_INSTRUCT',
    JOB_APPLY_BIDDER_LIST_QUESTIONS: 'BIDDER_LIST_QUESTIONS',
    JOB_APPLY_BIDDER_SUBMIT: 'BIDDER_SUBMIT',
    JOB_APPLY_BIDDER_UPDATE_STATE: 'BIDDER_UPDATE_STATE',
    JOB_APPLY_BIDDER_PING: 'BIDDER_PING',
    JOB_APPLY_BIDDER_REINJECT: 'REINJECT_APP_BRIDGE',
    JOB_APPLY_BIDDER_SAVE_PREFS: 'BIDDER_SAVE_PREFS',
    JOB_APPLY_BIDDER_PROBE_HELPERS: 'BIDDER_PROBE_CAPTCHA_HELPERS'
};

const EXT_ID_KEY = 'lumi_extension_id';
const EXT_VER_KEY = 'lumi_bridge_version';

function getStoredExtensionId() {
    try {
        return localStorage.getItem(EXT_ID_KEY) || '';
    } catch {
        return '';
    }
}

function rememberExtensionMeta(extensionId, version) {
    try {
        if (extensionId) localStorage.setItem(EXT_ID_KEY, String(extensionId));
        if (version) localStorage.setItem(EXT_VER_KEY, String(version));
        if (version) window.__LUMI_BRIDGE_VERSION__ = String(version);
    } catch (_) { /* ignore */ }
}

function hasExternalRuntime() {
    try {
        return typeof chrome !== 'undefined'
            && !!chrome.runtime
            && typeof chrome.runtime.sendMessage === 'function';
    } catch {
        return false;
    }
}

function sendViaExternal(mappedType, extra = {}, timeoutMs = 8000) {
    const extensionId = getStoredExtensionId();
    if (!extensionId || !hasExternalRuntime()) {
        return Promise.reject(new Error('no_external_runtime'));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error('external_timeout'));
        }, timeoutMs);
        try {
            chrome.runtime.sendMessage(
                extensionId,
                { type: mappedType, ...extra },
                (res) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    const err = chrome.runtime.lastError;
                    if (err) {
                        reject(new Error(err.message || 'external_failed'));
                        return;
                    }
                    if (res?.extensionId || res?.version) {
                        rememberExtensionMeta(res.extensionId || extensionId, res.version);
                    }
                    if (res?.ok === false) {
                        reject(new Error(res.error || 'Extension command failed'));
                        return;
                    }
                    resolve({
                        ok: true,
                        version: res?.version || '',
                        extensionId: res?.extensionId || extensionId,
                        result: res,
                        data: res,
                        via: 'external',
                        ...res
                    });
                }
            );
        } catch (err) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                reject(err);
            }
        }
    });
}

function sendViaPostMessage(type, timeoutMs, extra) {
    return new Promise((resolve, reject) => {
        const requestId = `bidder_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        const onMsg = (event) => {
            if (event.source !== window) return;
            if (event.data?.type !== 'JOB_APPLY_BIDDER_EXTENSION_REPLY') return;
            if (event.data?.requestId !== requestId) return;
            window.removeEventListener('message', onMsg);
            clearTimeout(timer);
            if (event.data.extensionId || event.data.version) {
                rememberExtensionMeta(event.data.extensionId, event.data.version);
            }
            if (event.data.ok) {
                resolve(event.data);
            } else {
                reject(new Error(event.data.error || 'Extension command failed'));
            }
        };

        const timer = setTimeout(() => {
            window.removeEventListener('message', onMsg);
            reject(new Error('postmessage_timeout'));
        }, timeoutMs);

        window.addEventListener('message', onMsg);
        window.postMessage({ type, requestId, ...extra }, '*');
    });
}

/**
 * Ask the extension to re-inject app-bridge into this tab (no page reload).
 */
export async function reinjectLumiBridge(timeoutMs = 8000) {
    const mapped = 'REINJECT_APP_BRIDGE';
    // Prefer external (works even when content bridge is orphaned).
    try {
        const res = await sendViaExternal(mapped, {}, timeoutMs);
        // Give the reinjected script a tick to bind listeners.
        await new Promise((r) => setTimeout(r, 200));
        return res;
    } catch (_) {
        // Fall back: content bridge may still be alive enough to forward reinject.
        try {
            const res = await sendViaPostMessage('JOB_APPLY_BIDDER_REINJECT', timeoutMs, {});
            await new Promise((r) => setTimeout(r, 200));
            return res;
        } catch (err) {
            throw new Error(
                err?.message || 'Could not reinject Lumi bridge — Reload Lumi in chrome://extensions, then click Check Lumi'
            );
        }
    }
}

/**
 * Send a bidder command. Tries the content bridge first; on failure reinjects
 * (or uses externally_connectable) and retries once — no hard refresh required.
 */
export function sendBidderExtensionCommand(type, timeoutMs = 8000, extra = {}) {
    const run = async () => {
        try {
            return await sendViaPostMessage(type, Math.min(timeoutMs, 4000), extra);
        } catch (firstErr) {
            // Bridge dead after Reload Lumi — reinject, then retry postMessage.
            try {
                await reinjectLumiBridge(Math.min(timeoutMs, 6000));
            } catch (_) { /* still try ping via external below */ }

            try {
                return await sendViaPostMessage(type, Math.min(timeoutMs, 5000), extra);
            } catch (secondErr) {
                // Ping/reinject can go external; other commands need a live bridge.
                const mapped = PAGE_TO_EXT[type];
                if (mapped === 'BIDDER_PING' || mapped === 'REINJECT_APP_BRIDGE' || mapped === 'BIDDER_PROBE_CAPTCHA_HELPERS') {
                    try {
                        return await sendViaExternal(mapped, extra, timeoutMs);
                    } catch (_) { /* fall through */ }
                }
                const hint = getStoredExtensionId()
                    ? 'Reload Lumi in chrome://extensions, then click Check Lumi (no page refresh needed).'
                    : 'Install/reload Lumi, open Job Links once so the bridge can save its id, then Check Lumi.';
                throw new Error(
                    `No response from Lumi Auto Bidder bridge — ${hint} `
                    + `(${secondErr?.message || firstErr?.message || 'timeout'})`
                );
            }
        }
    };
    return run();
}

/** True if content script announced a live bridge version on this page. */
export function getLumiBridgeVersion() {
    try {
        return window.__LUMI_BRIDGE_VERSION__
            || localStorage.getItem(EXT_VER_KEY)
            || '';
    } catch {
        return '';
    }
}

/** Listen for bridge ready / version bumps after reinject. */
export function listenForLumiBridgeReady(onReady) {
    if (typeof window === 'undefined' || typeof onReady !== 'function') return () => {};
    const handler = (event) => {
        if (event.source !== window) return;
        if (event.data?.type !== 'JOB_APPLY_BIDDER_BRIDGE_READY') return;
        rememberExtensionMeta(event.data.extensionId, event.data.version);
        onReady({
            version: event.data.version || '',
            extensionId: event.data.extensionId || getStoredExtensionId(),
            already: !!event.data.already,
            rebound: !!event.data.rebound
        });
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
}
