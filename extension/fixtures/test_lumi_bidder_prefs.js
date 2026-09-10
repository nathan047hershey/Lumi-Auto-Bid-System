/**
 * Pure mapping smoke for Lumi bidder prefs (mirrors client/src/lib/lumiBidderPrefs.js).
 * Free CAPTCHA helpers only — no CapSolver/2Captcha API keys.
 * Run: node extension/fixtures/test_lumi_bidder_prefs.js
 */

const DEFAULT = {
    stayInApp: true,
    unattended: true,
    captchaHelper: true,
    autoSubmit: true,
    autoNext: true,
    captchaFocus: false,
    uploadCoverLetter: false,
    soundEnabled: true,
    humanAssistWaitSec: 90,
    capsolverApiKey: '',
    twocaptchaApiKey: ''
};

function clampHumanAssistWaitSec(value, fallback = DEFAULT.humanAssistWaitSec) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(600, Math.round(n)));
}

function prefsToExtensionPatch(prefs) {
    const p = { ...DEFAULT, ...prefs };
    const waitSec = clampHumanAssistWaitSec(p.humanAssistWaitSec);
    return {
        bidderStayInApp: !!p.stayInApp,
        bidderUnattended: !!p.unattended,
        bidderCaptchaHelper: true,
        bidderHumanAssistWaitSec: waitSec,
        bidderCaptchaHelperWaitSec: waitSec,
        bidderCaptchaGraceSec: waitSec,
        bidderAutoSubmit: !!p.autoSubmit,
        bidderAutoNext: !!p.autoNext,
        bidderCaptchaFocus: p.unattended ? false : !!p.captchaFocus,
        bidderUploadCoverLetter: !!p.uploadCoverLetter,
        bidderSoundEnabled: !!p.soundEnabled,
        bidderCapsolverApiKey: '',
        bidderTwocaptchaApiKey: ''
    };
}

function processQueuePrefsPayload(prefs) {
    const p = { ...DEFAULT, ...prefs };
    const waitSec = clampHumanAssistWaitSec(p.humanAssistWaitSec);
    return {
        stayInApp: !!p.stayInApp,
        unattended: !!p.unattended,
        autoSubmit: !!p.autoSubmit,
        autoNext: !!p.autoNext,
        humanAssistWaitSec: waitSec,
        captchaGraceSec: waitSec,
        captchaHelper: true,
        captchaHelperWaitSec: waitSec,
        uploadCoverLetter: !!p.uploadCoverLetter
    };
}

const PAGE_TO_EXT = {
    JOB_APPLY_BIDDER_SAVE_PREFS: 'BIDDER_SAVE_PREFS'
};

const patch = prefsToExtensionPatch({
    unattended: true,
    captchaFocus: true,
    capsolverApiKey: ' CAP-x ',
    uploadCoverLetter: true
});
const payload = processQueuePrefsPayload({
    unattended: true,
    captchaHelper: true,
    capsolverApiKey: 'CAP-p',
    twocaptchaApiKey: 'x'
});
const patchCustom = prefsToExtensionPatch({ humanAssistWaitSec: 120 });
const payloadZero = processQueuePrefsPayload({ humanAssistWaitSec: 0 });

const checks = [
    ['AFK clears captchaFocus in ext patch', patch.bidderCaptchaFocus === false],
    ['ext clears capsolver', patch.bidderCapsolverApiKey === ''],
    ['ext clears 2captcha', patch.bidderTwocaptchaApiKey === ''],
    ['cover letter', patch.bidderUploadCoverLetter === true],
    ['helper wait default 90', patch.bidderCaptchaHelperWaitSec === 90],
    ['grace equals human wait', patch.bidderCaptchaGraceSec === 90],
    ['human assist key set', patch.bidderHumanAssistWaitSec === 90],
    ['process grace = wait', payload.captchaGraceSec === 90],
    ['process helper wait = wait', payload.captchaHelperWaitSec === 90],
    ['process humanAssistWaitSec', payload.humanAssistWaitSec === 90],
    ['custom wait 120', patchCustom.bidderHumanAssistWaitSec === 120],
    ['zero wait allowed', payloadZero.humanAssistWaitSec === 0],
    ['process omits capsolver', payload.capsolverApiKey === undefined],
    ['process omits 2captcha', payload.twocaptchaApiKey === undefined],
    ['process helper forced on', payload.captchaHelper === true],
    ['process sends autoNext', payload.autoNext === true],
    ['process sends autoSubmit', payload.autoSubmit === true],
    ['SAVE_PREFS maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_SAVE_PREFS === 'BIDDER_SAVE_PREFS'],
    ['routes admin', '/admin/autofill-settings'.includes('autofill-settings')],
    ['routes user', '/user/autofill-settings'.includes('autofill-settings')]
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} lumi prefs checks passed.`);
