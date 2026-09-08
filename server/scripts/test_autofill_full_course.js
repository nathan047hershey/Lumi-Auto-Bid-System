/**
 * Full Mode-1 course without extension: login → generate-resume → generate-answers.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'local.env'), override: true });
const axios = require('axios');

const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';

async function main() {
    const report = { ok: [], fail: [], details: {} };

    const { data: login } = await axios.post(`${BASE}/auth/login`, {
        username: 'bob',
        password: 'bob123'
    });
    const token = login.token;
    const headers = { Authorization: `Bearer ${token}` };
    report.ok.push('login');

    const { data: profiles } = await axios.get(`${BASE}/user/profiles`, { headers });
    const list = Array.isArray(profiles) ? profiles : profiles.profiles || [];
    const profile = list[0];
    if (!profile) throw new Error('no profile');
    report.details.profile_id = profile.id;
    report.ok.push('profiles');

    const jd =
        'Software Engineer at Acme Corp. Build React and Node.js services for SaaS. ' +
        'Compensation: $140,000 - $180,000 USD. 3+ years experience. US work authorization required.';

    try {
        const { data: resume } = await axios.post(
            `${BASE}/user/generate-resume`,
            {
                profile_id: profile.id,
                job_description: jd,
                company_name: 'Acme Corp',
                job_role: 'Software Engineer',
                core_skills: 'React, Node.js, TypeScript'
            },
            { headers, timeout: 300000 }
        );
        report.details.resume = {
            application_id: resume.application_id || resume.id,
            resume_filename: resume.resume_filename,
            has_html: !!(resume.resume_html || resume.resume_content || resume.draft_html),
            html_len: String(resume.resume_html || resume.resume_content || resume.draft_html || '').length,
            status: resume.status || resume.generation_status
        };
        if (resume.resume_filename || resume.resume_html || resume.draft_html) {
            report.ok.push('generate_resume');
        } else {
            report.fail.push('generate_resume: empty payload');
        }

        const resumeHtml = resume.resume_html || resume.resume_content || resume.draft_html || '<p>Bob Demo React Node</p>';
        const { data: answers } = await axios.post(
            `${BASE}/user/generate-answers`,
            {
                profile_id: profile.id,
                application_id: resume.application_id || resume.id,
                job_description: jd,
                resume_html: resumeHtml,
                company_name: 'Acme Corp',
                job_role: 'Software Engineer',
                questions: [
                    { id: 'first_name', label: 'First Name', type: 'text' },
                    { id: 'q_why', label: 'Why do you want this role?', type: 'textarea' },
                    { id: 'q_sal', label: 'Expected salary / compensation', type: 'text' },
                    { id: 'q_auth', label: 'Are you authorized to work in the US?', type: 'text' }
                ]
            },
            { headers, timeout: 180000 }
        );
        report.details.answers = {
            provider: answers.provider,
            model: answers.model,
            answers: (answers.answers || []).map((a) => ({
                id: a.id,
                label: a.label,
                answer: String(a.answer || '').slice(0, 120)
            }))
        };
        const got = answers.answers || [];
        if (got.find((a) => a.id === 'q_sal' && a.answer)) report.ok.push('salary_answer');
        else report.fail.push('salary_answer missing');
        if (got.find((a) => a.id === 'q_why' && a.answer)) report.ok.push('why_answer');
        else report.fail.push('why_answer missing');
        report.ok.push('generate_answers');
    } catch (e) {
        report.fail.push(`course: ${e.response?.data?.error || e.message}`);
        report.details.error = e.response?.data || e.message;
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.fail.length ? 2 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
