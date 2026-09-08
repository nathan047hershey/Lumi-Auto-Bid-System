/**
 * Multi-ATS collect + fill smoke tests
 * (Lever, Ashby, Workday, SmartRecruiters, Oracle).
 * Run: node extension/fixtures/test_multi_ats.js
 */
const fs = require('fs');
const path = require('path');

const PROFILE = {
    first_name: 'Alex',
    last_name: 'Testuser',
    email: 'alex.testuser@example.com',
    phone: '(555) 010-9999',
    city: 'Palo Alto',
    state: 'CA',
    country: 'United States',
    linkedin_url: 'https://www.linkedin.com/in/alex-testuser',
    github_url: 'https://github.com/example',
    website_url: '',
    school: 'Virginia Tech',
    degree: 'Bachelor of Science',
    discipline: 'Computer Science',
    years_of_experience: '18',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    salary_range: '180000'
};

const FIXTURES = [
    {
        name: 'lever',
        file: 'lever_form.html',
        expectAts: 'lever',
        expectKinds: [
            'full_name', 'email', 'phone', 'linkedin', 'github', 'city',
            'work_authorization', 'requires_sponsorship', 'years_of_experience', 'salary'
        ],
        expectFilledMin: 7,
        assertDom: (page) => page.evaluate(() => ({
            email: document.getElementById('email')?.value || '',
            phone: document.getElementById('phone')?.value || '',
            workauth: document.getElementById('workauth')?.value || '',
            sponsor: document.getElementById('sponsor')?.value || '',
            yoe: [...document.querySelectorAll('input[name="yoe"]')].find((r) => r.checked)?.value || '',
            github: document.getElementById('github')?.value || '',
            city: document.getElementById('loc')?.value || ''
        })),
        checks: (dom) => [
            ['email', dom.email.includes('@')],
            ['phone', /\d{3}/.test(dom.phone)],
            ['workauth Yes', dom.workauth === 'Yes'],
            ['sponsor No', dom.sponsor === 'No'],
            ['yoe 10+', dom.yoe === '10p'],
            ['github', /github/i.test(dom.github)],
            ['city', /palo/i.test(dom.city)]
        ]
    },
    {
        name: 'ashby',
        file: 'ashby_form.html',
        expectAts: 'ashby',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city', 'linkedin', 'github',
            'work_authorization', 'requires_sponsorship', 'years_of_experience', 'salary'
        ],
        expectFilledMin: 8,
        assertDom: (page) => page.evaluate(() => ({
            first: document.getElementById('ashby-first')?.value || '',
            last: document.getElementById('ashby-last')?.value || '',
            email: document.getElementById('ashby-email')?.value || '',
            auth: document.getElementById('ashby-auth')?.value || '',
            sponsor: document.getElementById('ashby-sponsor')?.value || '',
            yoe: [...document.querySelectorAll('input[name="ashby-yoe"]')].find((r) => r.checked)?.value || '',
            city: document.getElementById('ashby-city')?.value || ''
        })),
        checks: (dom) => [
            ['first', dom.first === 'Alex'],
            ['last', dom.last === 'Testuser'],
            ['email', dom.email.includes('@')],
            ['auth Yes', dom.auth === 'Yes'],
            ['sponsor No', dom.sponsor === 'No'],
            ['yoe 10+', dom.yoe === '10+'],
            ['city', /palo/i.test(dom.city)]
        ]
    },
    {
        name: 'workday',
        file: 'workday_form.html',
        expectAts: 'workday',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city', 'country',
            'work_authorization', 'requires_sponsorship', 'linkedin', 'github'
        ],
        expectFilledMin: 8,
        assertDom: (page) => page.evaluate(() => ({
            first: document.querySelector('[data-automation-id="legalNameSection--firstName"]')?.value || '',
            last: document.querySelector('[data-automation-id="legalNameSection--lastName"]')?.value || '',
            email: document.querySelector('[data-automation-id="email"]')?.value || '',
            country: document.querySelector('[data-automation-id="countryDropdown"]')?.value || '',
            auth: document.querySelector('[data-automation-id="workAuthSelect"]')?.value || '',
            sponsor: document.querySelector('[data-automation-id="sponsorshipSelect"]')?.value || '',
            city: document.querySelector('[data-automation-id="addressSection_city"]')?.value || '',
            web: document.querySelector('[data-automation-id="website"]')?.value || ''
        })),
        checks: (dom) => [
            ['first', dom.first === 'Alex'],
            ['last', dom.last === 'Testuser'],
            ['email', dom.email.includes('@')],
            ['country US', dom.country === 'US'],
            ['auth Yes', dom.auth === 'Yes'],
            ['sponsor No', dom.sponsor === 'No'],
            ['city', /palo/i.test(dom.city)],
            ['github/web', /github/i.test(dom.web)]
        ]
    },
    {
        name: 'smartrecruiters',
        file: 'smartrecruiters_form.html',
        expectAts: 'smartrecruiters',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city', 'country',
            'linkedin', 'work_authorization'
        ],
        expectFilledMin: 6,
        assertDom: (page) => page.evaluate(() => ({
            first: document.getElementById('sr-first')?.value || '',
            email: document.getElementById('sr-email')?.value || '',
            country: document.getElementById('sr-country')?.value || '',
            auth: document.getElementById('sr-auth')?.value || '',
            city: document.getElementById('sr-city')?.value || ''
        })),
        checks: (dom) => [
            ['first', dom.first === 'Alex'],
            ['email', dom.email.includes('@')],
            ['country US', dom.country === 'US'],
            ['auth Yes', dom.auth === 'Yes'],
            ['city', /palo/i.test(dom.city)]
        ]
    },
    {
        name: 'oracle',
        file: 'oracle_form.html',
        spoofHost: 'eihu.fa.us8.oraclecloud.com',
        expectAts: 'oracle',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city', 'country',
            'linkedin', 'work_authorization', 'requires_sponsorship'
        ],
        expectFilledMin: 7,
        assertDom: (page) => page.evaluate(() => ({
            first: document.getElementById('ora-first')?.value || '',
            last: document.getElementById('ora-last')?.value || '',
            email: document.getElementById('ora-email')?.value || '',
            phone: document.getElementById('ora-phone')?.value || '',
            city: document.getElementById('ora-city')?.value || '',
            country: document.getElementById('ora-country')?.value || '',
            auth: document.getElementById('ora-auth')?.value || '',
            sponsor: document.getElementById('ora-sponsor')?.value || '',
            li: document.getElementById('ora-li')?.value || ''
        })),
        checks: (dom) => [
            ['first', dom.first === 'Alex'],
            ['last', dom.last === 'Testuser'],
            ['email', dom.email.includes('@')],
            ['phone', /\d{3}/.test(dom.phone)],
            ['city', /palo/i.test(dom.city)],
            ['country US', dom.country === 'US'],
            ['auth Yes', dom.auth === 'Yes'],
            ['sponsor No', dom.sponsor === 'No'],
            ['linkedin', /linkedin/i.test(dom.li)]
        ]
    }
];

