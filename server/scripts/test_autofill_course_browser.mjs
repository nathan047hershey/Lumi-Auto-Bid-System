/**
 * Browser autofill course:
 * 1) API login → generate-answers (JD+CV)
 * 2) Open fixture apply form
 * 3) Fill fields like the extension (answers + profile)
 * 4) Assert values land in the DOM
 *
 * Run: node server/scripts/test_autofill_course_browser.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
require('dotenv').config({ path: path.join(root, 'server', '.env') });
require('dotenv').config({ path: path.join(root, 'server', 'local.env'), override: true });
const axios = require('axios');

const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';
const BROWSER = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.claude',
    'skills',
    'browser-automation',
    'browser.mjs'
);
const FIXTURE = path.join(__dirname, 'fixtures', 'apply-form.html');

function personalValue(kind, profile) {
    if (!profile) return '';
    switch (kind) {
        case 'first_name': return profile.first_name || '';
        case 'last_name': return profile.last_name || '';
        case 'email': return profile.email || '';
        case 'phone': return profile.phone || '';
        case 'work_authorization': return profile.work_authorization || '';
        default: return '';
    }
}

async function main() {
    const report = { ok: [], fail: [], details: {} };

    // --- API course ---
    let token;
    for (const cred of [
        { username: 'bob', password: 'bob123' },
        { username: 'vincent', password: '123456' },
        { username: 'admin', password: 'admin123' }
    ]) {
        try {
            const { data } = await axios.post(`${BASE}/auth/login`, cred, { timeout: 10000 });
            token = data.token;
            if (token) {
                report.ok.push(`login:${cred.username}`);
                report.details.user = cred.username;
                break;
            }
        } catch (e) {
            report.details[`login_${cred.username}`] = e.response?.data || e.message;
        }
    }
    if (!token) {
        report.fail.push('login');
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
    }
    const headers = { Authorization: `Bearer ${token}` };

    const { data: profilesRaw } = await axios.get(`${BASE}/user/profiles`, { headers, timeout: 10000 });
    const list = Array.isArray(profilesRaw) ? profilesRaw : (profilesRaw.profiles || []);
    const profile = list[0];
    if (!profile) {
        report.fail.push('no_profile');
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
    }
    report.ok.push('profiles');
    report.details.profile_id = profile.id;
    report.details.work_authorization = profile.work_authorization || null;

    const jd =
        'Software Engineer at Acme. Build React and Node services. ' +
        'Compensation: $140,000 - $180,000 USD. Must be authorized to work in the US. ' +
        '3+ years experience preferred.';

    const questions = [
        { id: 'q_why', label: 'Why do you want this role?', type: 'textarea' },
        { id: 'q_sal', label: 'Expected salary / compensation', type: 'text' },
        { id: 'q_auth', label: 'Are you authorized to work in the US?', type: 'text' },
        { id: 'q_react', label: 'Years of experience with React', type: 'text' }
    ];

    let answersPayload;
    try {
        const res = await axios.post(
            `${BASE}/user/generate-answers`,
            {
                profile_id: profile.id,
                job_description: jd,
                resume_html:
                    `<p>${profile.first_name || 'Candidate'} ${profile.last_name || ''}</p>` +
                    '<p>5 years React and Node.js. Built APIs and UI for SaaS products.</p>',
                company_name: 'Acme',
                job_role: 'Software Engineer',
                questions
            },
            { headers, timeout: 180000 }
        );
        answersPayload = res.data;
    } catch (e) {
        report.fail.push(`generate_answers_http: ${e.response?.data?.error || e.message}`);
        report.details.generate_answers_error = e.response?.data || e.message;
        console.log(JSON.stringify(report, null, 2));
        process.exit(2);
    }

    const answers = answersPayload.answers || [];
    const skipped = answersPayload.skipped || [];
    const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
    report.details.answers = answers.map((a) => ({
        id: a.id,
        source: a.source || a.answer_type || null,
        answer: String(a.answer || '').slice(0, 100)
    }));
    report.details.skipped = skipped;
    report.details.provider = answersPayload.provider;
    report.details.model = answersPayload.model;

    if (byId.q_sal?.answer) report.ok.push('api_salary');
    else report.fail.push('api_salary');
    if (byId.q_why?.answer) report.ok.push('api_why');
    else report.fail.push('api_why');
    if (byId.q_react?.answer) report.ok.push('api_react_years');
    else report.fail.push('api_react_years');

    // Work auth is FIXED profile — either answered from profile or skipped empty.
    if (byId.q_auth?.answer) {
        report.ok.push('api_work_auth_from_profile');
    } else if (skipped.some((s) => String(s.id) === 'q_auth')) {
        report.ok.push('api_work_auth_skipped_fixed');
        if (!profile.work_authorization) {
            report.details.work_auth_note = 'profile.work_authorization empty — fill will leave blank';
        }
    } else {
        report.fail.push('api_work_auth: neither answered nor skipped');
    }

    // --- Browser DOM fill (extension-equivalent) ---
    const fillScript = path.join(__dirname, 'fixtures', '_fill_course_drive.mjs');
    const fillPayload = {
        profile: {
            first_name: profile.first_name,
            last_name: profile.last_name,
            email: profile.email,
            phone: profile.phone,
            work_authorization: profile.work_authorization || '',
            salary_range: profile.salary_range || ''
        },
        answers,
        jobDescription: jd
    };

    const { writeFileSync } = await import('fs');
    writeFileSync(
        fillScript,
        `export default async function (page) {
  const payload = ${JSON.stringify(fillPayload)};
  await page.waitForSelector('#apply');
  const result = await page.evaluate((p) => {
    function setVal(sel, value) {
      const el = document.querySelector(sel);
      if (!el || value == null || value === '') return false;
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const byId = Object.fromEntries((p.answers || []).map((a) => [a.id, a.answer]));
    const filled = {
      first_name: setVal('#first_name', p.profile.first_name),
      last_name: setVal('#last_name', p.profile.last_name),
      email: setVal('#email', p.profile.email),
      phone: setVal('#phone', p.profile.phone),
      q_why: setVal('#q_why', byId.q_why || ''),
      q_sal: setVal('#q_sal', byId.q_sal || ''),
      q_auth: setVal('#q_auth', byId.q_auth || p.profile.work_authorization || ''),
      q_react: setVal('#q_react', byId.q_react || '')
    };
    const values = {
      first_name: document.querySelector('#first_name').value,
      last_name: document.querySelector('#last_name').value,
      email: document.querySelector('#email').value,
      phone: document.querySelector('#phone').value,
      q_why: document.querySelector('#q_why').value,
      q_sal: document.querySelector('#q_sal').value,
      q_auth: document.querySelector('#q_auth').value,
      q_react: document.querySelector('#q_react').value
    };
    return { filled, values };
  }, payload);
  return result;
}
`
    );

    const fixtureUrl = pathToFileURL(FIXTURE).href;
    const out = await new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [BROWSER, fixtureUrl, '--script', fillScript, '--timeout', '60000'],
            { cwd: root, env: process.env }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.on('error', reject);
    });

    let browserResult = null;
    try {
        const m = out.stdout.match(/^script\s+(\{[\s\S]*|\[[\s\S]*)/m);
        if (m) {
            // script line may be pretty-printed JSON spanning lines until next key or EOF
            const after = out.stdout.slice(out.stdout.indexOf('script'));
            const jsonStart = after.indexOf('{');
            const jsonEnd = after.lastIndexOf('}');
            if (jsonStart >= 0 && jsonEnd > jsonStart) {
                browserResult = JSON.parse(after.slice(jsonStart, jsonEnd + 1));
            }
        }
        if (browserResult?.result) browserResult = browserResult.result;
    } catch (e) {
        report.details.browser_parse_error = e.message;
        report.details.browser_stdout = out.stdout.slice(-2500);
        report.details.browser_stderr = out.stderr.slice(-1000);
    }

    if (!browserResult && out.stderr) {
        report.details.browser_stderr = out.stderr.slice(-1000);
    }
    if (!browserResult) {
        report.details.browser_stdout_tail = out.stdout.slice(-2500);
    }

    report.details.browser_exit = out.code;
    report.details.dom = browserResult;

    if (browserResult?.values?.email) report.ok.push('dom_email');
    else report.fail.push('dom_email');
    if (browserResult?.values?.q_sal) report.ok.push('dom_salary');
    else report.fail.push('dom_salary');
    if (browserResult?.values?.q_why) report.ok.push('dom_why');
    else report.fail.push('dom_why');
    if (browserResult?.values?.q_react) report.ok.push('dom_react');
    else report.fail.push('dom_react');
    if (browserResult?.values?.first_name) report.ok.push('dom_first_name');
    else report.fail.push('dom_first_name');

    // Work auth DOM: only required if profile or answers provided it
    if (profile.work_authorization || byId.q_auth?.answer) {
        if (browserResult?.values?.q_auth) report.ok.push('dom_work_auth');
        else report.fail.push('dom_work_auth');
    } else {
        report.ok.push('dom_work_auth_optional_empty');
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.fail.length ? 2 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
