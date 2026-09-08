/**
 * CAPTCHA / login detection across all ATS platforms.
 * Unit matrix (no Chrome) + optional Puppeteer DOM widget checks.
 *
 * Run: node extension/fixtures/test_captcha_all_platforms.js
 */
const fs = require('fs');
const path = require('path');

// --- Mirror production classifyCaptchaOrLogin (CJS require via dynamic import) ---
async function loadClassify() {
    const mod = await import('../lib/captchaPass.js');
    return mod.classifyCaptchaOrLogin;
}

const PLATFORMS = [
    {
        id: 'greenhouse',
        host: 'boards.greenhouse.io',
        cleanText: 'First Name Last Name Email Address Phone Submit Application Apply for this job Resume Cover letter',
        cleanHtml: '<form id="application_form" data-provider="Greenhouse"><input name="email"><input name="first_name"></form>'
    },
    {
        id: 'lever',
        host: 'jobs.lever.co',
        cleanText: 'Full name Email Phone Submit application Apply for this job Resume',
        cleanHtml: '<form class="application-form" id="application-form"><input name="email"><button data-qa="btn-submit">Submit</button></form>'
    },
    {
        id: 'ashby',
        host: 'jobs.ashbyhq.com',
        cleanText: 'First Name Last Name Email Address Submit Application Resume Cover letter',
        cleanHtml: '<div class="ashby-application-form"><form><input name="email"><input name="firstName"></form></div>'
    },
    {
        id: 'workday',
        host: 'company.wd1.myworkdayjobs.com',
        cleanText: 'First Name Last Name Email Address Submit Application Apply for this job',
        cleanHtml: '<div data-automation-id="jobPostingPage"><form><input data-automation-id="email"><button data-automation-id="bottom-submit">Submit</button></form></div>'
    },
    {
        id: 'oracle',
        host: 'eihu.fa.us8.oraclecloud.com',
        cleanText: 'First Name Last Name Email Address Submit Application Apply for this job Resume',
        cleanHtml: '<div class="apply-flow-page"><form class="job-application-form" action="https://fa.us8.oraclecloud.com/hcmUI/apply"><input name="candidateEmail"></form></div>'
    },
    {
        id: 'smartrecruiters',
        host: 'jobs.smartrecruiters.com',
        cleanText: 'First name Last name Email Submit Application Resume Cover letter',
        cleanHtml: '<form class="jobapp-form" id="st-jobApplicationForm"><input name="email"></form>'
    },
    {
        id: 'icims',
        host: 'careers-company.icims.com',
        cleanText: 'First Name Last Name Email Address Submit Application Apply for this job',
        cleanHtml: '<div class="iCIMS_Forms"><form><input name="email"><input name="firstname"></form></div>'
    },
    {
        id: 'bamboohr',
        host: 'company.bamboohr.com',
        cleanText: 'First Name Last Name Email Submit Application Resume',
        cleanHtml: '<div class="BambooHR-ATS-board"><form id="bhrApplicantForm"><input name="email"></form></div>'
    },
    {
        id: 'generic',
        host: 'careers.example.com',
        cleanText: 'First Name Email Address Submit Application Apply for this job Resume Cover letter',
        cleanHtml: '<form id="careers-apply"><input name="email"><input name="first_name"></form>'
    },
    {
        id: 'linkedin',
        host: 'www.linkedin.com',
        cleanText: 'Phone Email Submit application Easy Apply',
        cleanHtml: '<div class="jobs-easy-apply-content"><form><input name="phoneNumber"></form></div>'
    }
];

/** CAPTCHA / wall variants applied on top of each platform clean page. */
const VARIANTS = [
    {
        name: 'clean_apply',
        expectCaptcha: false,
        expectLogin: false,
        patch: () => ({})
    },
    {
        name: 'recaptcha_widget',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div class="g-recaptcha" data-sitekey="test"></div>',
            hasWidget: true
        })
    },
    {
        name: 'hcaptcha_widget',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div class="h-captcha" data-sitekey="test"></div>',
            hasWidget: true
        })
    },
    {
        name: 'turnstile_widget',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div class="cf-turnstile" data-sitekey="test"></div>',
            textExtra: 'Please verify you are human',
            hasWidget: true
        })
    },
    {
        name: 'arkose_html',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div id="arkose-challenge" class="arkoselabs funcaptcha"></div>',
            textExtra: 'security challenge'
        })
    },
    {
        name: 'geetest_html',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div class="geetest_holder geetest_captcha"></div>',
            textExtra: 'Please complete the security check'
        })
    },
    {
        name: 'aws_waf_html',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div id="amzn-captcha-verify-container" data-aws-waf></div><iframe src="https://captcha.awswaf.com/x"></iframe>',
            textExtra: 'Human verification required'
        })
    },
    {
        name: 'mtcaptcha_html',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div class="mtcaptcha" data-sitekey="x"></div>',
            textExtra: 'Verify you are human'
        })
    },
    {
        name: 'cloudflare_challenge_copy',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            textExtra: 'Checking your browser before accessing the site. Just a moment...'
        })
    },
    {
        name: 'datadome_copy',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<div id="datadome-captcha" class="px-captcha"></div>',
            textExtra: 'Please verify you are human. Unusual traffic detected.'
        })
    },
    {
        name: 'oracle_human_prove',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            textExtra: 'Prove you are a human to continue your application'
        })
    },
    {
        name: 'login_wall',
        expectCaptcha: false,
        expectLogin: true,
        patch: () => ({
            // Replace clean apply wording so login heuristic can fire
            textOverride: 'Please log in to continue. Candidate Sign In. Enter your password.',
            htmlOverride: '<div class="login-wall"><form><input type="email"><input type="password"></form></div>'
        })
    },
    {
        name: 'recaptcha_iframe',
        expectCaptcha: true,
        expectLogin: false,
        patch: () => ({
            htmlExtra: '<iframe src="about:recaptcha#api2/anchor" title="reCAPTCHA"></iframe>',
            hasWidget: true
        })
    }
];

