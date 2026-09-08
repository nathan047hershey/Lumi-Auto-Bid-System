/**
 * CAPTCHA pass engineer heuristics (mirrors classifyCaptchaOrLogin).
 * Run: node extension/fixtures/test_captcha_pass.js
 */
import { classifyCaptchaOrLogin, isBlockingCaptchaWall } from '../lib/captchaPass.js';

const checks = [];

checks.push([
    'recaptcha widget',
    classifyCaptchaOrLogin({ text: 'apply now', html: '<div class="g-recaptcha"></div>', hasWidget: true }).captcha === true
]);
checks.push([
    'cloudflare copy',
    classifyCaptchaOrLogin({ text: 'Checking your browser before accessing careers…', html: '' }).captcha === true
]);
checks.push([
    'turnstile token + challenge',
    classifyCaptchaOrLogin({
        text: 'Please verify you are human',
        html: 'cf-turnstile data-sitekey=abc'
    }).captcha === true
]);
checks.push([
    'arkose mentioned',
    classifyCaptchaOrLogin({
        text: 'security challenge',
        html: 'arkoselabs funcaptcha'
    }).captcha === true
]);
checks.push([
    'normal apply form not captcha',
    classifyCaptchaOrLogin({
        text: 'First Name Email Address Submit Application',
        html: '<form><input name="email"></form>'
    }).captcha === false
]);
checks.push([
    'login wall',
    classifyCaptchaOrLogin({
        text: 'Please log in to continue. Candidate Sign In. Create an account.',
        html: '<form><input type="email"><input type="password" name="password"></form>'
    }).login === true
]);
checks.push([
    'apply form with sign-in word not login wall',
    classifyCaptchaOrLogin({
        text: 'First Name Email Address Submit Application Sign in with Google optional',
        html: '<form><input name="email"></form>'
    }).login === false
]);
checks.push([
    'careers JD Sign In header is not login wall',
    classifyCaptchaOrLogin({
        text: 'Sign In Search for Jobs Staff Software Engineer US Remote Full time Apply Decline Accept Cookies',
        html: '<header><a href="/signin">Sign In</a></header><button>Apply</button>'
    }).login === false
]);
checks.push([
    'oracle-ish human check',
    classifyCaptchaOrLogin({
        text: 'Prove you are a human to continue your application',
        html: ''
    }).captcha === true
]);

{
    const passive = classifyCaptchaOrLogin({
        text: 'First Name Email Address Submit Application',
        html: '<div class="g-recaptcha" data-sitekey="x"></div>',
        hasWidget: true
    });
    checks.push(['passive widget is captcha', passive.captcha === true]);
    checks.push([
        'passive widget NOT blocking when form ready',
        isBlockingCaptchaWall(passive, { formReady: true }) === false
    ]);
    checks.push([
        'passive widget NOT blocking before form (keep polling)',
        isBlockingCaptchaWall(passive, { formReady: false }) === false
    ]);
    checks.push([
        'passive widget IS blocking before submit when helper on',
        isBlockingCaptchaWall(passive, { formReady: true, forSubmit: true, captchaHelper: true }) === true
    ]);
    const solved = classifyCaptchaOrLogin({
        text: 'First Name Email Address Submit Application',
        html: '<div class="g-recaptcha" data-sitekey="x"></div>',
        hasWidget: true,
        widgetSolved: true
    });
    checks.push(['solved widget not captcha', solved.captcha === false]);
    checks.push([
        'solved widget not blocking for submit',
        isBlockingCaptchaWall(solved, { formReady: true, forSubmit: true, captchaHelper: true }) === false
    ]);
}
{
    const wall = classifyCaptchaOrLogin({
        text: 'Checking your browser before accessing careers… Just a moment',
        html: ''
    });
    checks.push([
        'cloudflare interstitial IS blocking',
        isBlockingCaptchaWall(wall, { formReady: false }) === true
    ]);
}
{
    const hard = classifyCaptchaOrLogin({
        text: 'Apply for this job First Name Email',
        html: '<div id="cf-challenge-running"></div>',
        hasWidget: false
    });
    // Force vendor cloudflare-ish via challenge — if no widget/copy may be generic
    const fakeHard = { ...hard, captcha: true, vendor: 'datadome', widgetHit: false, challengeCopy: false };
    checks.push([
        'hard vendor without widget still blocks when formReady',
        isBlockingCaptchaWall(fakeHard, { formReady: true }) === true
    ]);
    const fakeWidget = { ...fakeHard, widgetHit: true };
    checks.push([
        'hard vendor with on-form widget does not block fill',
        isBlockingCaptchaWall(fakeWidget, { formReady: true }) === false
    ]);
}
{
    const login = classifyCaptchaOrLogin({
        text: 'Please log in to continue. Candidate Sign In. Enter your password.',
        html: '<form><input type="password" name="password"></form>'
    });
    checks.push([
        'login wall IS blocking even with formReady',
        isBlockingCaptchaWall(login, { formReady: true }) === true
    ]);
}
{
    // Real Greenhouse apply: reCAPTCHA badge + "I'm not a robot" must NOT stall fill.
    const gh = classifyCaptchaOrLogin({
        text: 'Apply for this job First Name * Last Name * Email * I\'m not a robot Submit Application',
        html: '<form><input name="first_name"><div class="g-recaptcha" data-sitekey="x"></div></form>',
        hasWidget: true
    });
    checks.push(['gh form+robot copy still captcha signal', gh.captcha === true]);
    checks.push(['gh form+robot copy is NOT hard challengeCopy', gh.challengeCopy === false]);
    checks.push([
        'gh form+robot NOT blocking when form ready → start fill',
        isBlockingCaptchaWall(gh, { formReady: true }) === false
    ]);
    checks.push([
        'gh form+robot still pauses at submit with helper',
        isBlockingCaptchaWall(gh, { formReady: true, forSubmit: true, captchaHelper: true }) === true
    ]);
}

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} captcha-pass checks passed.`);
