/**
 * Test: profile autofill (no AI) then AI written answers — report detail.
 * Mimics: fill while CV generates → answer when CV ready.
 *
 * node server/scripts/test_simplify_parallel_course.mjs
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
    const report = { ok: [], fail: [], phases: {} };

    // --- Login + profile ---
    const { data: login } = await axios.post(`${BASE}/auth/login`, {
        username: 'bob',
        password: 'bob123'
    });
    const headers = { Authorization: `Bearer ${login.token}` };
    report.ok.push('login');

    const { data: profilesRaw } = await axios.get(`${BASE}/user/profiles`, { headers });
    const list = Array.isArray(profilesRaw) ? profilesRaw : profilesRaw.profiles || [];
    const profile = list.find((p) => p.id === 2) || list[0];
    if (!profile) throw new Error('no profile');
    report.ok.push('profiles');
    report.phases.profile = {
        id: profile.id,
        name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim(),
        email: profile.email,
        phone: profile.phone,
        country: profile.country,
        city: profile.city,
        how_heard: profile.how_heard,
        linkedin: profile.linkedin_url,
        website: profile.website_url || profile.github_url || null
    };

    // --- Phase A: profile autofill ONLY (no AI, no CV) — while "CV would be generating" ---
    const t0 = Date.now();
    const scrapeScript = path.join(__dirname, 'fixtures', '_parallel_scrape.mjs');
    writeFileSync(
        scrapeScript,
        `export default async function (page) {
  await page.waitForTimeout(2500);
  try {
    const applyBtn = page.getByRole('button', { name: /^Apply$/i }).first();
    if (await applyBtn.count()) await applyBtn.click({ timeout: 2000 }).catch(() => {});
  } catch (_) {}
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    function labelFor(el) {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return lab.innerText.trim().replace(/\\s+/g, ' ').slice(0, 300);
      }
      const wrap = el.closest('.field, .form-field, .application-field, li, div, label');
      if (wrap) {
        const t = (wrap.querySelector('label') || wrap).innerText || '';
        return t.trim().replace(/\\s+/g, ' ').slice(0, 300);
      }
      return el.name || el.id || '';
    }
    function classify(label, name) {
      const hay = (label + ' ' + name).toLowerCase();
      if (/salary|compensation|targeting|pay/.test(hay)) return 'salary';
      if (/first[\\s_-]*name/.test(hay)) return 'first_name';
      if (/last[\\s_-]*name/.test(hay)) return 'last_name';
      if (/e-?mail/.test(hay)) return 'email';
      if (/\\bphone|mobile|tel\\b/.test(hay) && !/country/.test(hay)) return 'phone';
      if (/location \\(city\\)|where are you located|\\bcity\\b/.test(hay)) return 'city';
      if (/\\bcountry\\b/.test(hay) && !/phone/.test(hay)) return 'country';
      if (/linkedin/.test(hay)) return 'linkedin';
      if (/website|portfolio|github/.test(hay) && !/linkedin/.test(hay)) return 'website_url';
      if (/how did you (first )?hear|hear about/.test(hay)) return 'how_heard';
      if (/gender|sex/.test(hay) && !/sexual/.test(hay)) return 'gender';
      if (/hispanic|latino/.test(hay)) return 'hispanic_latino';
      if (/veteran/.test(hay)) return 'veteran_status';
      if (/disabilit/.test(hay)) return 'disability_status';
      if (/resume|cv|cover letter/.test(hay)) return 'resume';
      return 'question';
    }
    const jd = (document.querySelector('#content, .job__description, main, body')?.innerText || '').slice(0, 9000);
    const title = document.querySelector('h1')?.innerText?.trim() || document.title;
    const fields = [];
    const questions = [];
    for (const el of [...document.querySelectorAll('input, textarea, select')]) {
      const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'file'].includes(type)) continue;
      if (/iti-|search-input/.test(el.id + (el.name || '') + (el.className || ''))) continue;
      const label = labelFor(el);
      if (!label || label === 'Select...') continue;
      const kind = classify(label, el.name || '');
      const id = el.id || el.name || label.slice(0, 80);
      const field = { id, label, kind, type: el.tagName.toLowerCase() === 'select' ? 'select' : type };
      fields.push(field);
      if (kind === 'question' || kind === 'salary') {
        questions.push({ id, label, type: field.type, kind, answer_type: kind === 'salary' ? 'salary' : 'written' });
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
    if (!scraped?.fields?.length) {
        report.fail.push('scrape');
        report.phases.scrape_stdout = scrapeOut.stdout.slice(-1500);
        console.log(JSON.stringify(report, null, 2));
        process.exit(2);
    }
    report.ok.push('scrape');
    report.phases.scrape = {
        title: scraped.title,
        fields: scraped.fields.length,
        questions: scraped.questions.length,
        question_labels: scraped.questions.map((q) => q.label.slice(0, 90))
    };

    // Profile fill (no AI)
    const fillScript = path.join(__dirname, 'fixtures', '_parallel_profile_fill.mjs');
    const profilePayload = {
        first_name: profile.first_name,
        last_name: profile.last_name,
        email: profile.email,
        phone: profile.phone,
        city: profile.city,
        country: profile.country || 'United States',
        linkedin_url: profile.linkedin_url,
        website_url: profile.website_url || profile.github_url || profile.portfolio_url || '',
        how_heard: profile.how_heard || 'LinkedIn',
        gender: profile.gender || '',
        hispanic_latino: profile.hispanic_latino || '',
        veteran_status: profile.veteran_status || '',
        disability_status: profile.disability_status || ''
    };
    writeFileSync(
        fillScript,
        `export default async function (page) {
  const p = ${JSON.stringify(profilePayload)};
  await page.waitForTimeout(2000);
  try {
    const applyBtn = page.getByRole('button', { name: /^Apply$/i }).first();
    if (await applyBtn.count()) await applyBtn.click({ timeout: 2000 }).catch(() => {});
  } catch (_) {}
  await page.waitForTimeout(600);

  const result = await page.evaluate((profile) => {
    function labelFor(el) {
      if (el.id) {
        const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lab) return lab.innerText.trim().replace(/\\s+/g, ' ').slice(0, 300);
      }
      const wrap = el.closest('.field, .form-field, .application-field, li, div, label');
      if (wrap) {
        const t = (wrap.querySelector('label') || wrap).innerText || '';
        return t.trim().replace(/\\s+/g, ' ').slice(0, 300);
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
    function classify(label, name) {
      const hay = (label + ' ' + name).toLowerCase();
      if (/first[\\s_-]*name/.test(hay)) return 'first_name';
      if (/last[\\s_-]*name/.test(hay)) return 'last_name';
      if (/e-?mail/.test(hay)) return 'email';
      if (/\\bphone|mobile|tel\\b/.test(hay) && !/country/.test(hay)) return 'phone';
      if (/location \\(city\\)|where are you located|\\bcity\\b/.test(hay)) return 'city';
      if (/\\bcountry\\b/.test(hay) && !/phone/.test(hay)) return 'country';
      if (/linkedin/.test(hay)) return 'linkedin';
      if (/website|portfolio|github/.test(hay) && !/linkedin/.test(hay)) return 'website_url';
      if (/how did you (first )?hear|hear about/.test(hay)) return 'how_heard';
      if (/gender|sex/.test(hay) && !/sexual/.test(hay)) return 'gender';
      return null;
    }
    function personal(kind) {
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
        gender: profile.gender
      };
      return map[kind] || '';
    }
    function matchSelect(el, value) {
      const v = String(value || '').toLowerCase();
      const opts = [...el.options];
      return opts.find((o) => o.text.trim().toLowerCase() === v || o.text.toLowerCase().includes(v));
    }

    let filled = 0;
    const filledLabels = [];
    for (const el of [...document.querySelectorAll('input, textarea, select')]) {
      const type = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'file', 'checkbox', 'radio'].includes(type)) continue;
      if (/iti-|search-input/.test(el.id + (el.name || ''))) continue;
      const label = labelFor(el);
      const kind = classify(label, el.name || '');
      if (!kind) continue;
      const value = personal(kind);
      if (!value) continue;
      if (el.tagName === 'SELECT') {
        const hit = matchSelect(el, value);
        if (!hit) continue;
        setNative(el, hit.value);
      } else {
        setNative(el, value);
      }
      filled += 1;
      filledLabels.push({ label: label.slice(0, 60), kind, value: String(value).slice(0, 80) });
    }

    // try city autocomplete US
    const cityEl = [...document.querySelectorAll('input')].find((el) => /city|location/i.test(labelFor(el)));
    if (cityEl && profile.city) {
      setTimeout(() => {
        const opts = [...document.querySelectorAll('[role="option"], li')];
        const us = opts.find((o) => {
          const t = (o.textContent || '').toLowerCase();
          return t.includes(profile.city.toLowerCase()) && t.includes('united states');
        });
        if (us) us.click();
      }, 400);
    }

    return { filled, filledLabels, ai_used: false };
  }, p);

  await page.waitForTimeout(800);
  return result;
}
`
    );

    const fillOut = await runBrowser(JOB_URL, fillScript);
    const profileFill = parseScriptResult(fillOut.stdout);
    try { unlinkSync(fillScript); } catch (_) {}
    const profileMs = Date.now() - t0;
    report.phases.profile_autofill = {
        ms: profileMs,
        result: profileFill,
        note: 'No AI, no CV required — simulates fill during CV generate'
    };
    if (profileFill?.filled > 0) report.ok.push(`profile_autofill_${profileFill.filled}`);
    else report.fail.push('profile_autofill');

    // --- Phase B: AI answers (as if CV just became ready) ---
    const written = (scraped.questions || []).filter((q) => q.kind === 'question');
    const t1 = Date.now();
    let answersPayload;
    try {
        const { data } = await axios.post(
            `${BASE}/user/generate-answers`,
            {
                profile_id: profile.id,
                job_description: scraped.job_description,
                resume_html:
                    `<p>${profile.first_name} ${profile.last_name}</p>` +
                    '<p>Python microservices, APIs, Postgres, Linux, Docker/CI. Ops tooling for on-call engineers.</p>',
                company_name: 'Planet',
                job_role: scraped.title || 'Software Engineer, Missions Software',
                questions: written.slice(0, 10)
            },
            { headers, timeout: 180000 }
        );
        answersPayload = data;
        report.ok.push('ai_answers');
    } catch (e) {
        report.fail.push(`ai_answers: ${e.response?.data?.error || e.message}`);
        answersPayload = { answers: [], error: e.response?.data || e.message };
    }

    report.phases.ai_answers = {
        ms: Date.now() - t1,
        provider: answersPayload.provider,
        model: answersPayload.model,
        count: (answersPayload.answers || []).length,
        qa: (answersPayload.answers || []).map((a) => ({
            question: (a.label || a.id || '').slice(0, 100),
            answer: a.answer,
            source: a.source || a.answer_type || null,
            words: String(a.answer || '').trim().split(/\s+/).filter(Boolean).length
        })),
        skipped: answersPayload.skipped || []
    };

    const why = (answersPayload.answers || []).find((a) => /why planet/i.test(a.label || ''));
    if (why?.answer) report.ok.push('why_planet');
    else report.fail.push('why_planet');

    report.summary = {
        profile_fill_without_ai: (profileFill?.filled || 0) > 0,
        profile_fields_filled: profileFill?.filled || 0,
        ai_provider: answersPayload.provider,
        ai_answers_count: (answersPayload.answers || []).length,
        parallel_story:
            'Phase A (profile) does not wait for CV/AI. Phase B (written Qs) uses MiniMax after CV-ready HTML.'
    };

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.fail.length ? 2 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