function buildSignals(platform, variant) {
    const p = variant.patch();
    const text = p.textOverride != null
        ? p.textOverride
        : `${platform.cleanText} ${p.textExtra || ''}`.trim();
    const html = p.htmlOverride != null
        ? p.htmlOverride
        : `${platform.cleanHtml}${p.htmlExtra || ''}`;
    return {
        text,
        html,
        hasWidget: !!p.hasWidget
    };
}

/** DOM detector — same selectors as bidderQueue.detectCaptchaOrLogin */
const DETECT_IN_PAGE = () => {
    const text = (document.body?.innerText || '').toLowerCase().slice(0, 16000);
    const html = (document.body?.innerHTML || '').toLowerCase().slice(0, 40000);
    const widgetSel = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'iframe[src*="challenges.cloudflare"]',
        'iframe[src*="turnstile"]',
        'iframe[src*="arkoselabs"]',
        'iframe[src*="funcaptcha"]',
        'iframe[src*="datadome"]',
        'iframe[src*="geetest"]',
        'iframe[src*="mtcaptcha"]',
        'iframe[src*="awswaf"]',
        'iframe[src*="amazon.com/aaut"]',
        'iframe[title*="captcha" i]',
        'iframe[title*="challenge" i]',
        '.g-recaptcha',
        '#g-recaptcha',
        '[data-sitekey]',
        '.h-captcha',
        '[class*="h-captcha"]',
        '.cf-turnstile',
        '[class*="cf-turnstile"]',
        '#cf-challenge-running',
        '#challenge-form',
        '#challenge-running',
        '.px-captcha',
        '[id*="captcha" i]',
        '[class*="captcha" i]',
        '[data-callback*="captcha" i]',
        'div[id*="arkose" i]',
        'div[class*="arkose" i]',
        '[class*="geetest"]',
        '[id*="geetest"]',
        '[class*="mtcaptcha"]',
        '[class*="friendly-challenge"]',
        '[class*="lemin"]',
        '#amzn-captcha-verify-container',
        '[id*="aws-waf"]'
    ].join(',');
    let widgetHit = false;
    try { widgetHit = !!document.querySelector(widgetSel); } catch (_) { widgetHit = false; }
    const challengeCopy = /verify you are human|i'?m not a robot|complete the security check|attention required|checking your browser|just a moment(?:\.\.\.)?|enable javascript and cookies|press (?:and )?hold|solve the puzzle|security challenge|confirm you are a human|are you a robot|bot detection|access denied|unusual traffic|prove you(?:'?re| are) (?:a )?human|aws waf|human verification/.test(text);
    const captchaToken = /recaptcha|hcaptcha|cf-turnstile|h-captcha|g-recaptcha|arkose|funcaptcha|datadome|perimeterx|px-captcha|geetest|mtcaptcha|keycaptcha|friendlycaptcha|lemin|awswaf|aws.?waf|captcha/.test(html);
    const captcha = widgetHit || challengeCopy || (captchaToken && /challenge|verify|robot|human|security|captcha/.test(`${text} ${html}`));
    const login = /\bsign\s*in\b|\blog\s*in\b|\bcreate\s+an?\s+account\b|\bcandidate\s+sign[\s-]*in\b|\bplease\s+log\s+in\b/.test(text)
        && !/first\s*name|email\s*address|submit\s*application|apply\s*for\s*this\s*job|resume|cover\s*letter/.test(text);
    return { captcha: !!captcha, login: !!login, widgetHit: !!widgetHit, challengeCopy: !!challengeCopy };
};

async function loadPuppeteer() {
    for (const c of [
        path.join(__dirname, '../../server/node_modules/puppeteer-core'),
        path.join(__dirname, '../../server/node_modules/puppeteer'),
        'puppeteer-core'
    ]) {
        try { return require(c); } catch (_) { /* next */ }
    }
    return null;
}

