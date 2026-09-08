/**
 * Hard-case autofill training — many difficult Greenhouse-style situations.
 * Run: node extension/fixtures/test_autofill_hard_cases.js
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

const HTML = fs.readFileSync(path.join(__dirname, 'greenhouse_hard_cases.html'), 'utf8');

const BASE_PROFILE = {
    first_name: 'Alex',
    last_name: 'Testuser',
    email: 'alex.testuser@example.com',
    phone: '(555) 010-9999',
    city: 'Palo Alto',
    state: 'CA',
    country: 'United States',
    school: 'Virginia Tech',
    degree: 'Bachelor of Science',
    discipline: 'Computer Science',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    notice_period: '2 weeks',
    willing_to_relocate: 'Yes',
    how_heard: 'LinkedIn',
    gender: 'Male',
    years_of_experience: '18',
    linkedin_url: 'https://www.linkedin.com/in/alex-testuser',
    github_url: 'https://github.com/example-user',
    earliest_start_date: '2 weeks',
    over_18: 'Yes'
};

const JD = 'Full Stack Developer. Compensation $70,000 - $95,000 USD per year.';
const JD_HIGH = 'Senior Engineer. Base compensation $140,000 - $180,000 USD.';

/** @type {Array<object>} */
const SCENARIOS = [
    {
        name: 'default-profile compliance + education',
        profile: { ...BASE_PROFILE, salary_range: '120000' },
        jd: JD,
        waitMs: 12000,
        classify: {
            sponsor: 'requires_sponsorship',
            salary: 'salary',
            nda: 'data_protection',
            'ai-note': 'data_protection',
            disc: 'discipline',
            workauth: 'work_authorization',
            'salary-range': 'salary',
            privacy: 'data_protection',
            notice: 'notice_period',
            school: 'school',
            degree: 'degree',
            country: 'country',
            'prev-emp': 'previous_employer_no',
            over18: 'over_18',
            relocate: 'willing_to_relocate',
            heard: 'how_heard',
            gender: 'gender',
            linkedin: 'linkedin',
            github: 'github',
            gdpr: 'data_protection',
            'start-date': 'earliest_start_date',
            'salary-k': 'salary',
            reside: 'city',
            first: 'first_name',
            last: 'last_name',
            email: 'email'
        },
        dom: {
            sponsor: 'No',
            salary: (v) => /\d/.test(v) && !/^select/i.test(v),
            nda: 'Yes',
            'ai-note': 'Yes',
            disc: 'Computer Science',
            workauth: 'Yes',
            'salary-range': (v) => /\$/.test(v) || /100|120|80|60/.test(v),
            privacy: (v) => /acknowledg/i.test(v),
            notice: '2 weeks',
            school: 'Virginia Tech',
            degree: (v) => /bachelor/i.test(v),
            country: 'United States',
            'prev-emp': 'No',
            over18: 'Yes',
            relocate: 'Yes',
            heard: 'LinkedIn',
            gender: (v) => /man|male/i.test(v),
            linkedin: (v) => /linkedin\.com/i.test(v),
            github: (v) => /github\.com/i.test(v),
            gdpr: (v) => /agree/i.test(v) && !/do not/i.test(v),
            terms: true,
            'start-date': (v) => /2 weeks|week/i.test(v),
            first: 'Alex',
            last: 'Testuser',
            email: 'alex.testuser@example.com'
        }
    },
    {
        name: 'empty salary falls back to default',
        profile: { ...BASE_PROFILE, salary_range: '' },
        jd: '',
        waitMs: 10000,
        dom: {
            salary: (v) => {
                const n = String(v).replace(/[^\d]/g, '');
                return n.length >= 5 && parseInt(n, 10) >= 100000;
            },
            'salary-range': (v) => v && v !== 'Select...'
        }
    },
    {
        name: 'sponsorship required Yes',
        profile: { ...BASE_PROFILE, requires_sponsorship: 'Yes' },
        waitMs: 10000,
        dom: {
            sponsor: 'Yes',
            workauth: 'Yes'
        }
    },
    {
        name: 'consent traps — must pick Yes not I do not consent',
        profile: BASE_PROFILE,
        waitMs: 10000,
        dom: {
            nda: (v) => /^yes$/i.test(String(v).trim()),
            'ai-note': (v) => /^yes$/i.test(String(v).trim()),
            privacy: (v) => /acknowledg/i.test(v) && !/do not consent/i.test(v),
            gdpr: (v) => /^i agree$/i.test(String(v).trim())
        }
    },
    {
        name: 'discipline typeahead after loading',
        profile: { ...BASE_PROFILE, discipline: '' },
        waitMs: 12000,
        dom: {
            disc: (v) => v === 'Computer Science' || v === 'Other'
        }
    },
    {
        name: 'salary range select matches JD midpoint',
        profile: { ...BASE_PROFILE, salary_range: '120000' },
        jd: JD,
        waitMs: 10000,
        dom: {
            'salary-range': (v) => /60|80|100|120/.test(String(v))
        }
    },
    {
        name: 'work auth Yes separate from sponsorship No',
        profile: { ...BASE_PROFILE, requires_sponsorship: 'No', work_authorization: 'Yes' },
        waitMs: 10000,
        dom: {
            sponsor: 'No',
            workauth: 'Yes'
        }
    },
    {
        name: 'notice period free text',
        profile: { ...BASE_PROFILE, notice_period: '30 days' },
        waitMs: 10000,
        dom: {
            notice: (v) => /30/.test(v)
        }
    },
    {
        name: 'school delayed typeahead',
        profile: BASE_PROFILE,
        waitMs: 12000,
        dom: {
            school: 'Virginia Tech'
        }
    },
    {
        name: 'degree synonym Bachelor of Science → Bachelor\'s Degree',
        profile: { ...BASE_PROFILE, degree: 'Bachelor of Science' },
        waitMs: 12000,
        dom: {
            degree: (v) => /bachelor/i.test(v)
        }
    },
    {
        name: 'gender Male maps to Man',
        profile: { ...BASE_PROFILE, gender: 'Male' },
        waitMs: 10000,
        dom: {
            gender: (v) => /man/i.test(v)
        }
    },
    {
        name: 'previous employer defaults No',
        profile: BASE_PROFILE,
        waitMs: 10000,
        dom: {
            'prev-emp': 'No'
        }
    },
    {
        name: 'where are you located US-hire list → state California',
        profile: BASE_PROFILE,
        waitMs: 10000,
        classify: {
            located: 'state'
        },
        dom: {
            located: (v) => /california|^ca$/i.test(String(v))
        }
    },
    {
        name: 'over 18 default Yes',
        profile: { ...BASE_PROFILE, over_18: '' },
        waitMs: 10000,
        dom: {
            over18: 'Yes'
        }
    },
    {
        name: 'relocate Yes',
        profile: { ...BASE_PROFILE, willing_to_relocate: 'Yes' },
        waitMs: 10000,
        dom: {
            relocate: 'Yes'
        }
    },
    {
        name: 'how heard LinkedIn',
        profile: { ...BASE_PROFILE, how_heard: 'LinkedIn' },
        waitMs: 10000,
        dom: {
            heard: 'LinkedIn'
        }
    },
    {
        name: 'links linkedin + github',
        profile: BASE_PROFILE,
        waitMs: 10000,
        dom: {
            linkedin: (v) => /linkedin\.com\/in\/alex-testuser/i.test(v),
            github: (v) => /github\.com\/example/i.test(v)
        }
    },
    {
        name: 'YOE radios pick 10+',
        profile: { ...BASE_PROFILE, years_of_experience: '18' },
        waitMs: 10000,
        dom: {
            yoe: '10p'
        }
    },
    {
        name: 'terms checkbox checked',
        profile: BASE_PROFILE,
        waitMs: 10000,
        dom: {
            terms: true
        }
    },
    {
        name: 'high JD salary band 120-150',
        profile: { ...BASE_PROFILE, salary_range: '160000' },
        jd: JD_HIGH,
        waitMs: 10000,
        dom: {
            salary: (v) => {
                const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
                return n >= 140000 && n <= 180000;
            },
            'salary-range': (v) => /120/.test(String(v))
        }
    },
    {
        name: 'salary-k select picks near JD',
        profile: { ...BASE_PROFILE, salary_range: '120000' },
        jd: JD,
        waitMs: 10000,
        dom: {
            'salary-k': (v) => /70k|80k|90k|100k|120k/i.test(String(v))
        }
    },
    {
        name: 'reside city typeahead',
        profile: BASE_PROFILE,
        waitMs: 12000,
        dom: {
            reside: (v) => /palo alto|california|somewhere else/i.test(v)
        }
    },
    {
        name: 'contact fields filled',
        profile: BASE_PROFILE,
        waitMs: 10000,
        dom: {
            first: 'Alex',
            last: 'Testuser',
            email: 'alex.testuser@example.com'
        }
    },
    {
        name: 'double-fill does not clear sponsorship',
        profile: BASE_PROFILE,
        waitMs: 10000,
        fillTwice: true,
        dom: {
            sponsor: 'No',
            workauth: 'Yes',
            nda: 'Yes',
            first: 'Alex'
        }
    },
    {
        name: 'sponsorship No + auth No profile still fills auth No',
        profile: { ...BASE_PROFILE, work_authorization: 'No', requires_sponsorship: 'No' },
        waitMs: 10000,
        dom: {
            sponsor: 'No',
            workauth: 'No'
        }
    }
];

