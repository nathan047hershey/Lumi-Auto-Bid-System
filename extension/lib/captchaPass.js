/**
 * CAPTCHA engineer — detect vendors + strategies.
 * Built-in CapSolver/2Captcha token solve lives in captchaSolver.js (wired from background).
 * This module also recommends Chrome helpers (NopeCHA etc.) as fallback.
 */

/** Every vendor Lumi can name (detection + strategy). */
export const ALL_CAPTCHA_VENDORS = [
    'recaptcha',
    'hcaptcha',
    'turnstile',
    'arkose',
    'datadome',
    'perimeterx',
    'geetest',
    'cloudflare',
    'aws_waf',
    'mtcaptcha',
    'keycaptcha',
    'friendly',
    'lemin',
    'generic',
    'email_otp',
    'login',
    'none'
];

/** Public Chrome helpers (not bundled in Lumi). */
export const CAPTCHA_EXTENSION_CATALOG = [
    {
        id: 'buster',
        name: 'Buster',
        storeUrl: 'https://chromewebstore.google.com/detail/buster-captcha-solver-for/mpbjkejclgfgadiemmefgebjfooflfhl',
        cost: 'free',
        method: 'reCAPTCHA audio → speech-to-text',
        vendors: ['recaptcha'],
        notes: 'Free. reCAPTCHA v2 audio. Use with NopeCHA for broader free coverage.'
    },
    {
        id: 'hektcaptcha',
        name: 'hektCaptcha',
        storeUrl: 'https://chromewebstore.google.com/search/hektCaptcha',
        cost: 'free',
        method: 'local AI',
        vendors: ['hcaptcha'],
        notes: 'hCaptcha only.'
    },
    {
        id: 'nopecha',
        name: 'NopeCHA',
        storeUrl: 'https://chromewebstore.google.com/detail/nopecha-captcha-solver/dknlfmjaanfblgfdfebhijalfmhmjjjo',
        cost: 'free_tier_then_paid',
        method: 'AI extension',
        vendors: ['recaptcha', 'hcaptcha', 'turnstile', 'generic'],
        notes: 'Best free helper for Lumi AFK (~100 solves/day). Same Chrome profile as Lumi.'
    },
    {
        id: 'capsolver',
        name: 'CapSolver',
        storeUrl: 'https://chromewebstore.google.com/search/CapSolver',
        cost: 'paid',
        method: 'AI / tokens',
        vendors: ['recaptcha', 'hcaptcha', 'turnstile', 'geetest', 'arkose', 'aws_waf', 'generic'],
        notes: 'Paid. Widest commercial coverage among browser extensions.'
    }
];

/** Narrow free helpers (Buster). */
export const NARROW_HELPER_VENDORS = new Set(['recaptcha']);

/** Broad free/paid helpers often attempt these. */
export const BROAD_HELPER_VENDORS = new Set([
    'hcaptcha',
    'turnstile',
    'geetest',
    'aws_waf',
    'mtcaptcha',
    'generic'
]);

/** Rarely cleared by free helpers. */
export const HARD_VENDORS = new Set([
    'arkose',
    'datadome',
    'perimeterx',
    'cloudflare',
    'keycaptcha',
    'friendly',
    'lemin'
]);

export const HELPER_FRIENDLY_VENDORS = NARROW_HELPER_VENDORS;
export const HUMAN_ONLY_VENDORS = new Set([...HARD_VENDORS, 'login']);

const HELPER_WAIT_MS = 90 * 1000;
const SKIP_FAST_MS = 25 * 1000;
const HARD_SKIP_MS = 20 * 1000;
const LOGIN_WAIT_MS = 20 * 1000;

export function recommendHelpersForVendor(vendor) {
    const v = String(vendor || 'generic').toLowerCase();
    if (v === 'none' || v === 'login') return [];
    const hits = CAPTCHA_EXTENSION_CATALOG.filter((ext) => ext.vendors.includes(v));
    if (hits.length) return hits;
    // Fallback: recommend broad helpers for unknown/hard
    // Prefer free helpers in recommendations when listing for free path
    return CAPTCHA_EXTENSION_CATALOG.filter((e) => e.id === 'nopecha' || e.id === 'buster');
}

/**
 * Identify CAPTCHA / bot-check vendor from page signals.
 * Order: specific commercial widgets first, then Google, then generic Cloudflare copy.
 */
