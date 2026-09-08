/**
 * Drive captcha extract + inject against the local fixture via browser-automation.
 * Seeds page callbacks first (fixture inline scripts may not run under file://).
 */
import {
    extractCaptchaTargetInPage,
    injectCaptchaTokenInPage
} from '../lib/captchaSolver.js';

export default async function (page) {
    await page.evaluate(() => {
        window.__cbFired = false;
        window.onCaptchaOk = function (t) {
            window.__cbFired = true;
            window.__cbToken = t;
        };
        window.grecaptcha = {
            getResponse: function () { return ''; }
        };
    });

    const extracted = await page.evaluate(extractCaptchaTargetInPage);
    const FAKE = '03AGdBq25FAKE_TOKEN_FOR_INJECT_TEST_XXXXXXXXXXXXXXXXXXXXXXXX';
    const injected = await page.evaluate(injectCaptchaTokenInPage, ['recaptcha', FAKE]);
    const after = await page.evaluate(() => ({
        val: document.querySelector('textarea[name="g-recaptcha-response"]')?.value || '',
        cb: window.__cbFired === true,
        cbTok: window.__cbToken || '',
        grec: typeof window.grecaptcha?.getResponse === 'function' ? window.grecaptcha.getResponse() : ''
    }));
    const ok =
        extracted.sitekey === '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI'
        && extracted.vendor === 'recaptcha'
        && injected?.ok === true
        && after.val === FAKE
        && after.cb === true
        && after.cbTok === FAKE
        && after.grec === FAKE;
    return { ok, extracted, injected, after };
}
