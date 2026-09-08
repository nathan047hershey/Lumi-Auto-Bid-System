/**
 * Detailed Planet Greenhouse Q&A report (no submit).
 * node server/scripts/report_planet_answers.mjs
 */
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
require('dotenv').config({ path: path.join(root, 'server', '.env') });
require('dotenv').config({ path: path.join(root, 'server', 'local.env'), override: true });
const axios = require('axios');

const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';
const JOB_URL =
    'https://job-boards.greenhouse.io/embed/job_app?for=planetlabs&jr_id=6a468be33dbab558e29a7845&token=8008355&utm_source=jobright';
const BROWSER = path.join(
    process.env.USERPROFILE || process.env.HOME,
    '.claude',
    'skills',
    'browser-automation',
    'browser.mjs'
);

function runBrowser(url, scriptPath, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [BROWSER, url, '--script', scriptPath, '--timeout', String(timeoutMs), '--wait', 'form,input,textarea'],
            { cwd: root, env: process.env }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.on('error', reject);
    });
}

function parseScriptResult(stdout) {
    const idx = stdout.indexOf('script');
    if (idx < 0) return null;
    const after = stdout.slice(idx);
    const jsonStart = after.indexOf('{');
    const jsonEnd = after.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
    try {
        return JSON.parse(after.slice(jsonStart, jsonEnd + 1));
    } catch {
        return null;
    }
}