export function detectCaptchaVendor({ text = '', html = '' } = {}) {
    const t = String(text || '').toLowerCase();
    const h = String(html || '').toLowerCase();
    const blob = `${t}\n${h}`;

    if (/arkose|funcaptcha|arkoselabs/.test(blob)) return 'arkose';
    if (/aws.?waf|awswaf|amazon.?waf|captcha\.awswaf/.test(blob)) return 'aws_waf';
    if (/cf-turnstile|challenges\.cloudflare\.com\/turnstile|turnstile/.test(blob)) return 'turnstile';
    if (/hcaptcha|h-captcha|newassets\.hcaptcha/.test(blob)) return 'hcaptcha';
    if (/datadome/.test(blob)) return 'datadome';
    if (/perimeterx|px-captcha|px-human/.test(blob)) return 'perimeterx';
    if (/geetest|gt4_/.test(blob)) return 'geetest';
    if (/mtcaptcha/.test(blob)) return 'mtcaptcha';
    if (/keycaptcha/.test(blob)) return 'keycaptcha';
    if (/friendlycaptcha|friendly-challenge/.test(blob)) return 'friendly';
    if (/lemin.?captcha|lemincropped/.test(blob)) return 'lemin';
    if (/recaptcha|g-recaptcha|google\.com\/recaptcha|grecaptcha|recaptcha\/enterprise/.test(blob)) {
        return 'recaptcha';
    }
    if (/checking your browser|just a moment|cf-browser-verification|attention required|enable javascript and cookies to continue/.test(t)) {
        return 'cloudflare';
    }
    if (/captcha|verify you are human|i'?m not a robot|prove you(?:'?re| are) (?:a )?human|security challenge|bot detection|unusual traffic/.test(blob)) {
        return 'generic';
    }
    return 'none';
}

/**
 * Strategy for every known vendor.
 * captchaHelper=true → wait on ALL captcha types for installed Chrome helpers.
 */
export function captchaStrategyForVendor(vendor, { login = false, captchaHelper = false } = {}) {
    if (login) {
        return {
            id: 'human',
            vendor: vendor || 'login',
            helperUseful: false,
            unattendedWaitMs: LOGIN_WAIT_MS,
            recommendedHelpers: [],
            label: 'Login wall — helpers cannot sign in for you'
        };
    }

    const v = String(vendor || 'generic').toLowerCase();
    const id = v === 'none' ? 'generic' : v;
    const recommendedHelpers = recommendHelpersForVendor(id);
    const helperNames = recommendedHelpers.map((h) => h.name).join(', ') || 'NopeCHA / CapSolver';

    // With helper wait ON: give every CAPTCHA type the full helper window.
    if (captchaHelper) {
        return {
            id: 'helper_wait',
            vendor: id,
            helperUseful: true,
            unattendedWaitMs: HELPER_WAIT_MS,
            recommendedHelpers,
            label: `${vendorLabel(id)} — waiting for Chrome helper (${helperNames})`
        };
    }

    if (NARROW_HELPER_VENDORS.has(id) || id === 'recaptcha') {
        return {
            id: 'helper_wait',
            vendor: 'recaptcha',
            helperUseful: true,
            unattendedWaitMs: HELPER_WAIT_MS,
            recommendedHelpers: recommendHelpersForVendor('recaptcha'),
            label: 'Google reCAPTCHA — enable helper wait + Buster/NopeCHA, or solve manually'
        };
    }

    if (BROAD_HELPER_VENDORS.has(id)) {
        return {
            id: 'skip_fast',
            vendor: id,
            helperUseful: true,
            unattendedWaitMs: SKIP_FAST_MS,
            recommendedHelpers,
            label: `${vendorLabel(id)} — enable “Wait for CAPTCHA helper” (NopeCHA) or skip`
        };
    }

    if (HARD_VENDORS.has(id) || id === 'generic') {
        return {
            id: 'skip_fast',
            vendor: id,
            helperUseful: false,
            unattendedWaitMs: HARD_SKIP_MS,
            recommendedHelpers: CAPTCHA_EXTENSION_CATALOG.filter((e) => e.id === 'capsolver' || e.id === 'nopecha'),
            label: `${vendorLabel(id)} — hard wall; skip fast unless helper wait is on`
        };
    }

    return {
        id: 'skip_fast',
        vendor: id,
        helperUseful: false,
        unattendedWaitMs: SKIP_FAST_MS,
        recommendedHelpers: [],
        label: `${vendorLabel(id)} — short wait then skip when AFK`
    };
}

