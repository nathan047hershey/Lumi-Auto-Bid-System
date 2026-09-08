/**
 * Live Greenhouse autofill course against Planet apply form.
 * Does NOT submit the application.
 *
 * node server/scripts/test_planet_greenhouse_course.mjs
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
    process.env.JOB_URL
    || 'https://job-boards.greenhouse.io/embed/job_app?for=planetlabs&jr_id=6a468be33dbab558e29a7845&token=8008355&utm_source=jobright';
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
    const report = { ok: [], fail: [], details: { job_url: JOB_URL } };

    // 1) Login + profile
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
    report.details.profile = {
        id: profile.id,
        name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
        email: profile.email,
        salary_range: profile.salary_range || null,
        work_authorization: profile.work_authorization || null
    };

    // 2) Scrape JD + form fields from Greenhouse
    const scrapeScript = path.join(__dirname, 'fixtures', '_planet_scrape.mjs');
    writeFileSync(
        scrapeScript,
        `export default async function (page) {
  await page.waitForTimeout(2500);
  // Expand apply section if needed
  try {
    const applyBtn = page.getByRole('button', { name: /^Apply$/i }).first();
    if (await applyBtn.count()) await applyBtn.click({ timeout: 2000 }).catch(() => {});
  } catch (_) {}
  await page.waitForTimeout(1000);

  return page.evaluate(() => {
    const SALARY_RE = /salary|compensation|pay|ctc|base\\s*pay|expected\\s*comp|wage|targeting/i;
    function labelFor(el) {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return lab.innerText.trim().replace(/\\s+/g, ' ').slice(0, 400);
      }
      const wrap = el.closest('label, .field, .form-field, .application-field, li, div');
      if (wrap) {
        const t = (wrap.querySelector('label') || wrap).innerText || '';
        return t.trim().replace(/\\s+/g, ' ').slice(0, 400);
      }
      return el.name || el.id || el.placeholder || '';
    }
    function classify(label, name) {
      const hay = (label + ' ' + name).toLowerCase();
      if (SALARY_RE.test(hay)) return 'salary';
      if (/first[\\s_-]*name|given[\\s_-]*name/.test(hay)) return 'first_name';
      if (/last[\\s_-]*name|surname|family[\\s_-]*name/.test(hay)) return 'last_name';
      if (/e-?mail/.test(hay)) return 'email';
      if (/\\bphone|mobile|tel\\b/.test(hay)) return 'phone';
      if (/\\bcity|location/.test(hay)) return 'city';
      if (/\\bcountry\\b/.test(hay)) return 'country';
      if (/linkedin/.test(hay)) return 'linkedin';
      if (/website|portfolio|homepage/.test(hay) && !/linkedin/.test(hay)) return 'website_url';
      if (/how did you (first )?hear|hear about/.test(hay)) return 'how_heard';
      if (/gender|sex/.test(hay) && !/sexual/.test(hay)) return 'gender';
      if (/hispanic|latino/.test(hay)) return 'hispanic_latino';
      if (/race|ethnicity|ethnic/.test(hay)) return 'race_ethnicity';
      if (/veteran/.test(hay)) return 'veteran_status';
      if (/disabilit/.test(hay)) return 'disability_status';
      if (/resume|cv|cover letter/.test(hay)) return 'resume';
      return 'question';
    }

    const jdEl = document.querySelector('#content, .job__description, .job-post, main, body');
    const job_description = (jdEl?.innerText || '').slice(0, 12000);
    const title = document.querySelector('h1')?.innerText?.trim() || document.title;

    const fields = [];
    const questions = [];
    for (const el of [...document.querySelectorAll('input, textarea, select')]) {
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'file'].includes(type)) continue;
      if (!el.offsetParent && getComputedStyle(el).visibility === 'hidden') continue;
      const label = labelFor(el);
      const kind = classify(label, el.name || '');
      const id = el.id || el.name || label.slice(0, 80);
      const field = {
        id,
        label: label || id,
        kind,
        type: type === 'textarea' ? 'textarea' : (el.tagName.toLowerCase() === 'select' ? 'select' : type),
        name: el.name || '',
        tag: el.tagName.toLowerCase(),
        options: el.tagName === 'SELECT'
          ? [...el.options].slice(0, 40).map((o) => o.text.trim()).filter(Boolean)
          : undefined
      };
      fields.push(field);
      if (kind === 'question' || kind === 'salary') {
        questions.push({
          id,
          label: field.label,
          type: field.type,
          kind,
          answer_type: kind === 'salary' ? 'salary' : 'written',
          options: field.options
        });
      }
    }
    return {
      title,
      job_description_len: job_description.length,
      job_description: job_description.slice(0, 8000),
      field_count: fields.length,
      question_count: questions.length,
      fields,
      questions
    };
  });
}
`
    );

    const scrapeOut = await runBrowser(JOB_URL, scrapeScript, 90000);
    const scraped = parseScriptResult(scrapeOut.stdout);
    try { unlinkSync(scrapeScript); } catch (_) {}

    if (!scraped?.questions?.length) {
        report.fail.push('scrape_form');
        report.details.scrape_stdout = scrapeOut.stdout.slice(-2000);
        report.details.scrape_stderr = scrapeOut.stderr.slice(-1000);
        console.log(JSON.stringify(report, null, 2));
        process.exit(2);
    }
    report.ok.push('scrape_form');
    report.details.job_title = scraped.title;
    report.details.field_count = scraped.field_count;
    report.details.question_count = scraped.question_count;
    report.details.question_labels = scraped.questions.map((q) => q.label.slice(0, 120));

    // Prefer open written + salary for AI; keep a capped set for speed
    const priority = scraped.questions.filter((q) =>
        /why planet|salary|hear about|find this position|previously worked|immigration|export|reside|base salary/i.test(q.label)
    );
    const questionsForApi = (priority.length ? priority : scraped.questions).slice(0, 12);

    // 3) generate-answers
    let answersPayload;
    try {
        const { data } = await axios.post(
            `${BASE}/user/generate-answers`,
            {
                profile_id: profile.id,
                job_description: scraped.job_description,
                resume_html:
                    `<p>${profile.first_name || ''} ${profile.last_name || ''}</p>` +
                    '<p>Software engineer with Python, APIs, Postgres, Linux, Docker/CI experience.</p>',
                company_name: 'Planet',
                job_role: scraped.title || 'Software Engineer, Missions Software',
                questions: questionsForApi
            },
            { headers, timeout: 180000 }
        );
        answersPayload = data;
        report.ok.push('generate_answers');
    } catch (e) {
        report.fail.push(`generate_answers: ${e.response?.data?.error || e.message}`);
        report.details.generate_answers_error = e.response?.data || e.message;
        console.log(JSON.stringify(report, null, 2));
        process.exit(2);
    }

    const answers = answersPayload.answers || [];
    report.details.answers = answers.map((a) => ({
        id: a.id,
        label: (a.label || '').slice(0, 80),
        answer: String(a.answer || '').slice(0, 160),
        source: a.source || a.answer_type || null
    }));
    report.details.skipped = answersPayload.skipped || [];
    report.details.provider = answersPayload.provider;
    report.details.model = answersPayload.model;

    const hasSalary = answers.some((a) => /salary|compensation|pay|targeting/i.test(a.label || '') && a.answer);
    const hasWhy = answers.some((a) => /why planet/i.test(a.label || '') && a.answer);
    if (hasSalary) report.ok.push('answer_salary');
    else report.fail.push('answer_salary');
    if (hasWhy) report.ok.push('answer_why_planet');
    else if (answers.some((a) => a.answer_type === 'written' && a.answer)) report.ok.push('answer_written_any');
    else report.fail.push('answer_written');

    // 4) Fill Greenhouse form (no submit)
    const fillScript = path.join(__dirname, 'fixtures', '_planet_fill.mjs');
    const fillPayload = {
        profile: {
            first_name: profile.first_name || '',
            last_name: profile.last_name || '',
            email: profile.email || '',
            phone: profile.phone || '',
            city: profile.city || '',
            country: profile.country || 'United States',
            linkedin_url: profile.linkedin_url || '',
            website_url: profile.website_url || profile.portfolio_url || '',
            how_heard: profile.how_heard || '',
            gender: profile.gender || '',
            hispanic_latino: profile.hispanic_latino || '',
            race_ethnicity: profile.race_ethnicity || '',
            veteran_status: profile.veteran_status || '',
            disability_status: profile.disability_status || '',
            work_authorization: profile.work_authorization || '',
            salary_range: profile.salary_range || ''
        },
        answers,
        fields: scraped.fields
    };
    writeFileSync(
        fillScript,
        `export default async function (page) {
  const payload = ${JSON.stringify(fillPayload)};
  await page.waitForTimeout(2000);
  try {
    const applyBtn = page.getByRole('button', { name: /^Apply$/i }).first();
    if (await applyBtn.count()) await applyBtn.click({ timeout: 2000 }).catch(() => {});
  } catch (_) {}
  await page.waitForTimeout(800);

  const result = await page.evaluate((p) => {
    function labelFor(el) {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return lab.innerText.trim().replace(/\\s+/g, ' ').slice(0, 400);
      }
      const wrap = el.closest('label, .field, .form-field, .application-field, li, div');
      if (wrap) {
        const t = (wrap.querySelector('label') || wrap).innerText || '';
        return t.trim().replace(/\\s+/g, ' ').slice(0, 400);
      }
      return el.name || el.id || '';
    }
    function setNative(el, value) {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
        : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function matchSelect(el, value) {
      const v = String(value || '').toLowerCase();
      const opts = [...el.options];
      let hit = opts.find((o) => o.text.trim().toLowerCase() === v || o.value.toLowerCase() === v);
      if (!hit) hit = opts.find((o) => o.text.toLowerCase().includes(v) || v.includes(o.text.toLowerCase()));
      if (!hit && /yes|no|n\\/a|united states|usa/.test(v)) {
        hit = opts.find((o) => o.text.toLowerCase().includes(v.split(/\\s|\\//)[0]));
      }
      return hit;
    }
    function personal(kind, profile) {
      const map = {
        first_name: profile.first_name,
        last_name: profile.last_name,
        email: profile.email,
        phone: profile.phone,
        city: profile.city,
        country: profile.country,
        linkedin: profile.linkedin_url,
        website_url: profile.website_url,
        how_heard: profile.how_heard,
        gender: profile.gender,
        hispanic_latino: profile.hispanic_latino,
        race_ethnicity: profile.race_ethnicity,
        veteran_status: profile.veteran_status,
        disability_status: profile.disability_status,
        work_authorization: profile.work_authorization
      };
      return map[kind] || '';
    }
    function classify(label, name) {
      const hay = (label + ' ' + name).toLowerCase();
      if (/salary|compensation|pay|targeting/.test(hay)) return 'salary';
      if (/first[\\s_-]*name|given[\\s_-]*name/.test(hay)) return 'first_name';
      if (/last[\\s_-]*name|surname|family[\\s_-]*name/.test(hay)) return 'last_name';
      if (/e-?mail/.test(hay)) return 'email';
      if (/\\bphone|mobile|tel\\b/.test(hay)) return 'phone';
      if (/\\bcity|location \\(city\\)/.test(hay)) return 'city';
      if (/\\bcountry\\b/.test(hay)) return 'country';
      if (/linkedin/.test(hay)) return 'linkedin';
      if (/website|portfolio|homepage/.test(hay) && !/linkedin/.test(hay)) return 'website_url';
      if (/how did you (first )?hear|hear about/.test(hay)) return 'how_heard';
      if (/gender|sex/.test(hay) && !/sexual/.test(hay)) return 'gender';
      if (/hispanic|latino/.test(hay)) return 'hispanic_latino';
      if (/race|ethnicity|ethnic/.test(hay)) return 'race_ethnicity';
      if (/veteran/.test(hay)) return 'veteran_status';
      if (/disabilit/.test(hay)) return 'disability_status';
      if (/resume|cv|cover letter/.test(hay)) return 'resume';
      return 'question';
    }

    const byId = new Map((p.answers || []).map((a) => [String(a.id), a.answer]));
    const byLabel = new Map(
      (p.answers || []).filter((a) => a.label).map((a) => [String(a.label).trim().toLowerCase(), a.answer])
    );

    let filled = 0;
    let skipped = 0;
    const filledLabels = [];
    const emptyLabels = [];

    for (const el of [...document.querySelectorAll('input, textarea, select')]) {
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'file'].includes(type)) continue;
      const label = labelFor(el);
      const kind = classify(label, el.name || '');
      const id = el.id || el.name || label.slice(0, 80);
      let value = '';
      if (kind === 'question' || kind === 'salary') {
        value = byId.get(String(id)) || byLabel.get(label.trim().toLowerCase()) || '';
        // fuzzy label match
        if (!value) {
          for (const [lab, ans] of byLabel) {
            if (label.toLowerCase().includes(lab.slice(0, 40)) || lab.includes(label.toLowerCase().slice(0, 40))) {
              value = ans; break;
            }
          }
        }
      } else if (kind !== 'resume') {
        value = personal(kind, p.profile);
      }
      if (!value) {
        skipped += 1;
        emptyLabels.push(label.slice(0, 80) || id);
        continue;
      }
      if (el.tagName === 'SELECT') {
        const hit = matchSelect(el, value);
        if (!hit) {
          skipped += 1;
          emptyLabels.push('(no option) ' + label.slice(0, 70));
          continue;
        }
        setNative(el, hit.value);
      } else {
        setNative(el, String(value));
      }
      filled += 1;
      filledLabels.push({ label: label.slice(0, 80), value: String(value).slice(0, 100) });
    }

    // Read back key fields
    const read = {};
    for (const sel of ['#first_name', '#last_name', '#email', '#phone', 'input[name="job_application[first_name]"]']) {
      const el = document.querySelector(sel);
      if (el) read[sel] = el.value;
    }
    // greenhouse often uses ids like first_name
    for (const el of document.querySelectorAll('input, textarea')) {
      const lab = labelFor(el).toLowerCase();
      if (/first name/.test(lab)) read.first_name = el.value;
      if (/last name/.test(lab)) read.last_name = el.value;
      if (/^email|email\\*/.test(lab) || lab.includes('email')) read.email = read.email || el.value;
      if (/why planet/.test(lab)) read.why_planet = el.value.slice(0, 200);
      if (/base salary|salary are you targeting/.test(lab)) read.salary = el.value;
    }

    return { filled, skipped, filledLabels: filledLabels.slice(0, 40), emptyLabels: emptyLabels.slice(0, 40), read };
  }, payload);

  return result;
}
`
    );

    const fillOut = await runBrowser(JOB_URL, fillScript, 90000);
    const filled = parseScriptResult(fillOut.stdout);
    try { unlinkSync(fillScript); } catch (_) {}

    report.details.fill = filled;
    report.details.fill_exit = fillOut.code;
    if (!filled) {
        report.fail.push('dom_fill_parse');
        report.details.fill_stdout = fillOut.stdout.slice(-2500);
    } else {
        if (filled.filled > 0) report.ok.push(`dom_filled_${filled.filled}`);
        else report.fail.push('dom_filled_0');
        if (filled.read?.first_name || filled.read?.email) report.ok.push('dom_contact');
        if (filled.read?.salary) report.ok.push('dom_salary');
        if (filled.read?.why_planet) report.ok.push('dom_why_planet');
    }

    report.details.note = 'Application was NOT submitted.';
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.fail.length ? 2 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
