'use strict';
/**
 * One-shot: enable forward webhook for a user and print setup summary.
 * Usage: node scripts/setupMailForward.js [username] [password]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const BASE = process.env.SETUP_API_BASE || `http://127.0.0.1:${process.env.PORT || 9017}`;
const user = process.argv[2] || 'admin';
const pass = process.argv[3] || 'admin123';

async function main() {
    const login = await axios.post(`${BASE}/auth/login`, { username: user, password: pass });
    const token = login.data.token;
    const headers = { Authorization: `Bearer ${token}` };
    const enabled = await axios.post(`${BASE}/user/outlook/forward/enable`, {}, { headers });
    const status = await axios.get(`${BASE}/user/outlook/status`, { headers });
    const forward = enabled.data.forward || status.data.forward;
    const probe = await axios.post(forward.webhook_url.replace('127.0.0.1', '127.0.0.1'), {
        subject: 'Setup probe — Greenhouse security code',
        text: 'Your security code is 112233',
        from: 'noreply@greenhouse.io'
    });
    console.log(JSON.stringify({
        ok: true,
        user: login.data.user?.username,
        webhook_url: forward.webhook_url,
        receive_count: status.data.forward?.receive_count ?? forward.receive_count,
        probe: probe.data,
        needs_tunnel: forward.needs_tunnel,
        tip: 'Point Power Automate / Zapier HTTP action at webhook_url with JSON { subject, text, from }'
    }, null, 2));
}

main().catch((err) => {
    console.error(err.response?.data || err.message || err);
    process.exit(1);
});
