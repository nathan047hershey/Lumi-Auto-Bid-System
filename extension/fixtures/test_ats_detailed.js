/**
 * Detailed multi-ATS autofill report.
 * Run: node extension/fixtures/test_ats_detailed.js
 *
 * For each platform: ATS detect, every field label→kind, DOM values after fill,
 * edge cases (reside→Somewhere else, degree≠Other, YoE, CIAT No).
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
    github_url: 'https://github.com/example-user',
    website_url: '',
    school: 'Virginia Tech',
    degree: 'Bachelor of Science',
    discipline: 'Computer Science',
    years_of_experience: '18',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    salary_range: '180000'
};

const JD = 'Full Stack Web Developer. Salary range $70,000 - $95,000 USD.';

/** Accept formatted or digit-stripped phone (fillPhoneInput normalizes). */
const PHONE_OK = (v) => {
    const d = String(v || '').replace(/\D/g, '');
    return d.endsWith('5550109999') || d.endsWith('0109999') || d.endsWith('3182028037');
};

const SUITES = [
    {
        name: 'lever',
        file: 'lever_form.html',
        expectAts: 'lever',
        kindMap: {
            'Full name *': 'full_name',
            'Email *': 'email',
            'Phone *': 'phone',
            'LinkedIn URL': 'linkedin',
            'GitHub URL': 'github',
            'Location (City) *': 'city',
            'Are you legally authorized to work in the United States? *': 'work_authorization',
            'Will you now or in the future require sponsorship? *': 'requires_sponsorship',
            'How many years of professional experience do you have? *': 'years_of_experience',
            'What is your desired salary? *': 'salary'
        },
        snapshot: () => ({
            name: document.getElementById('name')?.value,
            email: document.getElementById('email')?.value,
            phone: document.getElementById('phone')?.value,
            linkedin: document.getElementById('linkedin')?.value,
            github: document.getElementById('github')?.value,
            city: document.getElementById('loc')?.value,
            workauth: document.getElementById('workauth')?.value,
            sponsor: document.getElementById('sponsor')?.value,
            yoe: [...document.querySelectorAll('input[name="yoe"]')].find((r) => r.checked)?.value || '',
            salary: document.getElementById('salary')?.value
        }),
        expect: {
            name: 'Alex Testuser',
            email: PROFILE.email,
            phone: PHONE_OK,
            linkedin: PROFILE.linkedin_url,
            github: PROFILE.github_url,
            city: /Palo Alto/i,
            workauth: 'Yes',
            sponsor: 'No',
            yoe: '10p',
            salary: /7[0-9]|8[0-9]|9[0-5]|\$/ // mid of JD band, not empty
        }
    },
    {
        name: 'ashby',
        file: 'ashby_form.html',
        expectAts: 'ashby',
        kindMap: {
            'First Name *': 'first_name',
            'Last Name *': 'last_name',
            'Email *': 'email',
            'Phone Number *': 'phone',
            'City *': 'city',
            'LinkedIn Profile': 'linkedin',
            'GitHub / Portfolio URL': 'github',
            'Are you authorized to work in the United States? *': 'work_authorization',
            'Do you require visa sponsorship? *': 'requires_sponsorship',
            'Years of experience as a software engineer *': 'years_of_experience',
            'Desired salary *': 'salary'
        },
        snapshot: () => ({
            first: document.getElementById('ashby-first')?.value,
            last: document.getElementById('ashby-last')?.value,
            email: document.getElementById('ashby-email')?.value,
            phone: document.getElementById('ashby-phone')?.value,
            city: document.getElementById('ashby-city')?.value,
            linkedin: document.getElementById('ashby-li')?.value,
            github: document.getElementById('ashby-gh')?.value,
            auth: document.getElementById('ashby-auth')?.value,
            sponsor: document.getElementById('ashby-sponsor')?.value,
            yoe: [...document.querySelectorAll('input[name="ashby-yoe"]')].find((r) => r.checked)?.value || '',
            salary: document.getElementById('ashby-salary')?.value
        }),
        expect: {
            first: 'Alex',
            last: 'Testuser',
            email: PROFILE.email,
            phone: PHONE_OK,
            city: /Palo Alto/i,
            linkedin: PROFILE.linkedin_url,
            github: PROFILE.github_url,
            auth: 'Yes',
            sponsor: 'No',
            yoe: '10+',
            salary: /.+/
        }
    },
    {
        name: 'workday',
        file: 'workday_form.html',
        expectAts: 'workday',
        kindMap: {
            'First Name': 'first_name',
            'Last Name': 'last_name',
            'Email Address': 'email',
            'Phone Number': 'phone',
            City: 'city',
            Country: 'country',
            'Are you legally authorized to work in the country where this job is located?': 'work_authorization',
            'Will you now or in the future require sponsorship for employment visa status?': 'requires_sponsorship',
            LinkedIn: 'linkedin',
            'Website / Portfolio / GitHub': 'github'
        },
        snapshot: () => ({
            first: document.querySelector('[data-automation-id="legalNameSection--firstName"]')?.value,
            last: document.querySelector('[data-automation-id="legalNameSection--lastName"]')?.value,
            email: document.querySelector('[data-automation-id="email"]')?.value,
            phone: document.querySelector('[data-automation-id="phone"]')?.value,
            city: document.querySelector('[data-automation-id="addressSection_city"]')?.value,
            country: document.querySelector('[data-automation-id="countryDropdown"]')?.value,
            auth: document.querySelector('[data-automation-id="workAuthSelect"]')?.value,
            sponsor: document.querySelector('[data-automation-id="sponsorshipSelect"]')?.value,
            linkedin: document.querySelector('[data-automation-id="linkedin"]')?.value,
            web: document.querySelector('[data-automation-id="website"]')?.value
        }),
        expect: {
            first: 'Alex',
            last: 'Testuser',
            email: PROFILE.email,
            phone: PHONE_OK,
            city: /Palo Alto/i,
            country: 'US',
            auth: 'Yes',
            sponsor: 'No',
            linkedin: PROFILE.linkedin_url,
            web: /github/i
        }
    },
    {
        name: 'smartrecruiters',
        file: 'smartrecruiters_form.html',
        expectAts: 'smartrecruiters',
        kindMap: {
            'First name *': 'first_name',
            'Last name *': 'last_name',
            'Email *': 'email',
            'Phone *': 'phone',
            'City *': 'city',
            'Country *': 'country',
            'LinkedIn profile': 'linkedin',
            'Are you eligible to work in this country? *': 'work_authorization'
        },
        snapshot: () => ({
            first: document.getElementById('sr-first')?.value,
            last: document.getElementById('sr-last')?.value,
            email: document.getElementById('sr-email')?.value,
            phone: document.getElementById('sr-phone')?.value,
            city: document.getElementById('sr-city')?.value,
            country: document.getElementById('sr-country')?.value,
            linkedin: document.getElementById('sr-li')?.value,
            auth: document.getElementById('sr-auth')?.value
        }),
        expect: {
            first: 'Alex',
            last: 'Testuser',
            email: PROFILE.email,
            phone: PHONE_OK,
            city: /Palo Alto/i,
            country: 'US',
            linkedin: PROFILE.linkedin_url,
            auth: 'Yes'
        }
    },
    {
        name: 'oracle',
        file: 'oracle_form.html',
        spoofHost: 'eihu.fa.us8.oraclecloud.com',
        expectAts: 'oracle',
        kindMap: {
            'First Name *': 'first_name',
            'Last Name *': 'last_name',
            'Email *': 'email',
            'Phone *': 'phone',
            'City *': 'city',
            'Country *': 'country',
            'LinkedIn Profile': 'linkedin',
            'Are you legally authorized to work in the United States? *': 'work_authorization',
            'Will you now or in the future require sponsorship? *': 'requires_sponsorship'
        },
        snapshot: () => ({
            first: document.getElementById('ora-first')?.value,
            last: document.getElementById('ora-last')?.value,
            email: document.getElementById('ora-email')?.value,
            phone: document.getElementById('ora-phone')?.value,
            city: document.getElementById('ora-city')?.value,
            country: document.getElementById('ora-country')?.value,
            li: document.getElementById('ora-li')?.value,
            auth: document.getElementById('ora-auth')?.value,
            sponsor: document.getElementById('ora-sponsor')?.value
        }),
        expect: {
            first: 'Alex',
            last: 'Testuser',
            email: PROFILE.email,
            phone: PHONE_OK,
            city: /Palo Alto/i,
            country: 'US',
            li: PROFILE.linkedin_url,
            auth: 'Yes',
            sponsor: 'No'
        }
    },
    {
        name: 'greenhouse_detailed',
        file: 'greenhouse_detailed.html',
        expectAts: 'greenhouse',
        waitMs: 6500,
        kindMap: {
            'First Name *': 'first_name',
            'Last Name *': 'last_name',
            'Email *': 'email',
            'Country *': 'country',
            School: 'school',
            Degree: 'degree',
            Discipline: 'discipline',
            'Where do you currently reside? *': 'city',
            'Are you able to work remotely and maintain a work environment that is free from distractions? *': 'work_authorization',
            'If you reside in a US state where we have a legal entity, will you consistently be working from this state while employed in this role? *': 'work_authorization',
            'How many years of professional experience do you have as a full stack web developer (front end + back end)? *': 'years_of_experience',
            'Please provide a URL to your GitHub, public portfolio. *': 'github',
            'Have you ever worked at CIAT? *': 'previous_employer_no',
            'What is your desired salary? *': 'salary'
        },
        snapshot: () => ({
            first: document.getElementById('gh-first')?.value,
            last: document.getElementById('gh-last')?.value,
            email: document.getElementById('gh-email')?.value,
            country: document.getElementById('country-val')?.textContent
                || document.getElementById('country')?.value,
            school: document.getElementById('school-val')?.textContent
                || document.getElementById('school')?.value,
            degree: document.getElementById('degree-val')?.textContent
                || document.getElementById('degree')?.value,
            discipline: document.getElementById('disc-val')?.textContent
                || document.getElementById('disc')?.value,
            reside: document.getElementById('reside-val')?.textContent
                || document.getElementById('reside')?.value,
            remote: document.getElementById('remote-val')?.textContent
                || document.getElementById('remote')?.value,
            stwork: document.getElementById('stwork-val')?.textContent
                || document.getElementById('stwork')?.value,
            yoe: [...document.querySelectorAll('input[name="yoe"]')].find((r) => r.checked)?.value || '',
            github: document.getElementById('gh-url')?.value,
            ciat: document.getElementById('ciat-val')?.textContent
                || document.getElementById('ciat')?.value,
            salary: document.getElementById('salary')?.value
        }),
        expect: {
            first: 'Alex',
            last: 'Testuser',
            email: PROFILE.email,
            country: /United States/i,
            school: /Virginia Tech/i,
            degree: /Bachelor/i, // must NOT be Other
            degree_not: /^Other$/i,
            discipline: /Computer Science/i,
            reside: /Somewhere else/i, // city not in CA/FL/MA/NM list
            remote: /^Yes$/i,
            stwork: /^Yes$/i,
            yoe: '10p',
            github: PROFILE.github_url,
            ciat: /^No$/i,
            salary: /.+/
        }
    }
];

