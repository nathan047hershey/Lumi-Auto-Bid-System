/**
 * Lumi Auto Bidder runtime prefs (AFK, CAPTCHA keys, auto-submit, …).
 * Stored in localStorage; synced to the extension via BIDDER_SAVE_PREFS.
 */
import { sendBidderExtensionCommand } from './bidderExtensionBridge.js';

export const LUMI_PREFS_KEY = 'lumi_bidder_prefs';
export const LUMI_CAPSOLVER_KEY = 'lumi_capsolver_api_key';
export const LUMI_TWOCAPTCHA_KEY = 'lumi_twocaptcha_api_key';
export const LUMI_TWOCAPTCHA_KEY_ALT = 'lumi_2captcha_api_key';

/** @typedef {object} LumiBidderPrefs
 * @property {boolean} stayInApp
 * @property {boolean} unattended
 * @property {boolean} captchaHelper
 * @property {boolean} autoSubmit
 * @property {boolean} autoNext
 * @property {boolean} captchaFocus
 * @property {boolean} uploadCoverLetter
 * @property {boolean} soundEnabled
 * @property {string} capsolverApiKey
 * @property {string} twocaptchaApiKey
 */

export const DEFAULT_LUMI_BIDDER_PREFS = {
    stayInApp: true,
    unattended: true,
    captchaHelper: true,
    autoSubmit: true,
    autoNext: true,
    captchaFocus: false,
    uploadCoverLetter: false,
    soundEnabled: true,
    capsolverApiKey: '',
    twocaptchaApiKey: ''
};

/** One-click Jobright-style hands-free preset. */
export const HANDS_FREE_LUMI_PREFS = {
    stayInApp: true,
    unattended: true,
    captchaHelper: true,
    autoSubmit: true,
    autoNext: true,
    captchaFocus: false,
    uploadCoverLetter: false,
    soundEnabled: true
};

/** Free CAPTCHA only — Buster + NopeCHA; no paid solver API keys. */
export const FREE_HELPERS_LUMI_PREFS = {
    ...HANDS_FREE_LUMI_PREFS,
    captchaHelper: true,
    capsolverApiKey: '',
    twocaptchaApiKey: ''
};

