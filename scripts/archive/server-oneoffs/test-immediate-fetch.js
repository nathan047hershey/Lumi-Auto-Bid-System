require('dotenv').config();
const http = require('http');
const { initDatabase, getOne } = require('./config/database');

function api(method, path, body, token) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: '127.0.0.1', port: 8001, method, path,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: 'Bearer ' + token } : {}),
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        };
        const req = http.request(opts, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
                catch { resolve({ status: res.statusCode, body: buf }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    await initDatabase();

    const admin = getOne(
        "SELECT id, username, role FROM users WHERE role = 'admin' ORDER BY id LIMIT 1"
    );
    if (!admin) {
        console.log('No admin user found in DB. Seed it first.');
        return;
    }
    console.log('Found admin user:', admin);

    const login = await api('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    if (login.status !== 200) {
        console.log('Login failed:', login.status, JSON.stringify(login.body).slice(0, 300));
        return;
    }
    const token = login.body?.token || login.body?.data?.token;
    console.log('Logged in OK, token len:', token && token.length);

    const testUrl = 'https://job-boards.greenhouse.io/stripe/jobs/8077887';

    const create = await api('POST', '/job-links', {
        techstack: 'python',
        source_url: testUrl,
        job_apply_url: 'https://example.com/apply/immediate-fetch-test-' + Date.now(),
        is_available: 1
    }, token);
    console.log('Create status:', create.status);
    const newRow = create.body && create.body.data;
    console.log('Created row id:', newRow && newRow.id, 'fetch_status:', newRow && newRow.fetch_status);
    const newId = newRow && newRow.id;

    for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await api('GET', '/job-links/' + newId, null, token);
        const row = r.body && r.body.data;
        const elapsed = ((i + 1) * 2).toFixed(1);
        console.log(`t+${elapsed}s  status=${row && row.fetch_status}  company=${row && (row.company_name || 'null')}  title=${row && (row.position_title || 'null')}`);
        if (row && (row.fetch_status === 'success' || row.fetch_status === 'failed' || row.fetch_status === 'dead')) {
            console.log('Final fetch_error:', row.fetch_error);
            break;
        }
    }
})().catch((e) => { console.error('Test error:', e); process.exit(1); });
