/**
 * End-to-end engineer CV generate test + hard pass criteria.
 * Usage: node server/scripts/test_generate_engineer_cv.js
 */
const axios = require('axios');

const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';

const JD = `
Senior Linux Infrastructure Engineer — Voleon Group (AI/ML trading firm).

Required:
- Strong Python for operational tooling and automation
- Linux systems administration at scale
- TCP/IP networking fundamentals
- Configuration management: Ansible, Puppet, or Chef
- Metrics and monitoring: Prometheus, InfluxDB, Grafana
- CI/CD: Jenkins and/or GitHub Actions
- Containers and orchestration (Docker, Kubernetes preferred)
- Distributed storage familiarity (Ceph, Lustre, or GPFS a plus)
- RDBMS: Postgres or MySQL

Responsibilities:
- Own Linux fleet reliability, on-call, and automation
- Build Python tooling for deploy, config, and observability
- Partner with trading/platform engineers on infrastructure for research workloads
`.trim();

const CORE = 'Python, Linux, Ansible, Prometheus, Grafana, Jenkins, GitHub Actions, Docker, Kubernetes, Postgres';

function looksLikeCot(html) {
  const s = String(html || '');
  return /which one to follow|system instructions are higher|Not a chatbot brochure|PRECOMPUTED|MUST PASS/i.test(s)
    || (/Tags:\s*h2,\s*p,\s*strong/i.test(s) && !/<ul\b/i.test(s));
}

function validateHtml(html) {
  const issues = [];
  const s = String(html || '');
  if (!s || s.length < 800) issues.push(`html too short (${s.length})`);
  if (looksLikeCot(s)) issues.push('looks like CoT/reasoning dump');
  if (!/<h1\b/i.test(s)) issues.push('missing <h1>');
  for (const sec of ['Summary', 'Core Skills', 'Work Experience', 'Education']) {
    if (!new RegExp(`<h2[^>]*>\\s*${sec}`, 'i').test(s)) issues.push(`missing h2 ${sec}`);
  }
  const lis = (s.match(/<li\b/gi) || []).length;
  if (lis < 8) issues.push(`too few bullets (${lis})`);
  const skillSection = (s.match(/<h2[^>]*>\s*Core Skills[\s\S]*?(?=<h2|$)/i) || [''])[0];
  const skillLines = (skillSection.match(/<(?:p|li)\b/gi) || []).length;
  if (skillLines < 3 || skillLines > 8) issues.push(`skill lines=${skillLines} (want 4-5)`);
  // Real contact lines include the phone; junk fallback used phone as employer
  // and duplicated "Python and Python" bullets.
  if (/Owned reliability work for\s*\(?\s*315\)?/i.test(s)
    || /Python and Python/i.test(s)
    || (s.match(/01\/2020\s*-\s*Present/gi) || []).length >= 4) {
    issues.push('looks like broken template/fallback CV');
  }
  return { pass: issues.length === 0, issues, chars: s.length, lis, skillLines };
}

async function login() {
  for (const cred of [
    { username: 'bob', password: 'bob123' },
    { username: 'admin', password: 'admin123' }
  ]) {
    try {
      const { data } = await axios.post(`${BASE}/auth/login`, cred, { timeout: 15000 });
      const token = data.token || data.access_token;
      if (token) return { token, user: cred.username };
    } catch (_) { /* try next */ }
  }
  throw new Error('login failed');
}

async function main() {
  const { token, user } = await login();
  const headers = { Authorization: `Bearer ${token}` };
  console.log('logged in as', user);

  const { data: profilesRaw } = await axios.get(`${BASE}/user/profiles`, { headers });
  const list = Array.isArray(profilesRaw) ? profilesRaw : profilesRaw.profiles || [];
  if (!list.length) throw new Error('no profiles');

  let profile = list.find((p) => /barbalas|jonathan/i.test(`${p.first_name} ${p.last_name}`))
    || list.find((p) => /engineer|software/i.test(p.resume_prompt || ''))
    || list[0];
  console.log('profile', profile.id, profile.first_name, profile.last_name);

  let lastErr = null;
  for (let attempt = 1; attempt <= 1; attempt++) {
    const started = Date.now();
    let res;
    try {
      res = await axios.post(
        `${BASE}/user/generate-resume`,
        {
          profile_id: profile.id,
          job_description: JD,
          company_name: 'Voleon',
          job_role: 'Senior Linux Infrastructure Engineer',
          core_skills: CORE,
          font_family: 'Calibri'
        },
        { headers, timeout: 420000 }
      );
    } catch (err) {
      lastErr = err;
      console.error(`HTTP FAIL attempt ${attempt}/2 after`, Date.now() - started, 'ms');
      console.error(err.response?.status, err.response?.data || err.message);
      continue;
    }

    const ms = Date.now() - started;
    const html = res.data.resume_html || res.data.resume_content || '';
    const v = validateHtml(html);
    const report = {
      attempt,
      ms,
      application_id: res.data.application_id,
      provider_used: res.data.provider_used,
      fallback_used: res.data.fallback_used,
      generation_status: res.data.generation_status,
      llm_ms: res.data.llm_ms,
      polish_ms: res.data.polish_ms,
      validation_api: {
        pass: res.data.validation?.pass,
        issues: res.data.validation?.issues || []
      },
      quality: res.data.quality_report
        ? {
            pass: res.data.quality_report.pass,
            grade: res.data.quality_report.grade,
            score: res.data.quality_report.score,
            critical: res.data.quality_report.critical_count
          }
        : null,
      html_check: v,
      preview: html.slice(0, 280).replace(/\s+/g, ' ')
    };
    console.log(JSON.stringify(report, null, 2));

    const apiOk = !!res.data.validation?.pass;
    const qualityOk = !res.data.quality_report || res.data.quality_report.pass === true
      || (res.data.quality_report.critical_count || 0) === 0;
    if (v.pass && !looksLikeCot(html) && apiOk && qualityOk) {
      console.log('TEST PASS');
      return;
    }
    console.error(`attempt ${attempt} not passing yet — retrying`);
  }
  if (lastErr) {
    console.error('FINAL HTTP FAIL', lastErr.response?.data || lastErr.message);
  }
  console.error('TEST FAIL');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
