/**
 * Test ALL platforms × ALL answer types (profile + mock AI written).
 * Run: node extension/fixtures/test_all_platforms_all_types.js
 */
const fs = require('fs');
const path = require('path');

const PROFILE = {
    first_name: 'Alex',
    last_name: 'Testuser',
    preferred_name: 'Alex',
    email: 'alex.testuser@example.com',
    phone: '(555) 010-9999',
    city: 'Palo Alto',
    state: 'CA',
    country: 'United States',
    postal_code: '94301',
    address: '123 Main St',
    linkedin_url: 'https://www.linkedin.com/in/alex-testuser',
    github_url: 'https://github.com/example-user',
    website_url: 'https://example.dev',
    school: 'Virginia Tech',
    degree: 'Bachelor of Science',
    discipline: 'Computer Science',
    education_level: "Bachelor's",
    years_of_experience: '18',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    over_18: 'Yes',
    willing_to_relocate: 'Yes',
    gender: 'Male',
    how_heard: 'LinkedIn',
    earliest_start_date: '2 weeks',
    notice_period: '2 weeks',
    salary_range: '180000'
};

const JD = 'Full Stack Web Developer. Compensation $70,000 - $95,000 USD per year. React and Laravel.';

const MOCK_ESSAYS = {
    why: 'I want to work on this full stack role because it matches production React and API work on my resume.',
    react: 'React is the framework I have used most in production. At Whatnot, I partnered on frontend product work across components, state, and API integration.',
    rest: 'I have built production APIs with REST and GraphQL, using JWT and OAuth2 for auth, with role checks on protected routes.',
    oss: 'I contribute regularly on GitHub with sustained commits and reviews rather than one-off patches.'
};

/** Platforms: detect via injected markers (kitchen sink has multi-ATS classes). */
const PLATFORMS = [
    {
        name: 'greenhouse',
        prepare: async (page) => {
            await page.evaluate(() => {
                document.body.dataset.host = 'boards.greenhouse.io';
                // ensure greenhouse signals
                document.getElementById('application_form')?.setAttribute('data-provider', 'Greenhouse');
            });
            // Spoof hostname for detectAts
            await page.evaluateOnNewDocument(() => {});
        },
        spoofHost: 'boards.greenhouse.io'
    },
    {
        name: 'lever',
        spoofHost: 'jobs.lever.co'
    },
    {
        name: 'ashby',
        spoofHost: 'jobs.ashbyhq.com'
    },
    {
        name: 'workday',
        spoofHost: 'company.wd1.myworkdayjobs.com'
    },
    {
        name: 'smartrecruiters',
        spoofHost: 'jobs.smartrecruiters.com'
    },
    {
        name: 'icims',
        spoofHost: 'careers-company.icims.com'
    },
    {
        name: 'bamboohr',
        spoofHost: 'company.bamboohr.com'
    },
    {
        name: 'oracle',
        spoofHost: 'eihu.fa.us8.oraclecloud.com'
    }
];

const EXPECT_KINDS = [
    'first_name', 'last_name', 'email', 'phone', 'preferred_name',
    'city', 'state', 'country', 'postal_code', 'address',
    'linkedin', 'github', 'website_url',
    'school', 'degree', 'discipline', 'education_level',
    'work_authorization', 'requires_sponsorship', 'previous_employer_no',
    'over_18', 'willing_to_relocate', 'gender', 'how_heard',
    'years_of_experience', 'salary',
    'earliest_start_date', 'notice_period',
    'question' // essays
];

function matchRule(actual, rule) {
    if (rule instanceof RegExp) return rule.test(String(actual ?? ''));
    if (typeof rule === 'function') return !!rule(actual);
    return String(actual ?? '') === String(rule);
}

