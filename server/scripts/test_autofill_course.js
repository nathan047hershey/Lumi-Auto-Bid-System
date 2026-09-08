/**
 * Direct autofill course test: login → profiles → generate-answers → salary.
 * Run: node server/scripts/test_autofill_course.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'local.env'), override: true });

const axios = require('axios');

const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';

async function main() {
    const report = { ok: [], fail: [], details: {} };

    // 1) Health
    try {
        const h = await axios.get(`${BASE}/health`, { timeout: 5000 });
        report.ok.push('health');
        report.details.health = h.data;
    } catch (e) {
        report.fail.push(`health: ${e.message}`);
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
    }

    // 2) Login
    let token;
    for (const cred of [
        { username: 'bob', password: 'bob123' },
        { username: 'admin', password: 'admin123' }
    ]) {
        try {
            const { data } = await axios.post(`${BASE}/auth/login`, cred, { timeout: 10000 });
            token = data.token || data.access_token;
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
        report.fail.push('login: no token');
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
    }

    const headers = { Authorization: `Bearer ${token}` };

    // 3) Profiles
    let profile;
    try {
        const { data } = await axios.get(`${BASE}/user/profiles`, { headers, timeout: 10000 });
        const list = Array.isArray(data) ? data : (data.profiles || data.data || []);
        profile = list[0];
        if (!profile) throw new Error('no profiles assigned');
        report.ok.push('profiles');
        report.details.profile_id = profile.id || profile.profile_id;
        report.details.salary_range = profile.salary_range || null;
        report.details.email = profile.email || null;
    } catch (e) {
        report.fail.push(`profiles: ${e.response?.data?.error || e.message}`);
        console.log(JSON.stringify(report, null, 2));
        process.exit(1);
    }

    const profileId = profile.id || profile.profile_id;

    // 4) Salary unit (no network)
    try {
        const { pickSalaryExpectation } = require('../services/salaryMatchService');
        const sal = pickSalaryExpectation({
            jobDescription: 'Software Engineer. Compensation: $140,000 - $180,000 USD per year.',
            profileSalaryRange: profile.salary_range || '$120,000 - $150,000',
            fieldLabel: 'Expected salary / compensation'
        });
        report.details.salary_pick = sal;
        if (sal && sal.value) report.ok.push('salary_pick');
        else report.fail.push(`salary_pick: ${JSON.stringify(sal)}`);
    } catch (e) {
        report.fail.push(`salary_pick: ${e.message}`);
    }

    // 5) Provider inferred from generate-answers response (avoid loading DB outside server)

    // 6) generate-answers
    const payload = {
        profile_id: profileId,
        job_description:
            'Software Engineer at Acme. Build React and Node services. ' +
            'Compensation: $140,000 - $180,000 USD. Must be authorized to work in the US. ' +
            '3+ years experience preferred.',
        resume_html:
            `<p>${profile.full_name || profile.name || 'Candidate'}</p>` +
            '<p>5 years React and Node.js. Built APIs and UI for SaaS products.</p>',
        company_name: 'Acme',
        job_role: 'Software Engineer',
        questions: [
            { id: 'q1', label: 'Why do you want this role?', type: 'textarea' },
            { id: 'q2', label: 'Expected salary / compensation', type: 'text' },
            { id: 'q3', label: 'Are you authorized to work in the US?', type: 'text' },
            { id: 'q4', label: 'Years of experience with React', type: 'text' }
        ]
    };

    try {
        const { data } = await axios.post(`${BASE}/user/generate-answers`, payload, {
            headers,
            timeout: 180000
        });
        report.details.answers = {
            provider: data.provider,
            model: data.model,
            count: Array.isArray(data.answers) ? data.answers.length : 0,
            answers: data.answers,
            error: data.error || null
        };
        const answers = data.answers || [];
        const skipped = data.skipped || [];
        report.details.skipped = skipped;
        const byId = Object.fromEntries(answers.map((a) => [a.id, a]));
        if (byId.q2?.answer || byId.q2?.value) report.ok.push('answer_salary');
        else report.fail.push('answer_salary: empty');
        if (byId.q1?.answer || byId.q1?.value) report.ok.push('answer_why');
        else report.fail.push('answer_why: empty');
        // Work auth is fixed-profile (not AI). Expect answer from profile OR skipped.
        if (byId.q3?.answer || byId.q3?.value) report.ok.push('answer_work_auth_profile');
        else if (skipped.some((s) => String(s.id) === 'q3')) report.ok.push('answer_work_auth_skipped');
        else report.fail.push('answer_work_auth: neither answered nor skipped');
        if (byId.q4?.answer || byId.q4?.value) report.ok.push('answer_react_years');
        else report.fail.push('answer_react_years: empty');
        report.ok.push('generate_answers_http');
    } catch (e) {
        report.fail.push(`generate_answers: ${e.response?.data?.error || e.message}`);
        report.details.generate_answers_error = e.response?.data || e.message;
    }

    // 7) Latest bidder app (for fill resume path)
    try {
        const { data } = await axios.get(`${BASE}/user/bidder/latest`, {
            headers,
            params: { profile_id: profileId },
            timeout: 15000
        });
        report.details.latest = {
            id: data.id || data.application_id,
            status: data.status || data.generation_status,
            resume: data.resume_filename || null
        };
        report.ok.push('bidder_latest');
    } catch (e) {
        report.details.bidder_latest = e.response?.data || e.message;
        // Not fatal — may have no apps yet
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.fail.length ? 2 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
