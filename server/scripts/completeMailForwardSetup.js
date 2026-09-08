'use strict';
/**
 * Completes Lumi mail-forward setup: enable token, write local.env, probe webhook.
 * Usage: node scripts/completeMailForwardSetup.js
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'local.env'), override: true });
const axios = require('axios');

const BASE = `http://127.0.0.1:${process.env.PORT || 9017}`;
const LOCAL_ENV = path.join(__dirname, '..', 'local.env');

function upsertLocalEnv(key, value) {
    let text = '';
    try { text = fs.readFileSync(LOCAL_ENV, 'utf8'); } catch (_) { text = ''; }
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text = `${text.replace(/\s*$/, '')}\n\n# Mail forward bridge\n${line}\n`;
    fs.writeFileSync(LOCAL_ENV, text, 'utf8');
}

async function main() {
    const login = await axios.post(`${BASE}/auth/login`, { username: 'admin', password: 'admin123' });
    const headers = { Authorization: `Bearer ${login.data.token}` };
    const { data: enabled } = await axios.post(`${BASE}/user/outlook/forward/enable`, {}, { headers });
    const forward = enabled.forward;
    upsertLocalEnv('MAIL_FORWARD_TOKEN', forward.token);
    upsertLocalEnv('MAIL_WEBHOOK_PUBLIC_BASE', process.env.MAIL_WEBHOOK_PUBLIC_BASE || forward.public_base);

    const publicUrl = forward.webhook_url;
    let probePublic = null;
    try {
        const res = await axios.post(publicUrl, {
            subject: 'Lumi setup probe — security code',
            text: 'Your security code is 445566',
            from: 'noreply@greenhouse.io'
        }, { timeout: 20000, validateStatus: () => true });
        probePublic = { status: res.status, data: res.data };
    } catch (err) {
        probePublic = { error: err.message };
    }

    const status = await axios.get(`${BASE}/user/outlook/status`, { headers });

    const out = {
        ok: true,
        webhook_url: publicUrl,
        receive_count: status.data.forward?.receive_count,
        last_used_at: status.data.forward?.last_used_at,
        probePublic,
        next: [
            'Power Automate: create flow “When a new email arrives (Outlook.com)” → HTTP POST JSON {subject,text,from} to webhook_url',
            'Or set OUTLOOK_IMAP_USER + OUTLOOK_IMAP_PASS (app password) and run: node server/scripts/outlookImapBridge.js'
        ]
    };
    console.log(JSON.stringify(out, null, 2));
    fs.writeFileSync(
        path.join(__dirname, 'mail-forward-setup-result.json'),
        JSON.stringify(out, null, 2),
        'utf8'
    );
}

main().catch((err) => {
    console.error(err.response?.data || err.message || err);
    process.exit(1);
});