function matchExpect(actual, rule) {
    if (rule instanceof RegExp) return rule.test(String(actual ?? ''));
    if (typeof rule === 'function') return !!rule(actual);
    return String(actual ?? '') === String(rule);
}

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

async function runSuite(browser, fillSrc, suite) {
    const html = fs.readFileSync(path.join(__dirname, suite.file), 'utf8');
    const page = await browser.newPage();
    const detail = {
        name: suite.name,
        ats: null,
        fields: [],
        kindFailures: [],
        valueFailures: [],
        filled: 0,
        ok: false
    };

    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        await page.evaluate((host) => {
            if (host) {
                window.__BIDDER_SPOOF_HOST = host;
                window.__BIDDER_SPOOF_HREF = `https://${host}/apply`;
            }
            window.__chromeListeners = [];
            window.chrome = {
                runtime: {
                    id: 'fixture-test',
                    onMessage: { addListener(fn) { window.__chromeListeners.push(fn); } },
                    sendMessage() {},
                    lastError: null
                }
            };
        }, suite.spoofHost || '');
        await page.addScriptTag({ content: fillSrc });

        const collectFill = await page.evaluate(async (profile, jd, waitMs) => {
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
                setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, 100);
            });

            const collect = await send({ type: 'COLLECT_FORM' });
            if (!collect?.ok) return { error: 'collect', collect };
            const form = collect.data;
            const fill = await send({
                type: 'FILL_FORM',
                payload: {
                    fields: form.fields,
                    answers: [],
                    profile,
                    jobDescription: jd
                }
            });
            await new Promise((r) => setTimeout(r, waitMs || 900));
            return {
                ats: form.ats,
                fields: (form.fields || []).map((f) => ({
                    label: f.label,
                    kind: f.kind,
                    type: f.type,
                    combobox: !!f.combobox
                })),
                filled: fill?.fillStats?.filled ?? 0,
                fillOk: fill?.ok
            };
        }, PROFILE, JD, suite.waitMs || 900);

        if (collectFill.error) {
            detail.valueFailures.push(`bootstrap: ${collectFill.error}`);
            return detail;
        }

        detail.ats = collectFill.ats;
        detail.fields = collectFill.fields;
        detail.filled = collectFill.filled;

        if (detail.ats !== suite.expectAts) {
            detail.kindFailures.push(`ATS got=${detail.ats} want=${suite.expectAts}`);
        }

        // Kind map: match by normalized label contains / starts
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        for (const [wantLabel, wantKind] of Object.entries(suite.kindMap)) {
            const hit = detail.fields.find((f) => {
                const a = norm(f.label);
                const b = norm(wantLabel);
                return a === b || a.startsWith(b) || b.startsWith(a) || a.includes(b.slice(0, 40));
            });
            if (!hit) {
                detail.kindFailures.push(`missing field for "${wantLabel}"`);
            } else if (hit.kind !== wantKind) {
                detail.kindFailures.push(
                    `kind "${wantLabel}" → ${hit.kind} (want ${wantKind})`
                );
            }
        }

        const dom = await page.evaluate(suite.snapshot);
        detail.dom = dom;

        for (const [key, rule] of Object.entries(suite.expect)) {
            if (key.endsWith('_not')) {
                const base = key.replace(/_not$/, '');
                const actual = dom[base];
                if (rule instanceof RegExp && rule.test(String(actual ?? ''))) {
                    detail.valueFailures.push(`${base} must NOT match ${rule} (got ${JSON.stringify(actual)})`);
                }
                continue;
            }
            const actual = dom[key];
            if (!matchExpect(actual, rule)) {
                detail.valueFailures.push(
                    `${key}: got ${JSON.stringify(actual)} want ${rule instanceof RegExp ? rule : JSON.stringify(rule)}`
                );
            }
        }

        detail.ok = detail.kindFailures.length === 0 && detail.valueFailures.length === 0;
        return detail;
    } catch (err) {
        detail.valueFailures.push(err.message);
        return detail;
    } finally {
        await page.close().catch(() => {});
    }
}