function chromePath() {
    return [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean).find((p) => fs.existsSync(p));
}

function pageHtml(platform, variant) {
    const sig = buildSignals(platform, variant);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${platform.id} ${variant.name}</title></head>
<body data-host="${platform.host}">
${sig.html}
<div id="copy">${sig.text.replace(/</g, '&lt;')}</div>
</body></html>`;
}

async function runUnitMatrix(classify) {
    const rows = [];
    let failed = 0;
    for (const platform of PLATFORMS) {
        for (const variant of VARIANTS) {
            const sig = buildSignals(platform, variant);
            const got = classify(sig);
            const okCaptcha = got.captcha === variant.expectCaptcha;
            const okLogin = got.login === variant.expectLogin;
            const ok = okCaptcha && okLogin;
            if (!ok) failed += 1;
            rows.push({
                platform: platform.id,
                variant: variant.name,
                ok,
                expect: { captcha: variant.expectCaptcha, login: variant.expectLogin },
                got: { captcha: got.captcha, login: got.login }
            });
            const label = `${platform.id}/${variant.name}`;
            if (!ok) {
                console.log('FAIL', label, `expect captcha=${variant.expectCaptcha} login=${variant.expectLogin}`, 'got', got);
            } else {
                console.log('PASS', label);
            }
        }
    }
    return { failed, passed: rows.length - failed, total: rows.length, rows };
}

async function runDomMatrix(browser) {
    const rows = [];
    let failed = 0;
    // Focus DOM variants that rely on real widget selectors
    const domVariants = VARIANTS.filter((v) => [
        'clean_apply',
        'recaptcha_widget',
        'hcaptcha_widget',
        'turnstile_widget',
        'arkose_html',
        'cloudflare_challenge_copy',
        'datadome_copy',
        'oracle_human_prove',
        'login_wall',
        'recaptcha_iframe'
    ].includes(v.name));

    for (const platform of PLATFORMS) {
        for (const variant of domVariants) {
            const page = await browser.newPage();
            try {
                await page.setContent(pageHtml(platform, variant), { waitUntil: 'domcontentloaded', timeout: 10000 });
                // Put challenge text into body text for copy-based variants
                const sig = buildSignals(platform, variant);
                await page.evaluate((t) => {
                    const el = document.createElement('p');
                    el.textContent = t;
                    document.body.appendChild(el);
                }, sig.text);

                const got = await page.evaluate(DETECT_IN_PAGE);
                const ok = got.captcha === variant.expectCaptcha && got.login === variant.expectLogin;
                if (!ok) failed += 1;
                rows.push({
                    platform: platform.id,
                    variant: variant.name,
                    ok,
                    expect: { captcha: variant.expectCaptcha, login: variant.expectLogin },
                    got
                });
                console.log(ok ? 'DOM PASS' : 'DOM FAIL', `${platform.id}/${variant.name}`, ok ? '' : JSON.stringify(got));
            } catch (err) {
                failed += 1;
                rows.push({ platform: platform.id, variant: variant.name, ok: false, error: err.message });
                console.log('DOM FAIL', `${platform.id}/${variant.name}`, err.message);
            } finally {
                await page.close().catch(() => {});
            }
        }
    }
    return { failed, passed: rows.length - failed, total: rows.length, rows };
}

async function main() {
    const classify = await loadClassify();
    console.log('=== CAPTCHA unit matrix (all platforms × variants) ===');
    const unit = await runUnitMatrix(classify);

    let dom = { skipped: true, failed: 0, passed: 0, total: 0, rows: [] };
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (puppeteer && exe) {
        console.log('\n=== CAPTCHA DOM matrix (widget selectors) ===');
        const browser = await puppeteer.launch({
            executablePath: exe,
            headless: 'new',
            args: ['--no-sandbox', '--disable-gpu']
        });
        try {
            dom = await runDomMatrix(browser);
            dom.skipped = false;
        } finally {
            await browser.close();
        }
    } else {
        console.log('\n(skip DOM matrix — no Chrome/puppeteer)');
    }

    const report = {
        unit: { failed: unit.failed, passed: unit.passed, total: unit.total },
        dom: {
            skipped: !!dom.skipped,
            failed: dom.failed,
            passed: dom.passed,
            total: dom.total
        },
        platforms: PLATFORMS.map((p) => p.id),
        variants: VARIANTS.map((v) => v.name)
    };
    fs.writeFileSync(
        path.join(__dirname, 'captcha_all_platforms_report.json'),
        JSON.stringify({ ...report, unitRows: unit.rows, domRows: dom.rows }, null, 2)
    );

    console.log('\n' + JSON.stringify(report, null, 2));
    const failed = unit.failed + (dom.failed || 0);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
