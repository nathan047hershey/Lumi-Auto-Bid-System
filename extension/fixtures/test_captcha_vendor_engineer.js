/**
 * CAPTCHA vendor engineer — all vendors.
 * Run: node extension/fixtures/test_captcha_vendor_engineer.js
 */
import {
    ALL_CAPTCHA_VENDORS,
    CAPTCHA_EXTENSION_CATALOG,
    classifyCaptchaOrLogin,
    detectCaptchaVendor,
    captchaStrategyForVendor,
    vendorLabel,
    recommendHelpersForVendor
} from '../lib/captchaPass.js';

const checks = [];

checks.push(['all vendors listed', ALL_CAPTCHA_VENDORS.length >= 14]);
checks.push(['catalog size', CAPTCHA_EXTENSION_CATALOG.length >= 4]);

const detectCases = [
    ['recaptcha', { html: '<div class="g-recaptcha">' }],
    ['hcaptcha', { html: '<div class="h-captcha">' }],
    ['turnstile', { html: '<div class="cf-turnstile">' }],
    ['arkose', { html: 'arkoselabs funcaptcha' }],
    ['datadome', { html: 'datadome challenge' }],
    ['perimeterx', { html: 'px-captcha' }],
    ['geetest', { html: 'geetest_captcha' }],
    ['aws_waf', { html: 'captcha.awswaf.com amazon waf' }],
    ['mtcaptcha', { html: 'mtcaptcha widget' }],
    ['keycaptcha', { html: 'keycaptcha' }],
    ['friendly', { html: 'friendly-challenge' }],
    ['lemin', { html: 'lemin captcha' }],
    ['cloudflare', { text: 'Checking your browser before accessing' }]
];

for (const [want, sig] of detectCases) {
    checks.push([`detect ${want}`, detectCaptchaVendor(sig) === want]);
}

for (const v of ['recaptcha', 'hcaptcha', 'turnstile', 'arkose', 'datadome', 'geetest', 'aws_waf', 'generic']) {
    const withHelper = captchaStrategyForVendor(v, { captchaHelper: true });
    checks.push([`${v} helper ON → wait`, withHelper.id === 'helper_wait' && withHelper.unattendedWaitMs >= 60000]);
}

checks.push([
    'hcaptcha helper OFF → skip',
    captchaStrategyForVendor('hcaptcha', { captchaHelper: false }).id === 'skip_fast'
]);
checks.push([
    'arkose helper OFF → skip',
    captchaStrategyForVendor('arkose', { captchaHelper: false }).id === 'skip_fast'
]);
checks.push([
    'login human',
    captchaStrategyForVendor('login', { login: true }).id === 'human'
]);

checks.push(['recommend recaptcha', recommendHelpersForVendor('recaptcha').some((e) => e.id === 'buster')]);
checks.push(['recommend turnstile', recommendHelpersForVendor('turnstile').some((e) => e.id === 'nopecha')]);
checks.push(['label aws', /AWS/i.test(vendorLabel('aws_waf'))]);

const classified = classifyCaptchaOrLogin({
    text: 'Please verify you are human',
    html: '<div class="cf-turnstile"></div>',
    hasWidget: true,
    captchaHelper: true
});
checks.push(['classify turnstile', classified.vendor === 'turnstile' && classified.strategy === 'helper_wait']);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} captcha-vendor-engineer checks passed.`);
