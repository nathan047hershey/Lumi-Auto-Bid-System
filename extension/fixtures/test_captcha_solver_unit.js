/**
 * High-success captchaSolver tests.
 * Run: node extension/fixtures/test_captcha_solver_unit.js
 */
import {
    isSolvableVendor,
    resolveSolverProvider,
    capsolverTaskType,
    extractToken,
    buildSolveAttempts,
    solveWithCapSolver,
    solveWith2Captcha
} from '../lib/captchaSolver.js';

const checks = [];
function check(name, ok) {
    checks.push([name, !!ok]);
}

check('recaptcha solvable', isSolvableVendor('recaptcha'));
check('recaptcha_v3 solvable', isSolvableVendor('recaptcha_v3'));
check('arkose solvable', isSolvableVendor('arkose'));
check('geetest solvable', isSolvableVendor('geetest'));
check('login not solvable', !isSolvableVendor('login'));
check('prefer capsolver', resolveSolverProvider({ capsolverApiKey: 'CAP-x', twocaptchaApiKey: '2c' }) === 'capsolver');
check('task v2', capsolverTaskType('recaptcha') === 'ReCaptchaV2TaskProxyLess');
check('task v2 enterprise', capsolverTaskType('recaptcha', { enterprise: true }) === 'ReCaptchaV2EnterpriseTaskProxyLess');
check('task v3', capsolverTaskType('recaptcha', { v3: true }) === 'ReCaptchaV3TaskProxyLess');
check('task turnstile', capsolverTaskType('turnstile') === 'AntiTurnstileTaskProxyLess');
check('task arkose', capsolverTaskType('arkose') === 'FunCaptchaTaskProxyLess');
check('extractToken', extractToken({ gRecaptchaResponse: 'tok' }, 'recaptcha') === 'tok');

{
    const attempts = buildSolveAttempts({
        pageUrl: 'https://boards.greenhouse.io/x/jobs/1',
        sitekey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
        sitekeys: ['6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI'],
        vendor: 'recaptcha',
        enterprise: false,
        invisible: false,
        v3: false,
        action: ''
    }, { vendor: 'recaptcha' });
    check('attempts built', attempts.length >= 3);
    check('attempts include v2', attempts.some((a) => a.label.includes('recaptcha_v2')));
    check('attempts include enterprise fallback', attempts.some((a) => /enterprise/i.test(a.label)));
    check('attempts include v3 fallback', attempts.some((a) => /v3/i.test(a.label)));
}

{
    const attempts = buildSolveAttempts({
        pageUrl: 'https://example.com',
        sitekey: 'pk-arkose',
        sitekeys: ['pk-arkose'],
        vendor: 'arkose',
        arkosePublicKey: 'pk-arkose'
    }, { vendor: 'arkose' });
    check('arkose attempt', attempts.length >= 1 && attempts[0].vendor === 'arkose');
}

{
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errorId: 1, errorCode: 'ERROR_KEY_DENIED_ACCESS', errorDescription: 'bad key' })
    });
    const r = await solveWithCapSolver({
        apiKey: 'CAP-fake',
        vendor: 'recaptcha',
        websiteURL: 'https://example.com/apply',
        websiteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
        timeoutMs: 5000
    });
    globalThis.fetch = origFetch;
    check('capsolver bad key', r.ok === false);
}

{
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
            errorId: 0,
            status: 'ready',
            solution: { gRecaptchaResponse: 'SYNC_TOKEN_ABCDEFGHIJKLMNOP' }
        })
    });
    const r = await solveWithCapSolver({
        apiKey: 'CAP-ok',
        vendor: 'recaptcha',
        websiteURL: 'https://example.com/apply',
        websiteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
        timeoutMs: 5000
    });
    globalThis.fetch = origFetch;
    check('capsolver sync ready', r.ok && r.token === 'SYNC_TOKEN_ABCDEFGHIJKLMNOP');
}

{
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ status: 0, request: 'ERROR_WRONG_USER_KEY' })
    });
    const r = await solveWith2Captcha({
        apiKey: 'bad',
        vendor: 'recaptcha',
        websiteURL: 'https://example.com/apply',
        websiteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI',
        timeoutMs: 5000
    });
    globalThis.fetch = origFetch;
    check('2captcha bad key', !r.ok && r.error === 'ERROR_WRONG_USER_KEY');
}

{
    try {
        const res = await fetch('https://api.capsolver.com/createTask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientKey: 'CAP-INVALID-SMOKE-TEST',
                task: {
                    type: 'ReCaptchaV2TaskProxyLess',
                    websiteURL: 'https://example.com',
                    websiteKey: '6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI'
                }
            })
        });
        const data = await res.json();
        check('capsolver API reachable', !!(data && (data.errorId > 0 || data.errorCode || data.taskId)));
    } catch {
        check('capsolver API reachable', false);
    }
}

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} high-success captcha-solver checks passed.`);
