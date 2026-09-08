/**
 * CAPTCHA assist unit smoke (DOM-less checks on export shape).
 * Run: node extension/fixtures/test_captcha_assist.js
 */
import { assistCaptchaInFrame } from '../lib/captchaAssist.js';

const checks = [];
function check(name, ok) {
    checks.push([name, !!ok]);
}

check('assistCaptchaInFrame is function', typeof assistCaptchaInFrame === 'function');

// Minimal jsdom-less: call would throw without document — ensure we don't export broken
check('function length 1', assistCaptchaInFrame.length === 1);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} captcha-assist checks passed.`);