function matchRule(actual, rule) {
    if (typeof rule === 'boolean') return !!actual === rule;
    const v = String(actual ?? '').trim();
    if (rule instanceof RegExp) return rule.test(v);
    if (typeof rule === 'function') return !!rule(v);
    return v.toLowerCase() === String(rule).toLowerCase();
}

function isIncompleteSelect(v) {
    if (typeof v === 'boolean') return false;
    const t = String(v ?? '').trim();
    return !t || /^select(\.\.\.|…|:)?$/i.test(t) || /^loading/i.test(t);
}

async function readDom(page) {
    return page.evaluate(() => {
        const sv = (id) => {
            const v = document.getElementById(id + '-val');
            const ph = document.getElementById(id + '-ph');
            if (v && v.textContent && !/^select/i.test(v.textContent.trim())) return v.textContent.trim();
            if (ph && ph.style.display !== 'none' && ph.textContent && /^select/i.test(ph.textContent.trim())) return '';
            return document.getElementById(id)?.value || '';
        };
        const selText = (id) => {
            const sel = document.getElementById(id);
            if (!sel || sel.tagName !== 'SELECT') return '';
            const opt = sel.options[sel.selectedIndex];
            return opt ? opt.textContent.trim() : '';
        };
        const yoe = document.querySelector('input[name="yoe"]:checked');
        return {
            sponsor: sv('sponsor'),
            salary: document.getElementById('salary')?.value || '',
            nda: sv('nda'),
            'ai-note': sv('ai-note'),
            disc: sv('disc'),
            workauth: sv('workauth'),
            'salary-range': document.getElementById('salary-range')?.value || '',
            privacy: selText('privacy'),
            notice: document.getElementById('notice')?.value || '',
            school: sv('school'),
            degree: sv('degree'),
            country: sv('country'),
            'prev-emp': sv('prev-emp'),
            over18: selText('over18'),
            relocate: sv('relocate'),
            heard: selText('heard'),
            gender: selText('gender'),
            yoe: yoe ? yoe.value : '',
            linkedin: document.getElementById('linkedin')?.value || '',
            github: document.getElementById('github')?.value || '',
            gdpr: selText('gdpr'),
            terms: !!document.getElementById('terms')?.checked,
            'start-date': document.getElementById('start-date')?.value || '',
            'salary-k': document.getElementById('salary-k')?.value || '',
            reside: sv('reside'),
            located: selText('located'),
            first: document.getElementById('first')?.value || '',
            last: document.getElementById('last')?.value || '',
            email: document.getElementById('email')?.value || ''
        };
    });
}

