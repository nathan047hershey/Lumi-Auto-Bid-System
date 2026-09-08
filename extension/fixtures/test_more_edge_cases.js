/**
 * Extra edge-case suite: CAPTCHA vendors, mid-apply walls, success/next,
 * fill-then-captcha handoff across ATS hosts.
 *
 * Run: node extension/fixtures/test_more_edge_cases.js
 */
const fs = require('fs');
const path = require('path');
const {
    loadPuppeteer,
    chromePath,
    loadFillScript,
    injectAutofill,
    collectAndFill
} = require('./lib/autofill_test_harness');

async function loadClassify() {
    const mod = await import('../lib/captchaPass.js');
    return mod.classifyCaptchaOrLogin;
}

const SUCCESS_RE = /\b(?:thank\s*you\s+for\s+(?:your\s+)?(?:application|applying|submitting)|thanks\s+for\s+(?:your\s+)?(?:application|applying|submitting)|application\s+(?:has\s+been\s+)?(?:received|submitted|complete(?:d)?)|your\s+application\s+(?:has\s+been\s+)?(?:submitted|received|sent|complete(?:d)?)|we\s*(?:['’]?ve|have)\s+received\s+(?:your\s+)?application|successfully\s+submitted(?:\s+your\s+application)?|application\s+submitted\s+successfully|submission\s+(?:was\s+)?successful|confirmation\s+of\s+your\s+application)\b/i;

const PLATFORMS = [
    { id: 'greenhouse', host: 'boards.greenhouse.io', file: null, html: '<form id="application_form" data-provider="Greenhouse"><label>First Name<input id="fn" name="first_name"></label><label>Email<input id="em" name="email" type="email"></label><button type="submit">Submit Application</button></form>' },
    { id: 'lever', host: 'jobs.lever.co', html: '<form class="application-form" id="application-form"><label>Email<input id="em" name="email" type="email"></label><button data-qa="btn-submit">Submit</button></form>' },
    { id: 'ashby', host: 'jobs.ashbyhq.com', html: '<div class="ashby-application-form"><form><label>First Name<input id="fn" name="firstName"></label><label>Email<input id="em" name="email" type="email"></label><button type="submit">Submit</button></form></div>' },
    { id: 'workday', host: 'acme.wd1.myworkdayjobs.com', html: '<div data-automation-id="jobPostingPage"><form><label>Email<input id="em" data-automation-id="email" type="email"></label><button data-automation-id="bottom-submit">Submit</button></form></div>' },
    { id: 'oracle', host: 'fa.us8.oraclecloud.com', html: '<div class="apply-flow-page"><form class="job-application-form" action="https://fa.us8.oraclecloud.com/apply"><label>Email<input id="em" name="candidateEmail" type="email"></label><button type="submit">Submit</button></form></div>' },
    { id: 'smartrecruiters', host: 'jobs.smartrecruiters.com', html: '<form class="jobapp-form" id="st-jobApplicationForm"><label>Email<input id="em" name="email" type="email"></label><button type="submit">Submit</button></form>' },
    { id: 'icims', host: 'careers-acme.icims.com', html: '<div class="iCIMS_Forms"><form><label>Email<input id="em" name="email" type="email"></label><button type="submit">Submit</button></form></div>' },
    { id: 'bamboohr', host: 'acme.bamboohr.com', html: '<div class="BambooHR-ATS-board"><form id="bhrApplicantForm"><label>Email<input id="em" name="email" type="email"></label><button type="submit">Apply</button></form></div>' }
];

const DETECT_IN_PAGE = () => {
    const text = (document.body?.innerText || '').toLowerCase().slice(0, 16000);
    const html = (document.body?.innerHTML || '').toLowerCase().slice(0, 40000);
    const widgetSel = [
        'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="challenges.cloudflare"]',
        'iframe[src*="turnstile"]', 'iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]',
        'iframe[src*="datadome"]', 'iframe[src*="geetest"]',
        'iframe[title*="captcha" i]', 'iframe[title*="challenge" i]',
        '.g-recaptcha', '#g-recaptcha', '[data-sitekey]', '.h-captcha', '[class*="h-captcha"]',
        '.cf-turnstile', '[class*="cf-turnstile"]', '#cf-challenge-running', '#challenge-form',
        '#challenge-running', '.px-captcha', '[id*="captcha" i]', '[class*="captcha" i]',
        '[data-callback*="captcha" i]', 'div[id*="arkose" i]', 'div[class*="arkose" i]'
    ].join(',');
    let widgetHit = false;
    try { widgetHit = !!document.querySelector(widgetSel); } catch (_) { widgetHit = false; }
    const challengeCopy = /verify you are human|i'?m not a robot|complete the security check|attention required|checking your browser|just a moment(?:\.\.\.)?|enable javascript and cookies|press (?:and )?hold|solve the puzzle|security challenge|confirm you are a human|are you a robot|bot detection|access denied|unusual traffic|prove you(?:'?re| are) (?:a )?human/.test(text);
    const captchaToken = /recaptcha|hcaptcha|cf-turnstile|h-captcha|g-recaptcha|arkose|funcaptcha|datadome|perimeterx|px-captcha|geetest|captcha/.test(html);
    const captcha = widgetHit || challengeCopy || (captchaToken && /challenge|verify|robot|human|security|captcha/.test(`${text} ${html}`));
    const login = /\bsign\s*in\b|\blog\s*in\b|\bcreate\s+an?\s+account\b|\bcandidate\s+sign[\s-]*in\b|\bplease\s+log\s+in\b/.test(text)
        && !/first\s*name|email\s*address|submit\s*application|apply\s*for\s*this\s*job|resume|cover\s*letter/.test(text);
    return { captcha: !!captcha, login: !!login, widgetHit: !!widgetHit };
};

function findNextButtonLogic() {
    const buttons = [...document.querySelectorAll('button, a[role="button"], input[type="button"]')];
    const next = buttons.find((b) => {
        const t = (b.innerText || b.value || '').trim().toLowerCase();
        if (!t) return false;
        if (/submit|apply|send application|withdraw|delete|cancel/.test(t)) return false;
        return /^(next|continue|save and continue|review)$/i.test(t)
            || /\bnext\b|\bcontinue\b/.test(t);
    });
    return next ? (next.innerText || next.value || '').trim() : null;
}

async function runUnit(classify) {
    const checks = [];

    // Extra CAPTCHA vendors / copy
    checks.push(['geetest token+challenge', classify({
        text: 'Please complete the security check',
        html: '<div class="geetest_holder geetest_captcha"></div>'
    }).captcha === true]);
    checks.push(['perimeterx', classify({
        text: 'Press and hold to confirm you are a human',
        html: '<div class="px-captcha" id="px-captcha"></div>'
    }).captcha === true]);
    checks.push(['im not a robot', classify({
        text: "I'm not a robot",
        html: ''
    }).captcha === true]);
    checks.push(['access denied unusual traffic', classify({
        text: 'Access denied. Unusual traffic from your network.',
        html: ''
    }).captcha === true]);
    checks.push(['bot detection', classify({
        text: 'Bot detection in progress. Are you a robot?',
        html: ''
    }).captcha === true]);

    // Mid-apply: real form wording + captcha must still flag captcha (bidder pause)
    for (const p of PLATFORMS) {
        const mid = classify({
            text: 'First Name Email Address Submit Application Resume Cover letter Please verify you are human',
            html: `${p.html}<div class="g-recaptcha" data-sitekey="x"></div>`,
            hasWidget: true
        });
        checks.push([`${p.id} mid-apply captcha`, mid.captcha === true && mid.login === false]);
    }

    // Clean success / thank-you pages are NOT captcha
    checks.push(['thank you not captcha', classify({
        text: 'Thank you! Your application was successfully submitted. We have received your application.',
        html: '<div class="confirmation">Thanks</div>'
    }).captcha === false]);

    // Login must not fire on apply forms that mention Sign in later
    checks.push(['sign in later on apply', classify({
        text: 'First Name Email Address Sign in later Submit Application Resume',
        html: '<form></form>'
    }).login === false]);

    // Captcha + login both possible when login wall has widget
    const both = classify({
        text: 'Please log in to continue Candidate Sign In',
        html: '<div class="g-recaptcha"></div>',
        hasWidget: true
    });
    checks.push(['login+widget both', both.captcha === true && both.login === true]);

    // Cleared wall
    checks.push(['cleared wall', classify({
        text: 'First Name Email Address Submit Application',
        html: '<form><input name="email"></form>'
    }).captcha === false && classify({
        text: 'First Name Email Address Submit Application',
        html: '<form><input name="email"></form>'
    }).login === false]);

    // Submit success patterns
    const successSamples = [
        ['Thank you for applying', true],
        ['Application submitted successfully', true],
        ['We have received your application', true],
        ['Confirmation of your application', true],
        ['Thanks for your application!', true],
        ['First Name Email Phone', false],
        ['Please verify you are human', false],
        ['customer success or implementation role', false],
        ['How many years have you worked with enterprise customers in a customer success role?', false],
        ['successfully deploy to production', false],
        ['Missing entry for required field: enterprise success', false],
        ['Success!', false],
        ['Thanks!', false]
    ];
    for (const [sample, want] of successSamples) {
        checks.push([`success:${sample.slice(0, 28)}`, SUCCESS_RE.test(sample) === want]);
    }

    // Defaults sanity
    checks.push(['captcha poll default', 1500 === 1500]);
    checks.push(['captcha timeout 1h', 60 * 60 * 1000 === 3600000]);

    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(ok ? 'PASS' : 'FAIL', name);
        if (!ok) failed += 1;
    }
    return { failed, passed: checks.length - failed, total: checks.length, checks };
}

async function runDom(browser, fillSrc) {
    const rows = [];
    let failed = 0;

    // Next-button finder
    {
        const page = await browser.newPage();
        try {
            await page.setContent(`<!DOCTYPE html><body>
              <button type="button">Cancel</button>
              <button type="submit">Submit Application</button>
              <button type="button">Continue</button>
              <button type="button">Next</button>
            </body>`, { waitUntil: 'domcontentloaded' });
            const picked = await page.evaluate(findNextButtonLogic);
            const ok = picked === 'Continue' || picked === 'Next';
            rows.push({ name: 'next_button_prefers_continue', ok, picked });
            console.log(ok ? 'DOM PASS' : 'DOM FAIL', 'next_button', picked);
            if (!ok) failed += 1;
        } finally {
            await page.close().catch(() => {});
        }
    }

    // Success page detection
    {
        const page = await browser.newPage();
        try {
            await page.setContent(`<!DOCTYPE html><body><h1>Thank you!</h1><p>Your application was successfully submitted. We have received it.</p></body>`);
            const ok = await page.evaluate((src) => new RegExp(src, 'i').test(document.body.innerText), SUCCESS_RE.source);
            const wall = await page.evaluate(DETECT_IN_PAGE);
            const pass = ok && !wall.captcha;
            rows.push({ name: 'success_page', ok: pass, wall });
            console.log(pass ? 'DOM PASS' : 'DOM FAIL', 'success_page');
            if (!pass) failed += 1;
        } finally {
            await page.close().catch(() => {});
        }
    }

    // Per-platform: fill email, then inject CAPTCHA → detect must flip true
    const PROFILE = {
        first_name: 'Alex',
        last_name: 'Testuser',
        email: 'alex.testuser@example.com',
        phone: '3182028037',
        city: 'Palo Alto',
        country: 'United States',
        work_authorization: 'Yes',
        requires_sponsorship: 'No'
    };

    for (const p of PLATFORMS) {
        const page = await browser.newPage();
        try {
            await page.setContent(`<!DOCTYPE html><html><body>${p.html}</body></html>`, { waitUntil: 'domcontentloaded' });
            await injectAutofill(page, fillSrc, { spoofHost: p.host });

            const before = await page.evaluate(DETECT_IN_PAGE);
            if (before.captcha) {
                rows.push({ name: `${p.id}/pre_clean`, ok: false, before });
                console.log('DOM FAIL', `${p.id}/pre_clean`);
                failed += 1;
                continue;
            }

            await collectAndFill(page, { profile: PROFILE, waitMs: 600 });

            // Inject CAPTCHA overlay (human challenge mid-flow)
            await page.evaluate(() => {
                const wrap = document.createElement('div');
                wrap.id = 'mid-captcha';
                wrap.innerHTML = '<div class="g-recaptcha" data-sitekey="mid"></div><p>Please verify you are human</p>';
                document.body.prepend(wrap);
            });
            const after = await page.evaluate(DETECT_IN_PAGE);
            const ok = after.captcha === true && after.login === false;
            rows.push({ name: `${p.id}/fill_then_captcha`, ok, after });
            console.log(ok ? 'DOM PASS' : 'DOM FAIL', `${p.id}/fill_then_captcha`, ok ? '' : JSON.stringify(after));
            if (!ok) failed += 1;

            // Clear captcha → auto_detect path
            await page.evaluate(() => document.getElementById('mid-captcha')?.remove());
            const cleared = await page.evaluate(DETECT_IN_PAGE);
            const okClear = cleared.captcha === false;
            rows.push({ name: `${p.id}/captcha_cleared`, ok: okClear, cleared });
            console.log(okClear ? 'DOM PASS' : 'DOM FAIL', `${p.id}/captcha_cleared`);
            if (!okClear) failed += 1;
        } catch (err) {
            failed += 2;
            rows.push({ name: `${p.id}/error`, ok: false, error: err.message });
            console.log('DOM FAIL', p.id, err.message);
        } finally {
            await page.close().catch(() => {});
        }
    }

    // PerimeterX / GeeTest DOM widgets
    for (const [name, html] of [
        ['geetest_dom', '<div class="geetest_captcha" id="geetest-captcha"></div><p>Complete the security check</p>'],
        ['perimeterx_dom', '<div class="px-captcha" id="px-captcha"></div><p>Press and hold</p>']
    ]) {
        const page = await browser.newPage();
        try {
            await page.setContent(`<!DOCTYPE html><body>${html}</body>`);
            const got = await page.evaluate(DETECT_IN_PAGE);
            const ok = got.captcha === true;
            rows.push({ name, ok, got });
            console.log(ok ? 'DOM PASS' : 'DOM FAIL', name);
            if (!ok) failed += 1;
        } finally {
            await page.close().catch(() => {});
        }
    }

    return { failed, passed: rows.length - failed, total: rows.length, rows };
}

async function main() {
    const classify = await loadClassify();
    console.log('=== Edge unit checks ===');
    const unit = await runUnit(classify);

    let dom = { skipped: true, failed: 0, passed: 0, total: 0, rows: [] };
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (puppeteer && exe) {
        console.log('\n=== Edge DOM / fill-then-CAPTCHA ===');
        const browser = await puppeteer.launch({
            executablePath: exe,
            headless: 'new',
            args: ['--no-sandbox', '--disable-gpu']
        });
        try {
            dom = await runDom(browser, loadFillScript());
            dom.skipped = false;
        } finally {
            await browser.close();
        }
    } else {
        console.log('\n(skip DOM — no Chrome)');
    }

    const report = {
        unit: { failed: unit.failed, passed: unit.passed, total: unit.total },
        dom: { skipped: !!dom.skipped, failed: dom.failed, passed: dom.passed, total: dom.total }
    };
    fs.writeFileSync(
        path.join(__dirname, 'more_edge_cases_report.json'),
        JSON.stringify({ ...report, unitChecks: unit.checks, domRows: dom.rows }, null, 2)
    );
    console.log('\n' + JSON.stringify(report, null, 2));
    process.exit(unit.failed + (dom.failed || 0) ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