async function main() {
    const { data: login } = await axios.post(`${BASE}/auth/login`, {
        username: 'bob',
        password: 'bob123'
    });
    const headers = { Authorization: `Bearer ${login.token}` };
    const { data: profilesRaw } = await axios.get(`${BASE}/user/profiles`, { headers });
    const list = Array.isArray(profilesRaw) ? profilesRaw : profilesRaw.profiles || [];
    const profile = list[0];

    const scrapeScript = path.join(__dirname, 'fixtures', '_planet_scrape_detail.mjs');
    writeFileSync(
        scrapeScript,
        `export default async function (page) {
  await page.waitForTimeout(2500);
  try {
    const applyBtn = page.getByRole('button', { name: /^Apply$/i }).first();
    if (await applyBtn.count()) await applyBtn.click({ timeout: 2000 }).catch(() => {});
  } catch (_) {}
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const SALARY_RE = /salary|compensation|pay|targeting|expected\\s*comp/i;
    function labelFor(el) {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return lab.innerText.trim().replace(/\\s+/g, ' ').slice(0, 500);
      }
      const wrap = el.closest('.field, .form-field, .application-field, li, div, label');
      if (wrap) {
        const t = (wrap.querySelector('label') || wrap).innerText || '';
        return t.trim().replace(/\\s+/g, ' ').slice(0, 500);
      }
      return el.getAttribute('aria-label') || el.name || el.id || el.placeholder || '';
    }
    function classify(label, name, tag) {
      const hay = (label + ' ' + name).toLowerCase();
      if (SALARY_RE.test(hay)) return 'salary';
      if (/first[\\s_-]*name|given[\\s_-]*name/.test(hay)) return 'first_name';
      if (/last[\\s_-]*name|surname|family[\\s_-]*name/.test(hay)) return 'last_name';
      if (/e-?mail/.test(hay)) return 'email';
      if (/\\bphone|mobile|tel\\b/.test(hay) && !/country/.test(hay)) return 'phone';
      if (/location \\(city\\)|\\bcity\\b/.test(hay)) return 'city';
      if (/\\bcountry\\b/.test(hay) && !/phone/.test(hay)) return 'country';
      if (/linkedin/.test(hay)) return 'linkedin';
      if (/website|portfolio|homepage/.test(hay) && !/linkedin/.test(hay)) return 'website_url';
      if (/how did you (first )?hear|hear about planet/.test(hay)) return 'how_heard';
      if (/gender|sex/.test(hay) && !/sexual/.test(hay)) return 'gender';
      if (/hispanic|latino/.test(hay)) return 'hispanic_latino';
      if (/race|ethnicity|ethnic/.test(hay)) return 'race_ethnicity';
      if (/veteran/.test(hay)) return 'veteran_status';
      if (/disabilit/.test(hay)) return 'disability_status';
      if (/resume|cv|cover letter/.test(hay)) return 'resume';
      if (/iti-.*search|search-input/.test(name + ' ' + (el => el.id)({id:name}))) return 'skip';
      return 'question';
    }
    const jd = (document.querySelector('#content, .job__description, main, body')?.innerText || '').slice(0, 10000);
    const title = document.querySelector('h1')?.innerText?.trim() || document.title;
    const fields = [];
    const questions = [];
    for (const el of [...document.querySelectorAll('input, textarea, select')]) {
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'file'].includes(type)) continue;
      const label = labelFor(el);
      const name = el.name || '';
      if (/iti-|search-input|__country/.test(el.id + name + (el.className || ''))) continue;
      if (!label || label === 'Select...' || /^iti-/.test(label)) continue;
      const kind = classify(label, name);
      if (kind === 'skip') continue;
      const id = el.id || el.name || label.slice(0, 80);
      const field = {
        id,
        label,
        kind,
        type: el.tagName.toLowerCase() === 'select' ? 'select' : (type === 'textarea' ? 'textarea' : type),
        required: !!(el.required || /\\*$/.test(label) || label.includes('*')),
        options: el.tagName === 'SELECT'
          ? [...el.options].map((o) => o.text.trim()).filter((t) => t && t !== 'Select...')
          : undefined
      };
      fields.push(field);
      if (kind === 'question' || kind === 'salary') {
        questions.push({
          id: field.id,
          label: field.label,
          type: field.type,
          kind,
          answer_type: kind === 'salary' ? 'salary' : 'written',
          options: field.options
        });
      }
    }
    return { title, job_description: jd, fields, questions };
  });
}
`
    );

    const scrapeOut = await runBrowser(JOB_URL, scrapeScript);
    const scraped = parseScriptResult(scrapeOut.stdout);
    try { unlinkSync(scrapeScript); } catch (_) {}
    if (!scraped) {
        console.error('SCRAPE_FAILED');
        console.error(scrapeOut.stdout.slice(-2000));
        process.exit(1);
    }

    const { data: answersPayload } = await axios.post(
        `${BASE}/user/generate-answers`,
        {
            profile_id: profile.id,
            job_description: scraped.job_description,
            resume_html:
                `<p>${profile.first_name || ''} ${profile.last_name || ''}</p>` +
                '<p>Software engineer with Python, APIs, Postgres, Linux, Docker/CI experience. 5+ years.</p>',
            company_name: 'Planet',
            job_role: scraped.title || 'Software Engineer, Missions Software',
            questions: scraped.questions
        },
        { headers, timeout: 180000 }
    );

    const answers = answersPayload.answers || [];
    const skipped = answersPayload.skipped || [];
    const byId = Object.fromEntries(answers.map((a) => [String(a.id), a]));
    const byLabel = Object.fromEntries(
        answers.filter((a) => a.label).map((a) => [String(a.label).trim().toLowerCase(), a])
    );

    function answerFor(field) {
        return (
            byId[String(field.id)]
            || byLabel[String(field.label).trim().toLowerCase()]
            || null
        );
    }

    function profileValue(kind) {
        const map = {
            first_name: profile.first_name,
            last_name: profile.last_name,
            email: profile.email,
            phone: profile.phone,
            city: profile.city,
            country: profile.country,
            linkedin: profile.linkedin_url,
            website_url: profile.website_url || profile.portfolio_url,
            how_heard: profile.how_heard,
            gender: profile.gender,
            hispanic_latino: profile.hispanic_latino,
            race_ethnicity: profile.race_ethnicity,
            veteran_status: profile.veteran_status,
            disability_status: profile.disability_status,
            work_authorization: profile.work_authorization,
            salary_range: profile.salary_range
        };
        return map[kind] || '';
    }

    const rows = [];
    for (const field of scraped.fields) {
        if (field.kind === 'resume') {
            rows.push({
                section: 'file',
                question: field.label,
                kind: field.kind,
                type: field.type,
                required: field.required,
                answer: '(resume upload — extension handles file separately)',
                source: 'file'
            });
            continue;
        }
        if (field.kind === 'question' || field.kind === 'salary') {
            const a = answerFor(field);
            const skip = skipped.find((s) => String(s.id) === String(field.id));
            rows.push({
                section: field.kind === 'salary' ? 'salary' : 'written',
                question: field.label,
                kind: field.kind,
                type: field.type,
                required: field.required,
                options: field.options?.slice(0, 12),
                answer: a?.answer || null,
                source: a ? (a.source || a.answer_type || 'api') : (skip?.reason || 'empty'),
                skip_reason: skip?.reason || null
            });
            continue;
        }
        const pv = profileValue(field.kind);
        rows.push({
            section: 'profile',
            question: field.label,
            kind: field.kind,
            type: field.type,
            required: field.required,
            options: field.options?.slice(0, 12),
            answer: pv || null,
            source: pv ? 'profile' : 'profile_empty'
        });
    }

    const report = {
        job: {
            title: scraped.title,
            url: JOB_URL,
            company: 'Planet'
        },
        profile: {
            id: profile.id,
            name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
            email: profile.email,
            salary_range: profile.salary_range
        },
        provider: answersPayload.provider,
        model: answersPayload.model,
        counts: {
            fields: scraped.fields.length,
            questions_to_ai: scraped.questions.length,
            answers_returned: answers.length,
            skipped: skipped.length,
            with_answer: rows.filter((r) => r.answer).length,
            empty: rows.filter((r) => !r.answer).length
        },
        questions_and_answers: rows,
        raw_skipped: skipped
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
    console.error(e.response?.data || e);
    process.exit(1);
});
