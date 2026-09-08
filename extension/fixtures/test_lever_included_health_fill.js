/**
 * Regression: Lever Included Health–style cards (ZIP essay bug + empty radios).
 * Run: node extension/fixtures/test_lever_included_health_fill.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PROFILE = {
    first_name: 'Alex',
    last_name: 'Testuser',
    email: 'alex.testuser@example.com',
    phone: '(555) 010-9999',
    city: 'Palo Alto',
    state: 'CA',
    country: 'United States',
    postal_code: '94301',
    linkedin_url: 'https://www.linkedin.com/in/alex-testuser',
    github_url: 'https://github.com/example-user',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    years_of_experience: '18'
};

async function loadPuppeteer() {
    for (const c of [
        path.join(__dirname, '../../server/node_modules/puppeteer-core'),
        path.join(__dirname, '../../server/node_modules/puppeteer'),
        'puppeteer-core',
        'puppeteer'
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

async function main() {
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (!puppeteer || !exe) {
        console.error('Need puppeteer-core + Chrome');
        process.exit(2);
    }

    const cmSrc = fs.readFileSync(path.join(__dirname, '../content/controlMatch.js'), 'utf8');
    const fillSrc = fs.readFileSync(path.join(__dirname, '../content/fill.js'), 'utf8');
    const htmlPath = path.join(__dirname, 'lever_included_health_cards.html');

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
        window.__chromeListeners = [];
        window.chrome = {
            runtime: {
                id: 'fixture-test',
                onMessage: { addListener(fn) { window.__chromeListeners.push(fn); } },
                sendMessage() {},
                lastError: null
            }
        };
    });
    await page.addScriptTag({ content: cmSrc });
    await page.addScriptTag({ content: fillSrc });

    const result = await page.evaluate(async (profile) => {
        const listeners = window.__chromeListeners || [];
        const send = (msg) => new Promise((resolve) => {
            let done = false;
            const respond = (payload) => {
                if (!done) { done = true; resolve(payload); }
            };
            for (const fn of listeners) {
                const keep = fn(msg, {}, respond);
                if (keep === true) return;
            }
            setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, 200);
        });

        const collect = await send({ type: 'COLLECT_FORM' });
        const form = collect?.data || collect;
        const fields = form?.fields || [];
        const fill = await send({
            type: 'FILL_FORM',
            payload: {
                fields,
                answers: [],
                profile,
                jobDescription: 'Senior Software Engineer, Backend at Included Health'
            }
        });
        await new Promise((r) => setTimeout(r, 800));

        return {
            fields: fields.map((f) => ({ label: f.label, kind: f.kind, type: f.type, name: f.name })),
            filled: fill?.fillStats?.filled ?? fill?.data?.fillStats?.filled ?? 0,
            fillOk: fill?.ok,
            zip: document.querySelector('input[name="cards[zip][field0]"]')?.value || '',
            auth: [...document.querySelectorAll('input[name="cards[auth][field0]"]')].find((r) => r.checked)?.value || '',
            sponsor: [...document.querySelectorAll('input[name="cards[sponsor][field0]"]')].find((r) => r.checked)?.value || '',
            prev: [...document.querySelectorAll('input[name="cards[prev][field0]"]')].find((r) => r.checked)?.value || '',
            sms: !!document.querySelector('input[name="cards[sms][field0]"]')?.checked,
            yoe: [...document.querySelectorAll('input[name="cards[yoe][field0]"]')].find((r) => r.checked)?.value || '',
            sig: document.querySelector('input[name="eeo[disabilitySignature]"]')?.value || '',
            date: document.querySelector('input[name="eeo[disabilityDate]"]')?.value || ''
        };
    }, PROFILE);

    await browser.close();

    const checks = [];
    const zipField = result.fields.find((f) => /zip/i.test(f.label || ''));
    checks.push(['zip kind postal_code', zipField?.kind === 'postal_code']);
    checks.push(['zip label not placeholder', zipField && !/type your response/i.test(zipField.label)]);
    checks.push(['zip value postal', result.zip === '94301']);
    checks.push(['zip not essay', !/I want to work/i.test(result.zip)]);
    checks.push(['work auth Yes', result.auth === 'Yes']);
    checks.push(['sponsor No', result.sponsor === 'No']);
    checks.push(['previous No', result.prev === 'No']);
    checks.push(['sms checked', result.sms === true]);
    checks.push(['yoe 10+', result.yoe === '10p']);
    const sigField = result.fields.find((f) => /disabilitySignature/i.test(f.name || ''));
    checks.push(['sig kind disability_signature', sigField?.kind === 'disability_signature']);
    checks.push(['sig name Alex Testuser', /Alex\s+Testuser/i.test(result.sig)]);
    checks.push(['date filled', /^\d{2}\/\d{2}\/\d{4}$/.test(result.date)]);
    checks.push(['filled count meaningful', result.filled >= 5]);

    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(ok ? 'PASS' : 'FAIL', name);
        if (!ok) failed += 1;
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
