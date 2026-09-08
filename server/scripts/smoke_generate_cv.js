/**
 * Smoke-test CV generate against local API.
 * Usage: node server/scripts/smoke_generate_cv.js
 */
const axios = require('axios');

const BASE = 'http://127.0.0.1:9017';

async function main() {
  const login = await axios.post(`${BASE}/auth/login`, {
    username: 'bob',
    password: 'bob123'
  });
  const token = login.data?.token || login.data?.access_token;
  if (!token) throw new Error('No token: ' + JSON.stringify(login.data));

  const profiles = await axios.get(`${BASE}/user/profiles`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const list = Array.isArray(profiles.data) ? profiles.data : profiles.data?.profiles || [];
  if (!list.length) throw new Error('No profiles assigned to bob');
  const profile = list[0];
  console.log('Using profile', profile.id, profile.first_name, profile.last_name);

  const started = Date.now();
  try {
    const res = await axios.post(
      `${BASE}/user/generate-resume`,
      {
        profile_id: profile.id,
        job_description:
          'Acme Corp is hiring a Senior Software Engineer. Requirements: React, Node.js, TypeScript, PostgreSQL. Remote US. Compensation $140k-$180k.',
        company_name: 'Acme Corp',
        job_role: 'Senior Software Engineer',
        core_skills: 'React, Node.js, TypeScript',
        font_family: '__random__'
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 420000
      }
    );
    const ms = Date.now() - started;
    console.log('OK in', ms, 'ms');
    console.log({
      application_id: res.data.application_id,
      generation_status: res.data.generation_status,
      provider_used: res.data.provider_used,
      validation_pass: res.data.validation?.pass,
      validation_issues: res.data.validation?.issues || [],
      validation_attempts: res.data.validation_attempts,
      is_finalized: res.data.is_finalized,
      resume_filename: res.data.resume_filename,
      html_len: (res.data.resume_html || res.data.resume_content || '').length
    });
  } catch (err) {
    const ms = Date.now() - started;
    console.error('FAIL after', ms, 'ms');
    console.error(err.response?.status, err.response?.data || err.message);
    process.exit(1);
  }
}

main();
