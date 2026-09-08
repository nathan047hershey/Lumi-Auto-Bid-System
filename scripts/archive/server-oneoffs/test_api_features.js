'use strict';

const axios = require('axios');

const BASE = 'http://localhost:9017';
const results = [];

function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
    let token = null;

    try {
        const health = await axios.get(`${BASE}/health`);
        record('GET /health', health.status === 200, `status=${health.data?.status}`);
    } catch (e) {
        record('GET /health', false, e.message);
        printSummary();
        process.exit(1);
    }

    try {
        const login = await axios.post(`${BASE}/auth/login`, { username: 'admin', password: 'admin123' });
        token = login.data?.token;
        record('POST /auth/login', !!token);
    } catch (e) {
        record('POST /auth/login', false, e.response?.data?.error || e.message);
        printSummary();
        process.exit(1);
    }

    const api = axios.create({
        baseURL: BASE,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true
    });

    const tests = [
        ['GET /auth/me', () => api.get('/auth/me')],
        ['GET /admin/users', () => api.get('/admin/users')],
        ['GET /admin/profiles', () => api.get('/admin/profiles')],
        ['GET /admin/stats', () => api.get('/admin/stats?period=24h')],
        ['GET /admin/applications', () => api.get('/admin/applications')],
        ['GET /admin/interview-requests', () => api.get('/admin/interview-requests')],
        ['GET /admin/interview-requests/summary', () => api.get('/admin/interview-requests/summary')],
        ['GET /admin/resume-templates', () => api.get('/admin/resume-templates')],
        ['GET /admin/settings', () => api.get('/admin/settings')],
        ['GET /admin/auto-apply/status', () => api.get('/admin/auto-apply/status')],
        ['GET /job-links', () => api.get('/job-links?limit=5')],
        ['GET /job-links/cron-status', () => api.get('/job-links/cron-status')],
        ['GET /user/profiles', () => api.get('/user/profiles')],
        ['GET /user/stats', () => api.get('/user/stats?period=24h')],
    ];

    for (const [name, fn] of tests) {
        try {
            const res = await fn();
            const ok = res.status >= 200 && res.status < 300;
            record(name, ok, `HTTP ${res.status}`);
        } catch (e) {
            record(name, false, e.message);
        }
    }

    // Template routes (if any template exists)
    try {
        const tplRes = await api.get('/admin/resume-templates');
        const templates = tplRes.data?.templates || [];
        if (templates.length > 0) {
            const tpl = templates.find((t) => !t.is_default) || templates[0];
            const preview = await api.post(`/admin/resume-templates/${tpl.id}/preview-html`);
            record('POST /admin/resume-templates/:id/preview-html', preview.status === 200 && typeof preview.data === 'string', `HTTP ${preview.status}`);
            const reExtract = await api.post(`/admin/resume-templates/${tpl.id}/re-extract`);
            record('POST /admin/resume-templates/:id/re-extract', reExtract.status === 200 || reExtract.status === 400, `HTTP ${reExtract.status}`);
        } else {
            record('POST /admin/resume-templates/:id/preview-html', true, 'skipped — no templates');
        }
    } catch (e) {
        record('POST /admin/resume-templates/:id/preview-html', false, e.message);
    }

    printSummary();
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
}

function printSummary() {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log('\n========================================');
    console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`);
    console.log('========================================');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