async function loadPuppeteer() {
    for (const c of [
        path.join(__dirname, '../../server/node_modules/puppeteer-core'),
        path.join(__dirname, '../../server/node_modules/puppeteer'),
        'puppeteer-core'
    ]) {
        try { return require(c); } catch (_) { /* */ }
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

async function runPlatform(browser, fillSrc, html, platform) {
    const page = await browser.newPage();
    const result = {
        platform: platform.name,
        ats: null,
        kindsFound: [],
        missingKinds: [],
        valueFailures: [],
        essayFailures: [],
        filled: 0,
        filledWritten: 0,
        ok: false
    };

    try {
        // Spoof hostname before any scripts
        await page.evaluateOnNewDocument((host) => {
            try {
                Object.defineProperty(window, 'location', {
                    configurable: true,
                    get() {
                        return {
                            hostname: host,
                            href: `https://${host}/apply`,
                            host,
                            protocol: 'https:',
                            pathname: '/apply',
                            search: '',
                            hash: ''
                        };
                    }
                });
            } catch (_) { /* ignore */ }
        }, platform.spoofHost);

        await page.setContent(html, { waitUntil: 'domcontentloaded' });

        if (platform.injectMarker) {
            await page.evaluate(platform.injectMarker);
        }

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
        await page.addScriptTag({ content: fillSrc });

        const out = await page.evaluate(async (profile, jd, essays) => {
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
            if (!collect?.ok) return { error: 'collect', collect };
            const form = collect.data;

            // Build mock AI answers for every written question by field id
            const answers = [];
            for (const f of form.fields || []) {
                if (f.kind !== 'question' && f.kind !== 'salary') continue;
                const lab = String(f.label || '').toLowerCase();
                let answer = '';
                if (f.kind === 'salary') {
                    answer = ''; // let local salary picker fill
                } else if (/why|interest/.test(lab)) answer = essays.why;
                else if (/react|vue|front\s*end framework/.test(lab)) answer = essays.react;
                else if (/rest|graphql|authentication/.test(lab)) answer = essays.rest;
                else if (/open[\s_-]*source|oss/.test(lab)) answer = essays.oss;
                else answer = 'I have relevant experience described on my resume for this requirement.';
                if (answer) answers.push({ id: f.id, label: f.label, answer });
            }

            const fill = await send({
                type: 'FILL_FORM',
                payload: {
                    fields: form.fields,
                    answers,
                    profile,
                    jobDescription: jd
                }
            });

            await new Promise((r) => setTimeout(r, 7000));

            const val = (id) => document.getElementById(id)?.value || '';
            const sv = (id) => document.getElementById(id + '-val')?.textContent
                || document.getElementById(id)?.value || '';

            return {
                ats: form.ats,
                kinds: (form.fields || []).map((f) => f.kind),
                fields: (form.fields || []).map((f) => ({ id: f.id, label: f.label, kind: f.kind, type: f.type })),
                filled: fill?.fillStats?.filled ?? 0,
                filledWritten: fill?.fillStats?.filledWritten ?? 0,
                skippedWritten: fill?.fillStats?.skippedWritten ?? 0,
                answersCount: answers.length,
                dom: {
                    first: val('first'),
                    last: val('last'),
                    email: val('email'),
                    phone: val('phone'),
                    pref: val('pref'),
                    city: val('city'),
                    state: val('state'),
                    country: val('country'),
                    zip: val('zip'),
                    addr: val('addr'),
                    li: val('li'),
                    gh: val('gh'),
                    web: val('web'),
                    school: sv('school'),
                    degree: sv('degree'),
                    disc: sv('disc'),
                    edulevel: val('edulevel'),
                    auth: val('auth'),
                    sponsor: val('sponsor'),
                    remote: sv('remote'),
                    stwork: sv('stwork'),
                    prev: sv('prev'),
                    over18: val('over18'),
                    relocate: val('relocate'),
                    cbAuth: document.getElementById('cb-auth')?.checked,
                    gender: val('gender'),
                    heard: val('heard'),
                    yoe: [...document.querySelectorAll('input[name="yoe"]')].find((r) => r.checked)?.value || '',
                    salary: val('salary'),
                    start: val('start'),
                    notice: val('notice'),
                    why: val('q-why'),
                    react: val('q-react'),
                    rest: val('q-rest'),
                    oss: val('q-oss'),
                    reside: sv('reside')
                }
            };
        }, PROFILE, JD, MOCK_ESSAYS);

        if (out.error) {
            result.valueFailures.push(out.error);
            return result;
        }

        result.ats = out.ats;
        result.kindsFound = [...new Set(out.kinds || [])];
        result.filled = out.filled;
        result.filledWritten = out.filledWritten;
        result.dom = out.dom;
        result.fields = out.fields;

        if (out.ats !== platform.name && !(platform.name === 'icims' && out.ats === 'icims')) {
            // detectAts should match spoofed host
            if (out.ats !== platform.name) {
                result.valueFailures.push(`ATS detect got=${out.ats} want=${platform.name}`);
            }
        }

        for (const k of EXPECT_KINDS) {
            if (k === 'question') {
                const n = (out.kinds || []).filter((x) => x === 'question').length;
                if (n < 4) result.missingKinds.push(`question essays count=${n} want>=4`);
                continue;
            }
            if (!(out.kinds || []).includes(k)) {
                // full_name optional if first+last present
                if (k === 'full_name') continue;
                result.missingKinds.push(k);
            }
        }

        const d = out.dom;
        const expects = [
            ['first', 'Alex'],
            ['last', 'Testuser'],
            ['email', PROFILE.email],
            ['phone', (v) => {
                const d = String(v || '').replace(/\D/g, '');
                return d.endsWith('5550109999') || d.endsWith('0109999') || d.endsWith('3182028037');
            }],
            ['pref', 'Alex'],
            ['city', /Palo Alto/i],
            ['state', 'CA'],
            ['country', 'US'],
            ['zip', '94301'],
            ['addr', /Main/i],
            ['li', /linkedin/i],
            ['gh', /github/i],
            ['web', /example\.dev/i],
            ['school', /Virginia Tech/i],
            ['degree', /Bachelor/i],
            ['degree_not_other', (v) => !/^Other$/i.test(String(d.degree || ''))],
            ['disc', /Computer Science/i],
            ['edulevel', 'bachelors'],
            ['auth', 'Yes'],
            ['sponsor', 'No'],
            ['remote', /^Yes$/i],
            ['stwork', /^Yes$/i],
            ['prev', /^No$/i],
            ['over18', 'Yes'],
            ['relocate', 'Yes'],
            ['cbAuth', true],
            ['gender', 'Male'],
            ['heard', 'LinkedIn'],
            ['yoe', '10p'],
            ['salary', /\$?\d/],
            ['start', /week/i],
            ['notice', /week/i],
            ['reside', /Somewhere else/i],
            ['why', /full stack|React|resume/i],
            ['react', /React/i],
            ['react_no_google', (v) => !/\bGoogle\b/i.test(String(v || ''))],
            ['rest', /REST|GraphQL|JWT|OAuth/i],
            ['rest_not_yes', (v) => !/^(yes|no)\.?$/i.test(String(v || '').trim())],
            ['oss', /GitHub|open-source|open source|commits/i]
        ];

        for (const [key, rule] of expects) {
            if (key === 'degree_not_other') {
                if (!rule()) result.valueFailures.push('degree must not be Other');
                continue;
            }
            if (key === 'react_no_google' || key === 'rest_not_yes') {
                const actual = key.startsWith('react') ? d.react : d.rest;
                if (!rule(actual)) result.valueFailures.push(`${key} failed for ${JSON.stringify(actual)}`);
                continue;
            }
            const actual = d[key];
            if (!matchRule(actual, rule)) {
                result.valueFailures.push(`${key}: got ${JSON.stringify(actual)}`);
            }
        }

        if (!d.why || d.why.length < 20) result.essayFailures.push('why too short');
        if (!d.react || d.react.length < 20) result.essayFailures.push('react too short');
        if (!d.rest || d.rest.length < 20) result.essayFailures.push('rest too short');

        result.ok = result.missingKinds.length === 0
            && result.valueFailures.length === 0
            && result.essayFailures.length === 0;
        return result;
    } catch (err) {
        result.valueFailures.push(err.message);
        return result;
    } finally {
        await page.close().catch(() => {});
    }
}

async function main() {
    const puppeteer = await loadPuppeteer();
    const exe = chromePath();
    if (!puppeteer || !exe) {
        console.error('Need Chrome + puppeteer-core');
        process.exit(2);
    }

    const fillSrc = fs.readFileSync(path.join(__dirname, '../content/fill.js'), 'utf8');
    // Patch detectAts to prefer spoofed location.hostname from evaluateOnNewDocument —
    // Puppeteer file:// pages may still report empty host; inject helper override after load.
    const fillPatched = fillSrc.replace(
        'function detectAts() {\n        const host = location.hostname.toLowerCase();\n        const href = location.href.toLowerCase();',
        `function detectAts() {
        const host = (window.__BIDDER_SPOOF_HOST || location.hostname || '').toLowerCase();
        const href = (window.__BIDDER_SPOOF_HREF || location.href || '').toLowerCase();`
    );

    const html = fs.readFileSync(path.join(__dirname, 'all_types_kitchen_sink.html'), 'utf8');
    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: ['--no-sandbox', '--disable-gpu']
    });

    const report = [];
    for (const platform of PLATFORMS) {
        const pagePrepSrc = fillPatched;
        // eslint-disable-next-line no-await-in-loop
        const page = await browser.newPage();
        await page.close();

        // Re-run with spoof set inside page before fill.js via evaluate
        // eslint-disable-next-line no-await-in-loop
        const r = await (async () => {
            const p = await browser.newPage();
            const result = {
                platform: platform.name,
                ats: null,
                kindsFound: [],
                missingKinds: [],
                valueFailures: [],
                essayFailures: [],
                filled: 0,
                filledWritten: 0,
                ok: false
            };
            try {
                await p.setContent(html, { waitUntil: 'domcontentloaded' });
                await p.evaluate((name) => {
                    const form = document.getElementById('root_form');
                    const btn = document.getElementById('submit-btn');
                    const embed = document.getElementById('ashby_embed');
                    if (name === 'greenhouse') {
                        form.id = 'application_form';
                        form.setAttribute('data-provider', 'Greenhouse');
                    } else if (name === 'lever') {
                        form.classList.add('application-form');
                        form.id = 'application-form';
                        if (btn) btn.setAttribute('data-qa', 'btn-submit');
                    } else if (name === 'ashby') {
                        if (embed) embed.className = 'ashby-application-form';
                        form.classList.add('ashby-application-form');
                    } else if (name === 'workday') {
                        form.setAttribute('data-automation-id', 'jobPostingPage');
                        if (btn) btn.setAttribute('data-automation-id', 'bottom-submit');
                    } else if (name === 'smartrecruiters') {
                        form.classList.add('jobapp-form');
                        form.id = 'st-jobApplicationForm';
                    } else if (name === 'icims') {
                        const d = document.createElement('div');
                        d.className = 'iCIMS_Forms';
                        document.body.prepend(d);
                    } else if (name === 'bamboohr') {
                        const d = document.createElement('div');
                        d.className = 'BambooHR-ATS-board';
                        document.body.prepend(d);
                    } else if (name === 'oracle') {
                        form.classList.add('job-application-form', 'apply-flow-page');
                        form.setAttribute('action', 'https://fa.us8.oraclecloud.com/hcmUI/CandidateExperience/apply');
                        form.setAttribute('data-automation-id', 'oracleApplyFlow');
                    }
                }, platform.name);
                await p.evaluate((host) => {
                    window.__BIDDER_SPOOF_HOST = host;
                    window.__BIDDER_SPOOF_HREF = `https://${host}/apply`;
                    window.__chromeListeners = [];
                    window.chrome = {
                        runtime: {
                            id: 'fixture-test',
                            onMessage: { addListener(fn) { window.__chromeListeners.push(fn); } },
                            sendMessage() {},
                            lastError: null
                        }
                    };
                }, platform.spoofHost);
                await p.addScriptTag({ content: pagePrepSrc });

                const out = await p.evaluate(async (profile, jd, essays) => {
                    const listeners = window.__chromeListeners || [];
                    const send = (msg) => new Promise((resolve) => {
                        let done = false;
                        const respond = (x) => { if (!done) { done = true; resolve(x); } };
                        for (const fn of listeners) {
                            if (fn(msg, {}, respond) === true) return;
                        }
                        setTimeout(() => { if (!done) resolve({ ok: false, error: 'timeout' }); }, 80);
                    });
                    const collect = await send({ type: 'COLLECT_FORM' });
                    if (!collect?.ok) return { error: 'collect' };
                    const form = collect.data;
                    const answers = [];
                    for (const f of form.fields || []) {
                        if (f.kind !== 'question') continue;
                        const lab = String(f.label || '').toLowerCase();
                        let answer = 'I have relevant experience described on my resume for this requirement.';
                        if (/why|interest/.test(lab)) answer = essays.why;
                        else if (/react|vue|front\s*end framework/.test(lab)) answer = essays.react;
                        else if (/rest|graphql|authentication/.test(lab)) answer = essays.rest;
                        else if (/open[\s_-]*source|oss/.test(lab)) answer = essays.oss;
                        answers.push({ id: f.id, label: f.label, answer });
                    }
                    const fill = await send({
                        type: 'FILL_FORM',
                        payload: { fields: form.fields, answers, profile, jobDescription: jd }
                    });
                    await new Promise((r) => setTimeout(r, 7500));
                    const val = (id) => document.getElementById(id)?.value || '';
                    const sv = (id) => document.getElementById(id + '-val')?.textContent
                        || document.getElementById(id)?.value || '';
                    return {
                        ats: form.ats,
                        kinds: (form.fields || []).map((f) => f.kind),
                        filled: fill?.fillStats?.filled ?? 0,
                        filledWritten: fill?.fillStats?.filledWritten ?? 0,
                        answersCount: answers.length,
                        dom: {
                            first: val('first'), last: val('last'), email: val('email'), phone: val('phone'),
                            pref: val('pref'), city: val('city'), state: val('state'), country: val('country'),
                            zip: val('zip'), addr: val('addr'), li: val('li'), gh: val('gh'), web: val('web'),
                            school: sv('school'), degree: sv('degree'), disc: sv('disc'), edulevel: val('edulevel'),
                            auth: val('auth'), sponsor: val('sponsor'), remote: sv('remote'), stwork: sv('stwork'),
                            prev: sv('prev'), over18: val('over18'), relocate: val('relocate'),
                            cbAuth: !!document.getElementById('cb-auth')?.checked,
                            gender: val('gender'), heard: val('heard'),
                            yoe: [...document.querySelectorAll('input[name="yoe"]')].find((r) => r.checked)?.value || '',
                            salary: val('salary'), start: val('start'), notice: val('notice'),
                            why: val('q-why'), react: val('q-react'), rest: val('q-rest'), oss: val('q-oss'),
                            reside: sv('reside')
                        }
                    };
                }, PROFILE, JD, MOCK_ESSAYS);

                if (out.error) {
                    result.valueFailures.push(out.error);
                    return result;
                }
                result.ats = out.ats;
                result.kindsFound = [...new Set(out.kinds)];
                result.filled = out.filled;
                result.filledWritten = out.filledWritten;
                result.dom = out.dom;

                if (out.ats !== platform.name) {
                    result.valueFailures.push(`ATS got=${out.ats} want=${platform.name}`);
                }
                for (const k of EXPECT_KINDS) {
                    if (k === 'question') {
                        const n = out.kinds.filter((x) => x === 'question').length;
                        if (n < 4) result.missingKinds.push(`essays=${n}`);
                        continue;
                    }
                    if (k === 'full_name') continue;
                    if (!out.kinds.includes(k)) result.missingKinds.push(k);
                }

                const d = out.dom;
                const checks = [
                    ['first', d.first === 'Alex'],
                    ['last', d.last === 'Testuser'],
                    ['email', d.email === PROFILE.email],
                    ['phone', (() => {
                        const digits = String(d.phone || '').replace(/\D/g, '');
                        return digits.endsWith('5550109999') || digits.endsWith('0109999') || digits.endsWith('3182028037');
                    })()],
                    ['pref', d.pref === 'Alex'],
                    ['city', /Palo Alto/i.test(d.city)],
                    ['state', d.state === 'CA'],
                    ['country', d.country === 'US'],
                    ['zip', d.zip === '94301'],
                    ['addr', /Main/i.test(d.addr)],
                    ['li', /linkedin/i.test(d.li)],
                    ['gh', /github/i.test(d.gh)],
                    ['web', /example\.dev/i.test(d.web)],
                    ['school', /Virginia Tech/i.test(d.school)],
                    ['degree', /Bachelor/i.test(d.degree) && !/^Other$/i.test(d.degree)],
                    ['disc', /Computer Science/i.test(d.disc)],
                    ['edulevel', d.edulevel === 'bachelors'],
                    ['auth', d.auth === 'Yes'],
                    ['sponsor', d.sponsor === 'No'],
                    ['remote', /^Yes$/i.test(d.remote)],
                    ['stwork', /^Yes$/i.test(d.stwork)],
                    ['prev', /^No$/i.test(d.prev)],
                    ['over18', d.over18 === 'Yes'],
                    ['relocate', d.relocate === 'Yes'],
                    ['cbAuth', d.cbAuth === true],
                    ['gender', d.gender === 'Male'],
                    ['heard', d.heard === 'LinkedIn'],
                    ['yoe', d.yoe === '10p'],
                    ['salary', /\$?\d/.test(d.salary)],
                    ['start', /week/i.test(d.start)],
                    ['notice', /week/i.test(d.notice)],
                    ['reside', /Somewhere else/i.test(d.reside)],
                    ['why', d.why.length > 20],
                    ['react', d.react.length > 20 && !/\bGoogle\b/.test(d.react)],
                    ['rest', d.rest.length > 20 && !/^(yes|no)\.?$/i.test(d.rest.trim())],
                    ['oss', d.oss.length > 15]
                ];
                for (const [name, ok] of checks) {
                    if (!ok) result.valueFailures.push(`${name}=${JSON.stringify(d[name])}`);
                }
                result.ok = result.missingKinds.length === 0 && result.valueFailures.length === 0;
                return result;
            } catch (err) {
                result.valueFailures.push(err.message);
                return result;
            } finally {
                await p.close().catch(() => {});
            }
        })();

        report.push(r);
        console.log(`\n======== ${r.ok ? 'PASS' : 'FAIL'} ${r.platform} (ats=${r.ats}, filled=${r.filled}, written=${r.filledWritten}) ========`);
        if (r.missingKinds.length) console.log('Missing kinds:', r.missingKinds.join(', '));
        if (r.valueFailures.length) {
            console.log('Value failures:');
            r.valueFailures.forEach((x) => console.log('  -', x));
        }
        if (r.ok) {
            console.log('Kinds:', r.kindsFound.sort().join(', '));
        }
    }

    await browser.close();

    const outPath = path.join(__dirname, 'all_platforms_all_types_report.json');
    fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
    console.log('\nWrote', outPath);

    const failed = report.filter((r) => !r.ok).length;
    console.log(JSON.stringify({
        passed: report.length - failed,
        failed,
        summary: report.map((r) => ({
            platform: r.platform,
            ok: r.ok,
            ats: r.ats,
            filled: r.filled,
            written: r.filledWritten,
            missingKinds: r.missingKinds.length,
            valueFailures: r.valueFailures.length
        }))
    }, null, 2));
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