async function runScenario(browser, scenario) {
    const page = await browser.newPage();
    const result = {
        name: scenario.name,
        ok: true,
        classifyFailures: [],
        domFailures: [],
        incomplete: [],
        fields: []
    };

    try {
        await page.evaluateOnNewDocument(() => {
            try {
                Object.defineProperty(window, 'location', {
                    configurable: true,
                    get() {
                        return {
                            hostname: 'boards.greenhouse.io',
                            href: 'https://boards.greenhouse.io/apply',
                            host: 'boards.greenhouse.io',
                            protocol: 'https:',
                            pathname: '/apply',
                            search: '',
                            hash: ''
                        };
                    }
                });
            } catch (_) { /* ignore */ }
        });

        await page.setContent(HTML, { waitUntil: 'domcontentloaded' });
        await injectAutofill(page, loadFillScript());

        const fillOpts = {
            profile: scenario.profile || BASE_PROFILE,
            jobDescription: scenario.jd ?? JD,
            waitMs: scenario.waitMs || 10000
        };

        let out = await collectAndFill(page, fillOpts);
        if (scenario.fillTwice) {
            out = await collectAndFill(page, { ...fillOpts, waitMs: Math.min(fillOpts.waitMs, 8000) });
        }

        if (out.error) {
            result.ok = false;
            result.error = out.error;
            return result;
        }

        result.fields = out.fields || [];
        result.fillStats = out.fillStats || {};

        if (scenario.classify) {
            for (const [id, wantKind] of Object.entries(scenario.classify)) {
                const f = result.fields.find((x) => x.id === id);
                if (!f) {
                    result.classifyFailures.push({ id, wantKind, actual: '(missing)' });
                    continue;
                }
                if (f.kind !== wantKind) {
                    result.classifyFailures.push({ id, wantKind, actual: f.kind, label: f.label });
                }
            }
        }

        const dom = await readDom(page);
        result.domSnapshot = dom;

        for (const [id, rule] of Object.entries(scenario.dom || {})) {
            const actual = dom[id];
            if (typeof rule !== 'boolean' && isIncompleteSelect(actual)) {
                result.incomplete.push({ id, actual: actual || '(empty)' });
            }
            if (!matchRule(actual, rule)) {
                result.domFailures.push({ id, expected: String(rule), actual: String(actual ?? '(empty)') });
            }
        }

        if (result.classifyFailures.length || result.domFailures.length || result.incomplete.length) {
            result.ok = false;
        }
    } catch (e) {
        result.ok = false;
        result.error = e.message;
    } finally {
        await page.close();
    }

    return result;
}

