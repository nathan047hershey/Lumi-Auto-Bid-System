/**
 * Extra multi-platform + regression suite.
 * iCIMS, BambooHR, generic, LinkedIn block, dial-vs-residence country.
 * Run: node extension/fixtures/test_more_platforms.js
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

const PROFILE = {
    first_name: 'Alex',
    last_name: 'Testuser',
    email: 'alex.testuser@example.com',
    phone: '(555) 010-9999',
    city: 'Palo Alto',
    state: 'CA',
    country: 'United States',
    linkedin_url: 'https://www.linkedin.com/in/alex-testuser',
    github_url: 'https://github.com/example-user',
    work_authorization: 'Yes',
    requires_sponsorship: 'No'
};

const JD = 'Full Stack role. Salary $70,000 - $95,000 USD.';

const PHONE_OK = (v) => {
    const d = String(v || '').replace(/\D/g, '');
    return d.endsWith('5550109999') || d.endsWith('0109999') || d.endsWith('3182028037');
};

const CASES = [
    {
        name: 'icims',
        file: 'icims_form.html',
        spoofHost: 'careers-company.icims.com',
        expectAts: 'icims',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city',
            'linkedin', 'work_authorization', 'requires_sponsorship'
        ],
        expectFilledMin: 6,
        waitMs: 1200,
        snapshot: () => ({
            first: document.getElementById('ic-first')?.value || '',
            last: document.getElementById('ic-last')?.value || '',
            email: document.getElementById('ic-email')?.value || '',
            phone: document.getElementById('ic-phone')?.value || '',
            city: document.getElementById('ic-city')?.value || '',
            li: document.getElementById('ic-li')?.value || '',
            auth: document.getElementById('ic-auth')?.value || '',
            sponsor: document.getElementById('ic-sponsor')?.value || ''
        }),
        checks: (d) => [
            ['first', d.first === 'Alex'],
            ['last', d.last === 'Testuser'],
            ['email', d.email.includes('@')],
            ['phone', PHONE_OK(d.phone)],
            ['city', /palo/i.test(d.city)],
            ['linkedin', /linkedin/i.test(d.li)],
            ['auth Yes', d.auth === 'Yes'],
            ['sponsor No', d.sponsor === 'No']
        ]
    },
    {
        name: 'bamboohr',
        file: 'bamboohr_form.html',
        spoofHost: 'company.bamboohr.com',
        expectAts: 'bamboohr',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city', 'country',
            'linkedin', 'work_authorization'
        ],
        expectFilledMin: 6,
        waitMs: 1200,
        snapshot: () => ({
            first: document.getElementById('bh-first')?.value || '',
            last: document.getElementById('bh-last')?.value || '',
            email: document.getElementById('bh-email')?.value || '',
            phone: document.getElementById('bh-phone')?.value || '',
            city: document.getElementById('bh-city')?.value || '',
            country: document.getElementById('bh-country')?.value || '',
            li: document.getElementById('bh-li')?.value || '',
            auth: document.getElementById('bh-auth')?.value || ''
        }),
        checks: (d) => [
            ['first', d.first === 'Alex'],
            ['email', d.email.includes('@')],
            ['phone', PHONE_OK(d.phone)],
            ['city', /palo/i.test(d.city)],
            ['country US', d.country === 'US'],
            ['linkedin', /linkedin/i.test(d.li)],
            ['auth Yes', d.auth === 'Yes']
        ]
    },
    {
        name: 'generic',
        file: 'generic_form.html',
        spoofHost: 'careers.example.com',
        expectAts: 'generic',
        expectKinds: [
            'first_name', 'last_name', 'email', 'phone', 'city', 'requires_sponsorship'
        ],
        expectFilledMin: 5,
        waitMs: 1000,
        snapshot: () => ({
            first: document.getElementById('g-first')?.value || '',
            last: document.getElementById('g-last')?.value || '',
            email: document.getElementById('g-email')?.value || '',
            phone: document.getElementById('g-phone')?.value || '',
            city: document.getElementById('g-city')?.value || '',
            sponsor: document.getElementById('g-sponsor')?.value || ''
        }),
        checks: (d) => [
            ['first', d.first === 'Alex'],
            ['last', d.last === 'Testuser'],
            ['email', d.email.includes('@')],
            ['phone', PHONE_OK(d.phone)],
            ['city', /palo/i.test(d.city)],
            ['sponsor No', d.sponsor === 'No']
        ]
    },
    {
        name: 'dial_vs_residence',
        file: 'dial_vs_residence.html',
        spoofHost: 'boards.greenhouse.io',
        expectAts: 'greenhouse',
        expectKinds: ['first_name', 'phone', 'country', 'email'],
        expectFilledMin: 4,
        waitMs: 1500,
        snapshot: () => ({
            first: document.getElementById('first')?.value || '',
            phone: document.getElementById('phone')?.value || '',
            country: document.getElementById('country')?.value || '',
            email: document.getElementById('email')?.value || ''
        }),
        checks: (d) => [
            ['first', d.first === 'Alex'],
            ['email', d.email.includes('@')],
            ['phone digits not country name', PHONE_OK(d.phone) && !/united states/i.test(d.phone)],
            ['residence country US', d.country === 'US']
        ]
    }
];

async function runCase(browser, fillSrc, c) {
    const html = fs.readFileSync(path.join(__dirname, c.file), 'utf8');
    const page = await browser.newPage();
    const failures = [];
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await injectAutofill(page, fillSrc, { spoofHost: c.spoofHost });
        const out = await collectAndFill(page, {
            profile: PROFILE,
            jobDescription: JD,
            waitMs: c.waitMs
        });
        if (out.error) {
            failures.push(`bootstrap: ${out.error}`);
            return { name: c.name, ok: false, failures, out };
        }
        if (out.ats !== c.expectAts) {
            failures.push(`ats got=${out.ats} want=${c.expectAts}`);
        }
        const kinds = (out.fields || []).map((f) => f.kind);
        for (const k of c.expectKinds) {
            if (!kinds.includes(k)) failures.push(`missing kind ${k}`);
        }
        const filled = Number(out.fillStats?.filled || 0);
        if (filled < c.expectFilledMin) {
            failures.push(`filled ${filled} < min ${c.expectFilledMin}`);
        }
        const dom = await page.evaluate(c.snapshot);
        for (const [label, ok] of c.checks(dom)) {
            if (!ok) failures.push(`dom:${label} → ${JSON.stringify(dom)}`);
        }
        return {
            name: c.name,
            ok: failures.length === 0,
            failures,
            ats: out.ats,
            filled,
            kinds,
            dom
        };
    } catch (err) {
        return { name: c.name, ok: false, failures: [err.message] };
    } finally {
        await page.close().catch(() => {});
    }
}

async function runLinkedInBlocked(browser, fillSrc) {
    const html = fs.readFileSync(path.join(__dirname, 'linkedin_easy_apply.html'), 'utf8');
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await injectAutofill(page, fillSrc, { spoofHost: 'www.linkedin.com' });
        const out = await page.evaluate(async () => {
            const listeners = window.__chromeListeners || [];
            const send = (msg) => new Promise((resolve) => {
                let done = false;
                const respond = (p) => { if (!done) { done = true; resolve(p); } };
                for (const fn of listeners) {
                    if (fn(msg, {}, respond) === true) return;
                }
                setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, 80);
            });
            const collect = await send({ type: 'COLLECT_FORM' });
            const fill = await send({
                type: 'FILL_FORM',
                payload: { fields: [], answers: [], profile: {}, jobDescription: '' }
            });
            return { collect, fill };
        });
        const data = out.collect?.data || {};
        const ats = data.ats || out.collect?.ats;
        const failures = [];
        if (ats !== 'linkedin') {
            failures.push(`ats got=${ats} want=linkedin`);
        }
        if (data.blocked !== true) {
            failures.push('collect.data.blocked should be true');
        }
        if (!/linkedin|not supported/i.test(String(data.reason || ''))) {
            failures.push(`bad reason: ${data.reason}`);
        }
        if ((data.fields || []).length > 0) {
            failures.push('linkedin should return zero fields');
        }
        const phone = await page.evaluate(() => document.getElementById('li-phone')?.value || '');
        if (phone) failures.push(`linkedin phone filled unexpectedly: ${phone}`);

        // FILL_FORM must refuse
        if (out.fill?.ok !== false) {
            failures.push(`fill should fail on linkedin, got ${JSON.stringify(out.fill)}`);
        }

        return {
            name: 'linkedin_blocked',
            ok: failures.length === 0,
            failures,
            ats,
            reason: data.reason
        };
    } catch (err) {
        return { name: 'linkedin_blocked', ok: false, failures: [err.message] };
    } finally {
        await page.close().catch(() => {});
    }
}

async function main() {
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (!puppeteer || !exe) {
        console.log(JSON.stringify({ skip: true, reason: !puppeteer ? 'no puppeteer' : 'no chrome' }));
        process.exit(0);
    }
    const fillSrc = loadFillScript();
    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu']
    });
    const results = [];
    for (const c of CASES) {
        // eslint-disable-next-line no-await-in-loop
        const r = await runCase(browser, fillSrc, c);
        results.push(r);
        console.log(r.ok ? 'OK' : 'FAIL', r.name, r.ok ? `filled=${r.filled}` : r.failures.join('; '));
    }
    const li = await runLinkedInBlocked(browser, fillSrc);
    results.push(li);
    console.log(li.ok ? 'OK' : 'FAIL', li.name, li.ok ? `ats=${li.ats}` : li.failures.join('; '));

    await browser.close();
    const failed = results.filter((r) => !r.ok).length;
    const report = { failed, passed: results.length - failed, results };
    fs.writeFileSync(
        path.join(__dirname, 'more_platforms_report.json'),
        JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify({ failed: report.failed, passed: report.passed }, null, 2));
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
