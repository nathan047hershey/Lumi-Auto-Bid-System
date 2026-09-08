/**
 * Bridge into the Job Apply Master web app (Resume Generator + Job Links).
 * - Injects JD from the extension into the React page
 * - Forwards generate-complete / answers-ready events to the background worker
 * - Forwards Auto Bidder Process/Next/Stop from the page to the service worker
 *
 * IMPORTANT: After chrome://extensions → Reload, this file is re-injected.
 * We must re-bind when the previous generation's runtime id is gone (orphaned
 * content scripts keep window flags but can no longer reach chrome.runtime).
 */
(() => {
    const version = (() => {
        try {
            return chrome.runtime.getManifest()?.version || '0';
        } catch {
            return '0';
        }
    })();

    let runtimeId = '';
    try {
        runtimeId = chrome.runtime?.id || '';
    } catch {
        runtimeId = '';
    }

    function extAlive() {
        try {
            return !!(chrome.runtime && chrome.runtime.id);
        } catch {
            return false;
        }
    }

    // Same version + bound flag is NOT enough after Reload Lumi — the old
    // content script is orphaned but leaves these flags on window. Compare
    // runtime id so a reinject always rebinds when the extension was reloaded.
    const alreadyLive = extAlive()
        && runtimeId
        && window.__JOB_APPLY_BIDDER_APP_BRIDGE_VERSION__ === version
        && window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__ === true
        && window.__JOB_APPLY_BIDDER_APP_BRIDGE_RUNTIME_ID__ === runtimeId
        && window.__JOB_APPLY_BIDDER_APP_BRIDGE_GEN__ === runtimeId;

    if (alreadyLive) {
        try {
            localStorage.setItem('lumi_extension_id', runtimeId);
            localStorage.setItem('lumi_bridge_version', version);
        } catch (_) { /* ignore */ }
        window.__LUMI_BRIDGE_VERSION__ = version;
        window.postMessage({
            type: 'JOB_APPLY_BIDDER_BRIDGE_READY',
            version,
            extensionId: runtimeId,
            already: true
        }, '*');
        return;
    }

    // Drop stale bind so a new listener can take over.
    window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__ = false;
    window.__JOB_APPLY_BIDDER_APP_BRIDGE_VERSION__ = version;
    window.__JOB_APPLY_BIDDER_APP_BRIDGE_RUNTIME_ID__ = runtimeId;
    window.__JOB_APPLY_BIDDER_APP_BRIDGE_GEN__ = runtimeId;
    window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__ = true;
    window.__LUMI_BRIDGE_VERSION__ = version;
    try {
        if (runtimeId) localStorage.setItem('lumi_extension_id', runtimeId);
        localStorage.setItem('lumi_bridge_version', version);
    } catch (_) { /* ignore */ }

    const PAGE_TO_EXT = {
        JOB_APPLY_BIDDER_PROCESS_QUEUE: 'PROCESS_READY_QUEUE',
        JOB_APPLY_BIDDER_NEXT: 'BIDDER_NEXT',
        JOB_APPLY_BIDDER_STOP: 'BIDDER_STOP',
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

    function replyToPage(requestId, payload) {
        window.postMessage({
            type: 'JOB_APPLY_BIDDER_EXTENSION_REPLY',
            requestId,
            ...payload
        }, '*');
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'BIDDER_INJECT_JOB') {
            try {
                if (msg.token) {
                    localStorage.setItem('token', msg.token);
                    if (msg.user) {
                        localStorage.setItem('user', JSON.stringify(msg.user));
                    }
                }

                const payload = msg.payload || {};
                sessionStorage.setItem('job_apply_bidder_pending', JSON.stringify(payload));

                window.postMessage({ type: 'JOB_APPLY_BIDDER_FILL', payload, retry: false }, '*');

                let n = 0;
                const timer = setInterval(() => {
                    window.postMessage({
                        type: 'JOB_APPLY_BIDDER_FILL',
                        payload: { ...payload, auto_generate: false },
                        retry: true
                    }, '*');
                    n += 1;
                    if (n >= 3) clearInterval(timer);
                }, 600);

                sendResponse({ ok: true });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }

        if (msg?.type === 'BIDDER_ANSWER_QUESTIONS') {
            try {
                window.postMessage({
                    type: 'JOB_APPLY_BIDDER_ANSWER_QUESTIONS',
                    payload: msg.payload || {}
                }, '*');
                sendResponse({ ok: true });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }

        return false;
    });

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const type = event.data?.type;
        const requestId = event.data?.requestId;

        const mapped = PAGE_TO_EXT[type];
        if (mapped) {
            if (!extAlive()) {
                window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__ = false;
                replyToPage(requestId, {
                    ok: false,
                    error: 'Lumi extension context invalidated — click Check Lumi (or Reload Lumi in chrome://extensions)'
                });
                return;
            }
            try {
                const payload = { type: mapped };
                if (Array.isArray(event.data?.jobLinkIds)) {
                    payload.jobLinkIds = event.data.jobLinkIds;
                }
                if (Array.isArray(event.data?.applicationIds)) {
                    payload.applicationIds = event.data.applicationIds;
                }
                if (event.data?.token) payload.token = event.data.token;
                if (event.data?.user) payload.user = event.data.user;
                if (event.data?.selectedProfileId != null) {
                    payload.selectedProfileId = event.data.selectedProfileId;
                }
                if (event.data?.uploadCoverLetter != null) {
                    payload.uploadCoverLetter = !!event.data.uploadCoverLetter;
                }
                if (event.data?.stayInApp != null) {
                    payload.stayInApp = !!event.data.stayInApp;
                }
                if (event.data?.unattended != null) {
                    payload.unattended = !!event.data.unattended;
                }
                if (event.data?.captchaGraceSec != null) {
                    payload.captchaGraceSec = Number(event.data.captchaGraceSec);
                }
                if (event.data?.captchaHelper != null) {
                    payload.captchaHelper = !!event.data.captchaHelper;
                }
                if (event.data?.captchaHelperWaitSec != null) {
                    payload.captchaHelperWaitSec = Number(event.data.captchaHelperWaitSec);
                }
                if (event.data?.capsolverApiKey != null) {
                    payload.capsolverApiKey = String(event.data.capsolverApiKey || '');
                }
                if (event.data?.twocaptchaApiKey != null) {
                    payload.twocaptchaApiKey = String(event.data.twocaptchaApiKey || '');
                }
                if (event.data?.prefs && typeof event.data.prefs === 'object') {
                    payload.prefs = event.data.prefs;
                }
                if (event.data?.force != null) payload.force = !!event.data.force;
                if (event.data?.kick != null) payload.kick = !!event.data.kick;
                if (event.data?.focusTab != null) payload.focusTab = !!event.data.focusTab;
                if (event.data?.forceNavigate != null) payload.forceNavigate = !!event.data.forceNavigate;
                if (event.data?.preferExistingTab != null) {
                    payload.preferExistingTab = !!event.data.preferExistingTab;
                }
                if (event.data?.tabId != null) payload.tabId = event.data.tabId;
                if (event.data?.url) payload.url = String(event.data.url);
                if (event.data?.applicationId != null) {
                    payload.applicationId = Number(event.data.applicationId) || event.data.applicationId;
                }
                if (Array.isArray(event.data?.answers)) {
                    payload.answers = event.data.answers;
                }
                if (event.data?.instruction != null) {
                    payload.instruction = String(event.data.instruction || '');
                }
                chrome.runtime.sendMessage(payload, (res) => {
                    const lastErr = chrome.runtime.lastError;
                    if (lastErr) {
                        window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__ = false;
                        replyToPage(requestId, {
                            ok: false,
                            error: lastErr.message || 'Extension unavailable — Reload Lumi, then click Check Lumi'
                        });
                        return;
                    }
                    replyToPage(requestId, {
                        ok: !!res?.ok,
                        error: res?.error || null,
                        result: res?.result ?? res?.data ?? res ?? null,
                        data: res?.data ?? res?.result ?? res ?? null,
                        started: !!res?.started,
                        queued: res?.queued ?? null,
                        processed: res?.processed ?? null,
                        skippedAts: res?.skippedAts ?? null,
                        jobLinkIds: res?.jobLinkIds ?? null,
                        captchaTabId: res?.captchaTabId ?? null,
                        stayInApp: res?.stayInApp ?? null,
                        reopened: !!res?.reopened,
                        navigated: !!res?.navigated,
                        focusedExisting: !!res?.focusedExisting,
                        tabId: res?.tabId ?? null,
                        filled: res?.filled ?? null,
                        submitClicked: !!res?.submitClicked,
                        incomplete: !!res?.incomplete,
                        applicationId: res?.applicationId ?? null,
                        questions: res?.questions ?? null,
                        answersCount: res?.answersCount ?? null,
                        summary: res?.summary ?? null,
                        coach: res?.coach ?? null,
                        version: res?.version || version
                    });
                });
            } catch (err) {
                window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__ = false;
                replyToPage(requestId, {
                    ok: false,
                    error: err?.message || 'Failed to reach Lumi extension'
                });
            }
            return;
        }

        if (type === 'JOB_APPLY_BIDDER_GENERATE_DONE') {
            try {
                if (!extAlive()) return;
                chrome.runtime.sendMessage({
                    type: 'GENERATE_DONE',
                    result: event.data.result || {}
                });
            } catch (err) {
                console.warn('[bidder] GENERATE_DONE forward failed', err);
            }
            return;
        }
        if (type === 'JOB_APPLY_BIDDER_ANSWERS_READY') {
            try {
                if (!extAlive()) return;
                chrome.runtime.sendMessage({
                    type: 'ANSWERS_READY',
                    requestId: event.data.requestId || null,
                    payload: event.data.payload || {},
                    error: event.data.error || null
                });
            } catch (err) {
                console.warn('[bidder] ANSWERS_READY forward failed', err);
            }
        }
    });

    window.postMessage({
        type: 'JOB_APPLY_BIDDER_BRIDGE_READY',
        version,
        extensionId: runtimeId || null,
        rebound: true
    }, '*');
})();