async function main() {
    const puppeteer = await loadPuppeteer();
    if (!puppeteer) {
        console.error('FAIL: puppeteer not found');
        process.exit(1);
    }
    const exe = chromePath();
    if (!exe) {
        console.error('FAIL: Chrome not found');
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let passed = 0;
    let failed = 0;

    console.log(`=== Autofill hard-case training (${SCENARIOS.length} scenarios) ===\n`);

    for (const scenario of SCENARIOS) {
        const r = await runScenario(browser, scenario);
        if (r.ok) {
            passed += 1;
            console.log(`PASS  ${r.name}`);
        } else {
            failed += 1;
            console.log(`FAIL  ${r.name}`);
            if (r.error) console.log(`      error: ${r.error}`);
            if (r.fillStats) console.log(`      fillStats: ${JSON.stringify(r.fillStats)}`);
            for (const c of r.classifyFailures) {
                console.log(`      classify ${c.id}: want ${c.wantKind}, got ${c.actual}${c.label ? ` (${String(c.label).slice(0, 50)}…)` : ''}`);
            }
            for (const d of r.domFailures) {
                console.log(`      dom ${d.id}: want ${d.expected}, got ${d.actual}`);
            }
            for (const i of r.incomplete) {
                console.log(`      incomplete ${i.id}: ${i.actual}`);
            }
        }
    }

    await browser.close();

    console.log(`\n=== ${passed} passed, ${failed} failed (${SCENARIOS.length} scenarios) ===`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