async function main() {
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (!puppeteer || !exe) {
        console.error('Need puppeteer-core + Chrome');
        process.exit(2);
    }

    const fillSrc = fs.readFileSync(path.join(__dirname, '../content/fill.js'), 'utf8');
    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu']
    });

    const report = [];
    for (const suite of SUITES) {
        // eslint-disable-next-line no-await-in-loop
        const r = await runSuite(browser, fillSrc, suite);
        report.push(r);
        const status = r.ok ? 'PASS' : 'FAIL';
        console.log(`\n======== ${status} ${r.name} (ats=${r.ats}, filled=${r.filled}) ========`);
        console.log('Fields:');
        for (const f of r.fields || []) {
            console.log(`  [${f.kind}] ${String(f.label || '').slice(0, 70)}${f.combobox ? ' [combobox]' : ''}`);
        }
        if (r.kindFailures?.length) {
            console.log('Kind failures:');
            r.kindFailures.forEach((x) => console.log('  -', x));
        }
        if (r.valueFailures?.length) {
            console.log('Value failures:');
            r.valueFailures.forEach((x) => console.log('  -', x));
        }
        if (r.dom) {
            console.log('DOM:', JSON.stringify(r.dom, null, 2));
        }
    }

    await browser.close();

    const outPath = path.join(__dirname, 'ats_detailed_report.json');
    fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), profile: PROFILE, report }, null, 2));
    console.log(`\nWrote ${outPath}`);

    const failed = report.filter((r) => !r.ok).length;
    console.log(JSON.stringify({
        passed: report.length - failed,
        failed,
        platforms: report.map((r) => ({ name: r.name, ok: r.ok, ats: r.ats, filled: r.filled, kinds: r.kindFailures.length, values: r.valueFailures.length }))
    }, null, 2));
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
