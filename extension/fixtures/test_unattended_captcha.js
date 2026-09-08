/**
 * Unattended CAPTCHA policy (chrome-free).
 * Run: node extension/fixtures/test_unattended_captcha.js
 */
import { BIDDER_DEFAULTS } from '../lib/bidderQueue.js';

function resolveCaptchaWaitMs({ unattended, captchaGraceMs, captchaFocus, captchaTimeoutMs }) {
    if (unattended) {
        const g = Number(captchaGraceMs);
        return Number.isFinite(g) && g >= 0 ? g : BIDDER_DEFAULTS.captchaGraceMs;
    }
    if (captchaFocus === false) return 0;
    return captchaTimeoutMs ?? BIDDER_DEFAULTS.captchaTimeoutMs;
}

function shouldAbandonUnattended({ unattended, cleared, graceElapsed, graceMs }) {
    if (!unattended || cleared) return false;
    return graceElapsed >= graceMs;
}

const checks = [];
checks.push(['defaults unattended off', BIDDER_DEFAULTS.unattended === false]);
checks.push(['defaults grace 45s', BIDDER_DEFAULTS.captchaGraceMs === 45000]);
checks.push(['defaults attended timeout 1h', BIDDER_DEFAULTS.captchaTimeoutMs === 3600000]);

checks.push([
    'unattended uses grace',
    resolveCaptchaWaitMs({ unattended: true, captchaGraceMs: 45000, captchaFocus: true }) === 45000
]);
checks.push([
    'unattended zero grace',
    resolveCaptchaWaitMs({ unattended: true, captchaGraceMs: 0, captchaFocus: true }) === 0
]);
checks.push([
    'attended long wait',
    resolveCaptchaWaitMs({
        unattended: false,
        captchaFocus: true,
        captchaTimeoutMs: BIDDER_DEFAULTS.captchaTimeoutMs
    }) === BIDDER_DEFAULTS.captchaTimeoutMs
]);
checks.push([
    'attended focus off = no wait',
    resolveCaptchaWaitMs({ unattended: false, captchaFocus: false }) === 0
]);
checks.push([
    'abandon after grace',
    shouldAbandonUnattended({
        unattended: true,
        cleared: false,
        graceElapsed: 45000,
        graceMs: 45000
    }) === true
]);
checks.push([
    'no abandon if cleared',
    shouldAbandonUnattended({
        unattended: true,
        cleared: true,
        graceElapsed: 45000,
        graceMs: 45000
    }) === false
]);
checks.push([
    'no abandon attended',
    shouldAbandonUnattended({
        unattended: false,
        cleared: false,
        graceElapsed: 45000,
        graceMs: 45000
    }) === false
]);

checks.push(['defaults helper on', BIDDER_DEFAULTS.captchaHelper === true]);
checks.push(['defaults helper wait 90s', BIDDER_DEFAULTS.captchaHelperWaitMs === 90 * 1000]);

function resolveUnattendedWaitMs({ unattended, captchaHelper, captchaGraceMs, captchaHelperWaitMs }) {
    if (!unattended) return null;
    const base = Number(captchaGraceMs) >= 0 ? Number(captchaGraceMs) : BIDDER_DEFAULTS.captchaGraceMs;
    if (!captchaHelper) return base;
    const helper = Number(captchaHelperWaitMs) >= 0 ? Number(captchaHelperWaitMs) : BIDDER_DEFAULTS.captchaHelperWaitMs;
    return Math.max(base, helper);
}

checks.push([
    'helper stretches grace to 90s',
    resolveUnattendedWaitMs({
        unattended: true,
        captchaHelper: true,
        captchaGraceMs: 45000,
        captchaHelperWaitMs: 90 * 1000
    }) === 90 * 1000
]);
checks.push([
    'no helper keeps 45s',
    resolveUnattendedWaitMs({
        unattended: true,
        captchaHelper: false,
        captchaGraceMs: 45000,
        captchaHelperWaitMs: 90 * 1000
    }) === 45000
]);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} unattended-captcha checks passed.`);