async function loadPuppeteer() {
    const candidates = [
        path.join(__dirname, '../../server/node_modules/puppeteer-core'),
        path.join(__dirname, '../../server/node_modules/puppeteer'),
        'puppeteer-core',
        'puppeteer'
    ];
    for (const c of candidates) {
        try {
            return require(c);
        } catch (_) { /* next */ }
    }
    return null;
}

function chromePath() {
    return [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/usr/bin/google-chrome',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean).find((p) => fs.existsSync(p));
}

async function runFixture(browser, fillSrc, fixture) {
    const html = fs.readFileSync(path.join(__dirname, fixture.file), 'utf8');
    const page = await browser.newPage();
    const failures = [];
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: fillSrc });

        const collected = await page.evaluate(() => new Promise((resolve) => {
            const listener = chrome?.runtime?.onMessage;
            // fill.js registers chrome.runtime.onMessage — stub if missing
            resolve(null);
        }));

        // Direct call: fill.js exposes via message; stub chrome then re-trigger collect through evaluate of internals.
        // Inject a tiny bridge that calls the same message handlers.
        const result = await page.evaluate(async (profile) => {
            // Re-find handler by dispatching through the content script's chrome mock.
            if (!window.__JOB_APPLY_BIDDER_FILL__) {
                return { error: 'fill.js not loaded' };
            }
            return new Promise((resolve) => {
                // The IIFE already ran; use chrome.runtime.sendMessage pattern via stored listener.
                // fill.js uses chrome.runtime.onMessage.addListener — we stub chrome before load.
                resolve({ error: 'need_chrome_stub_before_load' });
            });
        }, PROFILE);

        // Proper path: new page, stub chrome BEFORE fill.js
        await page.close();
        const page2 = await browser.newPage();
        await page2.setContent(html, { waitUntil: 'domcontentloaded' });
        await page2.evaluate((host) => {
            if (host) {
                window.__BIDDER_SPOOF_HOST = host;
                window.__BIDDER_SPOOF_HREF = `https://${host}/apply`;
            }
            window.__chromeListeners = [];
            window.chrome = {
                runtime: {
                    id: 'fixture-test',
                    onMessage: {
                        addListener(fn) { window.__chromeListeners.push(fn); }
                    },
                    sendMessage() {},
                    lastError: null
                }
            };
        }, fixture.spoofHost || '');
        await page2.addScriptTag({ content: fillSrc });

        const out = await page2.evaluate(async (profile, expectAts) => {
            const listeners = window.__chromeListeners || [];
            if (!listeners.length) return { error: 'no_listeners' };

            const send = (msg) => new Promise((resolve) => {
                let done = false;
                const respond = (payload) => {
                    if (done) return;
                    done = true;
                    resolve(payload);
                };
                for (const fn of listeners) {
                    const ret = fn(msg, {}, respond);
                    if (ret === true) return; // async
                }
                setTimeout(() => {
                    if (!done) resolve({ ok: false, error: 'no_response' });
                }, 50);
            });

            const collect = await send({ type: 'COLLECT_FORM' });
            if (!collect?.ok) return { error: 'collect_failed', collect };
            const form = collect.data;
            const kinds = (form.fields || []).map((f) => f.kind);
            const fill = await send({
                type: 'FILL_FORM',
                payload: {
                    fields: form.fields,
                    answers: [],
                    profile,
                    jobDescription: 'Salary range $70,000 - $95,000. Full stack role.'
                }
            });
            // Wait for native selects (sync) — combobox queue may still run
            await new Promise((r) => setTimeout(r, 800));
            return {
                ats: form.ats,
                kinds,
                filled: fill?.fillStats?.filled ?? fill?.data?.fillStats?.filled,
                fillOk: fill?.ok,
                requiredComplete: fill?.fillStats?.requiredComplete,
                requiredOk: fill?.fillStats?.requiredOk,
                requiredTotal: fill?.fillStats?.requiredTotal,
                missingRequired: fill?.fillStats?.missingRequired || [],
                fillRaw: fill
            };
        }, PROFILE, fixture.expectAts);

        if (out.error) {
            failures.push(`bootstrap: ${out.error}`);
            await page2.close();
            return { name: fixture.name, ok: false, failures, out };
        }

        if (out.ats !== fixture.expectAts) {
            failures.push(`ats got ${out.ats} want ${fixture.expectAts}`);
        }
        for (const kind of fixture.expectKinds) {
            if (!(out.kinds || []).includes(kind)) {
                failures.push(`missing kind ${kind}`);
            }
        }
        const filled = Number(out.filled || out.fillRaw?.fillStats?.filled || 0);
        if (filled < fixture.expectFilledMin) {
            failures.push(`filled ${filled} < min ${fixture.expectFilledMin}`);
        }
        if (out.requiredComplete === false) {
            failures.push(
                `requiredComplete false (${out.requiredOk}/${out.requiredTotal}) missing=${JSON.stringify(out.missingRequired)}`
            );
        }
        if (Number(out.requiredTotal) > 0 && out.requiredComplete !== true) {
            failures.push(`expected requiredComplete true got ${out.requiredComplete}`);
        }

        const dom = await fixture.assertDom(page2);
        for (const [label, ok] of fixture.checks(dom)) {
            if (!ok) failures.push(`dom:${label} → ${JSON.stringify(dom)}`);
        }

        await page2.close();
        return {
            name: fixture.name,
            ok: failures.length === 0,
            failures,
            ats: out.ats,
            kinds: out.kinds,
            filled,
            dom
        };
    } catch (err) {
        try { await page.close(); } catch (_) { /* ignore */ }
        return { name: fixture.name, ok: false, failures: [err.message] };
    }
}

async function main() {
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (!puppeteer || !exe) {
        console.log(JSON.stringify({
            skip: true,
            reason: !puppeteer ? 'no puppeteer' : 'no chrome',
            unitHint: 'run node extension/fixtures/test_ats_classify_unit.js'
        }, null, 2));
        process.exit(0);
    }

    const cmSrc = fs.readFileSync(path.join(__dirname, '../content/controlMatch.js'), 'utf8');
    const fillSrc = cmSrc + '\n' + fs.readFileSync(path.join(__dirname, '../content/fill.js'), 'utf8');
    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu']
    });

    const results = [];
    for (const fixture of FIXTURES) {
        // eslint-disable-next-line no-await-in-loop
        const r = await runFixture(browser, fillSrc, fixture);
        results.push(r);
        console.log(r.ok ? 'OK' : 'FAIL', r.name, r.ok ? `filled=${r.filled}` : r.failures.join('; '));
    }

    await browser.close();
    const failed = results.filter((r) => !r.ok).length;
    console.log(JSON.stringify({ failed, results }, null, 2));
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
