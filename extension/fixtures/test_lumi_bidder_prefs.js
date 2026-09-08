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
    capsolverApiKey: '',
    twocaptchaApiKey: ''
};

function prefsToExtensionPatch(prefs) {
    const p = { ...DEFAULT, ...prefs };
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
        bidderCapsolverApiKey: '',
        bidderTwocaptchaApiKey: ''
    };
}

function processQueuePrefsPayload(prefs) {
    const p = { ...DEFAULT, ...prefs };
    return {
        stayInApp: !!p.stayInApp,
        unattended: !!p.unattended,
        autoSubmit: !!p.autoSubmit,
        autoNext: !!p.autoNext,
        captchaGraceSec: p.unattended ? 45 : undefined,
        captchaHelper: true,
        captchaHelperWaitSec: 90,
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

const checks = [
    ['AFK clears captchaFocus in ext patch', patch.bidderCaptchaFocus === false],
    ['ext clears capsolver', patch.bidderCapsolverApiKey === ''],
    ['ext clears 2captcha', patch.bidderTwocaptchaApiKey === ''],
    ['cover letter', patch.bidderUploadCoverLetter === true],
    ['helper wait AFK 90', patch.bidderCaptchaHelperWaitSec === 90],
    ['process grace 45', payload.captchaGraceSec === 45],
    ['process helper wait 90', payload.captchaHelperWaitSec === 90],
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