function readJson(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function readStr(key) {
    try {
        return localStorage.getItem(key) || '';
    } catch {
        return '';
    }
}

/** @returns {LumiBidderPrefs} */
export function loadLumiBidderPrefs() {
    const stored = readJson(LUMI_PREFS_KEY) || {};
    const capsolverApiKey = String(
        stored.capsolverApiKey != null ? stored.capsolverApiKey : readStr(LUMI_CAPSOLVER_KEY)
    ).trim();
    const twocaptchaApiKey = String(
        stored.twocaptchaApiKey != null
            ? stored.twocaptchaApiKey
            : (readStr(LUMI_TWOCAPTCHA_KEY) || readStr(LUMI_TWOCAPTCHA_KEY_ALT))
    ).trim();
    return {
        ...DEFAULT_LUMI_BIDDER_PREFS,
        ...stored,
        capsolverApiKey,
        twocaptchaApiKey,
        stayInApp: stored.stayInApp != null ? !!stored.stayInApp : DEFAULT_LUMI_BIDDER_PREFS.stayInApp,
        unattended: stored.unattended != null ? !!stored.unattended : DEFAULT_LUMI_BIDDER_PREFS.unattended,
        captchaHelper: stored.captchaHelper != null ? !!stored.captchaHelper : DEFAULT_LUMI_BIDDER_PREFS.captchaHelper,
        autoSubmit: stored.autoSubmit != null ? !!stored.autoSubmit : DEFAULT_LUMI_BIDDER_PREFS.autoSubmit,
        autoNext: stored.autoNext != null ? !!stored.autoNext : DEFAULT_LUMI_BIDDER_PREFS.autoNext,
        captchaFocus: stored.captchaFocus != null
            ? !!stored.captchaFocus
            : (stored.unattended != null ? !stored.unattended : DEFAULT_LUMI_BIDDER_PREFS.captchaFocus),
        uploadCoverLetter: !!stored.uploadCoverLetter,
        soundEnabled: stored.soundEnabled != null ? !!stored.soundEnabled : DEFAULT_LUMI_BIDDER_PREFS.soundEnabled
    };
}

/** Persist prefs + legacy key slots used by Process payload. */
export function persistLumiBidderPrefs(prefs) {
    const prev = loadLumiBidderPrefs();
    const next = { ...prev, ...prefs };
    // Keep keys unless:
    //  - clearCaptchaApiKeys: true (user clicked Clear), or
    //  - replaceCaptchaApiKeys: true (user is pasting replacements; empty allowed mid-edit)
    // Non-empty new values always win (replace wrong keys).
    const explicitClear = prefs && prefs.clearCaptchaApiKeys === true;
    const replacing = prefs && prefs.replaceCaptchaApiKeys === true;
    if (!explicitClear && !replacing) {
        if (!String(next.capsolverApiKey || '').trim() && String(prev.capsolverApiKey || '').trim()) {
            next.capsolverApiKey = prev.capsolverApiKey;
        }
        if (!String(next.twocaptchaApiKey || '').trim() && String(prev.twocaptchaApiKey || '').trim()) {
            next.twocaptchaApiKey = prev.twocaptchaApiKey;
        }
    }
    delete next.clearCaptchaApiKeys;
    delete next.replaceCaptchaApiKeys;
    try {
        localStorage.setItem(LUMI_PREFS_KEY, JSON.stringify({
            stayInApp: !!next.stayInApp,
            unattended: !!next.unattended,
            captchaHelper: !!next.captchaHelper,
            autoSubmit: !!next.autoSubmit,
            autoNext: !!next.autoNext,
            captchaFocus: !!next.captchaFocus,
            uploadCoverLetter: !!next.uploadCoverLetter,
            soundEnabled: !!next.soundEnabled,
            capsolverApiKey: String(next.capsolverApiKey || ''),
            twocaptchaApiKey: String(next.twocaptchaApiKey || '')
        }));
        localStorage.setItem(LUMI_CAPSOLVER_KEY, String(next.capsolverApiKey || ''));
        localStorage.setItem(LUMI_TWOCAPTCHA_KEY, String(next.twocaptchaApiKey || ''));
    } catch (_) { /* ignore */ }
    return next;
}

/** Map app prefs → chrome.storage field names used by getBidderPrefs. */
export function prefsToExtensionPatch(prefs) {
    const p = { ...DEFAULT_LUMI_BIDDER_PREFS, ...prefs };
    return {
        bidderStayInApp: !!p.stayInApp,
        bidderUnattended: !!p.unattended,
        bidderCaptchaHelper: true,
        bidderCaptchaHelperWaitSec: 90,
        bidderCaptchaGraceSec: 45,
        bidderAutoSubmit: !!p.autoSubmit,
        bidderAutoNext: !!p.autoNext,
        bidderCaptchaFocus: p.unattended ? false : !!p.captchaFocus,
        bidderUploadCoverLetter: !!p.uploadCoverLetter,
        bidderSoundEnabled: !!p.soundEnabled,
        // Clear paid solver keys — free NopeCHA/Buster path only.
        bidderCapsolverApiKey: '',
        bidderTwocaptchaApiKey: '',
        bidderDisabledFillLessons: (() => {
            try {
                const raw = localStorage.getItem('lumi_disabled_fill_lessons');
                return raw ? JSON.parse(raw) : {};
            } catch {
                return {};
            }
        })()
    };
}

/**
 * Save locally and push to Lumi extension (best-effort).
 * @returns {Promise<{ prefs: LumiBidderPrefs, synced: boolean, error?: string }>}
 */
export async function saveLumiBidderPrefs(patch) {
    const prefs = persistLumiBidderPrefs(patch);
    const extensionPatch = prefsToExtensionPatch(prefs);
    try {
        await sendBidderExtensionCommand('JOB_APPLY_BIDDER_SAVE_PREFS', 8000, {
            prefs: extensionPatch
        });
        return { prefs, synced: true };
    } catch (err) {
        return {
            prefs,
            synced: false,
            error: err?.message || 'Could not sync to Lumi extension'
        };
    }
}

/** Payload fragment for PROCESS_READY_QUEUE from current prefs. */
export function processQueuePrefsPayload(prefs = loadLumiBidderPrefs()) {
    const p = { ...DEFAULT_LUMI_BIDDER_PREFS, ...prefs };
    let disabledFillLessons = {};
    try {
        const raw = localStorage.getItem('lumi_disabled_fill_lessons');
        if (raw) disabledFillLessons = JSON.parse(raw) || {};
    } catch {
        disabledFillLessons = {};
    }
    return {
        stayInApp: !!p.stayInApp,
        unattended: !!p.unattended,
        autoSubmit: !!p.autoSubmit,
        autoNext: !!p.autoNext,
        captchaGraceSec: p.unattended ? 45 : undefined,
        captchaHelper: true,
        captchaHelperWaitSec: 90,
        // Paid CapSolver / 2Captcha APIs disabled — free helpers only.
        uploadCoverLetter: !!p.uploadCoverLetter,
        disabledFillLessons
    };
}