export function vendorLabel(vendor) {
    const map = {
        recaptcha: 'Google reCAPTCHA',
        hcaptcha: 'hCaptcha',
        turnstile: 'Cloudflare Turnstile',
        arkose: 'Arkose / FunCaptcha',
        datadome: 'DataDome',
        perimeterx: 'PerimeterX',
        geetest: 'GeeTest',
        cloudflare: 'Cloudflare browser check',
        aws_waf: 'AWS WAF CAPTCHA',
        mtcaptcha: 'MTCaptcha',
        keycaptcha: 'KeyCaptcha',
        friendly: 'Friendly Captcha',
        lemin: 'Lemin Captcha',
        generic: 'CAPTCHA / bot check',
        email_otp: 'Email security code',
        login: 'Login wall',
        none: 'None'
    };
    return map[String(vendor || '').toLowerCase()] || String(vendor || 'Challenge');
}

export function classifyCaptchaOrLogin({
    text = '',
    html = '',
    hasWidget = false,
    widgetSolved = false,
    captchaHelper = false
} = {}) {
    const t = String(text || '').toLowerCase();
    const h = String(html || '').toLowerCase();

    // Hard interstitial copy (Cloudflare / WAF / full-page puzzles).
    // Do NOT treat reCAPTCHA checkbox marketing ("I'm not a robot") as an interstitial —
    // Greenhouse embeds that text on every apply form and it was blocking fill forever.
    const hardChallengeCopy = /verify you are human|complete the security check|attention required|checking your browser|just a moment(?:\.\.\.)?|enable javascript and cookies|press (?:and )?hold|solve the puzzle|security challenge|confirm you are a human|bot detection|access denied|unusual traffic|prove you(?:'?re| are) (?:a )?human|aws waf|human verification/.test(t);
    const softCheckboxCopy = /i'?m not a robot|are you a robot/.test(t);
    const challengeCopy = hardChallengeCopy || (softCheckboxCopy && !hasWidget);

    const captchaToken = /recaptcha|hcaptcha|cf-turnstile|h-captcha|g-recaptcha|arkose|funcaptcha|datadome|perimeterx|px-captcha|geetest|mtcaptcha|keycaptcha|friendlycaptcha|lemin|awswaf|aws.?waf|captcha/.test(h);
    let captcha = !!hasWidget || challengeCopy || (captchaToken && /challenge|verify|robot|human|security|captcha|waf|turnstile|arkose|geetest/.test(`${t} ${h}`));

    // Helper cleared the puzzle but left the iframe on the page — treat as clear.
    if (widgetSolved && !hardChallengeCopy) {
        captcha = false;
    }

    // Real login walls need a password field or "log in to continue/apply" copy.
    // Career JD headers often include bare "Sign In" — that alone must NOT block Apply.
    const hasPasswordInput = /type\s*=\s*["']password["']/.test(h)
        || /<input[^>]*(?:password|autocomplete\s*=\s*["']current-password["'])/i.test(h);
    const loginGateCopy = /\bplease\s+log\s*in\b|\bcandidate\s+sign[\s-]*in\b|\blog\s*in\s+to\s+(?:continue|apply|your\s+account)\b|\bsign\s*in\s+to\s+(?:continue|apply|your\s+account)\b/.test(t);
    const createAccountWall = /\bcreate\s+an?\s+account\b/.test(t)
        && (hasPasswordInput || (/\bpassword\b/.test(t) && /\bemail\b/.test(t) && !/\bfirst\s*name\b/.test(t)));
    const login = (hasPasswordInput && (/\bsign\s*in\b|\blog\s*in\b|\bpassword\b/.test(t)))
        || loginGateCopy
        || createAccountWall;
    // JD / pre-Apply pages: remote + Apply + Sign In nav ≠ login wall
    const looksLikeJdOrApply = !hasPasswordInput
        && /\b(?:apply\s+now|apply\s+for\s+this|full\s*time|part\s*time|\bremote\b|job\s+description|about\s+the\s+(?:job|role))\b/.test(t)
        && !loginGateCopy;

    const emailOtp = /(?:security\s*code|verification\s*code|enter\s+(?:the\s+)?(?:code|otp)|one[-\s]?time(?:\s+pass(?:code|word)?)?|we\s+(?:sent|emailed)\s+(?:you\s+)?(?:a\s+)?code|check\s+your\s+(?:email|inbox)|email\s+(?:us\s+)?(?:a\s+)?(?:security\s+)?code)/.test(t)
        || (/greenhouse/.test(t) && /\b(?:code|verify|verification)\b/.test(t) && /\b(?:email|inbox|mail)\b/.test(t));

    const loginWall = !!login && !looksLikeJdOrApply;

    const vendor = captcha || loginWall
        ? (loginWall && !captcha ? 'login' : detectCaptchaVendor({ text: t, html: h }))
        : 'none';
    const resolvedVendor = vendor === 'none' && captcha ? 'generic' : vendor;
    const strategy = captchaStrategyForVendor(resolvedVendor, { login: loginWall, captchaHelper });

    return {
        captcha: !!captcha || !!emailOtp,
        login: !!loginWall,
        emailOtp: !!emailOtp,
        widgetHit: !!hasWidget,
        widgetSolved: !!widgetSolved,
        challengeCopy: !!challengeCopy,
        vendor: emailOtp && !hasWidget ? 'email_otp' : resolvedVendor,
        strategy: strategy.id,
        strategyLabel: emailOtp ? 'Email security code (Outlook)' : strategy.label,
        helperUseful: !!strategy.helperUseful || !!emailOtp,
        unattendedWaitMs: strategy.unattendedWaitMs,
        recommendedHelpers: strategy.recommendedHelpers || []
    };
}

/**
 * Whether CAPTCHA/login should pause the queue vs allow fill to continue.
 *
 * Embedded widgets (reCAPTCHA sitekey on a normal Greenhouse form) are NOT blocking
 * once an apply form is present — otherwise Process never fills anything.
 *
 * @param {object} wall — result of classifyCaptchaOrLogin / detectCaptchaOrLogin
 * @param {{ formReady?: boolean, forSubmit?: boolean, captchaHelper?: boolean }} opts
 */
export function isBlockingCaptchaWall(wall, { formReady = false, forSubmit = false, captchaHelper = false } = {}) {
    if (!wall) return false;
    if (wall.login) return true;
    if (wall.emailOtp || /email_otp/i.test(String(wall.vendor || ''))) return true;
    if (!wall.captcha) return false;
    if (wall.widgetSolved && !wall.challengeCopy) return false;
    // Full-page / interstitial challenge always blocks — unless the apply form is
    // already ready and this is only an embedded widget (fill first, pause at submit).
    if (wall.challengeCopy) {
        if (!(formReady && wall.widgetHit && !forSubmit)) return true;
    }

    const vendor = String(wall.vendor || '').toLowerCase();

    // Before submit with helper wait ON: pause so NopeCHA/CapSolver can clear the widget.
    if (forSubmit && (captchaHelper || wall.widgetHit || wall.challengeCopy)) {
        if (['cloudflare', 'datadome', 'perimeterx', 'aws_waf', 'arkose', 'recaptcha', 'hcaptcha', 'turnstile', 'generic'].includes(vendor)
            || wall.widgetHit) {
            return true;
        }
    }

    // Known hard walls: only treat as passive when a form is ready AND a widget sits on it
    if (['cloudflare', 'datadome', 'perimeterx', 'aws_waf', 'arkose'].includes(vendor)) {
        if (formReady && wall.widgetHit && !forSubmit) return false;
        return true;
    }

    // Apply form already visible: ignore passive sitekey / iframe widgets and fill fields.
    if (formReady) return false;

    // No form yet: widget-only recaptcha/hcaptcha/turnstile → keep polling for form (not a wait loop).
    if (wall.widgetHit && /^(recaptcha|hcaptcha|turnstile|generic|none)$/i.test(vendor || 'generic')) {
        return false;
    }

    // Other captcha signals before form appears — treat as blocking
    return true;
}

/** Known Chrome Web Store IDs for free helpers (same profile as Lumi). */
export const HELPER_EXTENSION_IDS = {
    nopecha: 'dknlfmjaanfblgfdfebhijalfmhmjjjo',
    buster: 'mpbjkejclgfgadiemmefgebjfooflfhl'
};

/**
 * Probe whether NopeCHA / Buster are installed in this Chrome profile.
 * Uses chrome.management when available.
 */
export async function probeCaptchaHelpers() {
    const result = {
        nopecha: false,
        buster: false,
        helper_missing: true,
        probed: false
    };
    try {
        if (!chrome?.management?.getAll) {
            return result;
        }
        const all = await chrome.management.getAll();
        result.probed = true;
        for (const ext of all || []) {
            if (!ext?.enabled) continue;
            const id = String(ext.id || '');
            const name = String(ext.name || '').toLowerCase();
            if (id === HELPER_EXTENSION_IDS.nopecha || name.includes('nopecha')) result.nopecha = true;
            if (id === HELPER_EXTENSION_IDS.buster || name.includes('buster')) result.buster = true;
        }
        result.helper_missing = !(result.nopecha || result.buster);
        return result;
    } catch {
        return result;
    }
}

