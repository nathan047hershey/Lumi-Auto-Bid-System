'use strict';
/**
 * Free local mail → Lumi bridge via IMAP IDLE (Gmail or Outlook).
 *
 * Gmail (recommended, free):
 *   1. App password: https://myaccount.google.com/apppasswords
 *   2. server/local.env:
 *        GMAIL_IMAP_USER=you@gmail.com
 *        GMAIL_IMAP_PASS=your-16-char-app-password
 *        MAIL_FORWARD_TOKEN=<token from Auto Bidder forward webhook>
 *   3. npm run mail:bridge
 *
 * Outlook.com (also free with app password):
 *        OUTLOOK_IMAP_USER=you@outlook.com
 *        OUTLOOK_IMAP_PASS=...
 *        OUTLOOK_IMAP_HOST=imap-mail.outlook.com
 *
 * Prefer in-app Auto Bidder → Gmail (free) connect — no separate process needed.
 * This script is for when you want IDLE outside the API process.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({
    path: require('path').join(__dirname, '..', 'local.env'),
    override: true
});

const { ImapFlow } = require('imapflow');
const axios = require('axios');

const GMAIL_USER = String(process.env.GMAIL_IMAP_USER || '').trim();
const GMAIL_PASS = String(process.env.GMAIL_IMAP_PASS || '').replace(/\s+/g, '');
const OUTLOOK_USER = String(process.env.OUTLOOK_IMAP_USER || '').trim();
const OUTLOOK_PASS = String(process.env.OUTLOOK_IMAP_PASS || '').replace(/\s+/g, '');

const provider = GMAIL_USER && GMAIL_PASS
    ? {
        name: 'gmail',
        user: GMAIL_USER,
        pass: GMAIL_PASS,
        host: String(process.env.GMAIL_IMAP_HOST || 'imap.gmail.com').trim()
    }
    : {
        name: 'outlook',
        user: OUTLOOK_USER,
        pass: OUTLOOK_PASS,
        host: String(process.env.OUTLOOK_IMAP_HOST || 'imap-mail.outlook.com').trim()
    };

const TOKEN = String(process.env.MAIL_FORWARD_TOKEN || '').trim();
const PORT = process.env.PORT || 9017;
const WEBHOOK = String(
    process.env.MAIL_BRIDGE_WEBHOOK
    || `http://127.0.0.1:${PORT}/api/hooks/inbound-mail?token=${encodeURIComponent(TOKEN)}`
).trim();

const FILTER_RE = /greenhouse|security\s*code|verification\s*code|one[-\s]?time|confirm\s+your\s+email/i;

function interesting(subject, from, text) {
    const hay = `${subject || ''}\n${from || ''}\n${text || ''}`;
    return FILTER_RE.test(hay);
}

async function postMail(msg) {
    const { data } = await axios.post(WEBHOOK, msg, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: () => true
    });
    return data;
}

async function handleUid(client, uid) {
    const downloaded = await client.download(uid, { uid: true });
    const chunks = [];
    for await (const chunk of downloaded.content) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const subject = (raw.match(/^Subject:\s*(.+)$/im)?.[1] || '').replace(/\r/g, '').trim();
    const from = (raw.match(/^From:\s*(.+)$/im)?.[1] || '').replace(/\r/g, '').trim();
    const messageId = (raw.match(/^Message-ID:\s*(.+)$/im)?.[1] || '').replace(/\r/g, '').trim();
    const split = raw.split(/\r?\n\r?\n/);
    const text = split.slice(1).join('\n\n').slice(0, 50000);
    if (!interesting(subject, from, text)) {
        console.log('[mail-bridge] skip', subject.slice(0, 80));
        return;
    }
    const result = await postMail({
        subject,
        from,
        text,
        message_id: messageId || `imap-${uid}`,
        received_at: new Date().toISOString()
    });
    console.log('[mail-bridge] forwarded', { subject: subject.slice(0, 80), otp: result?.otp_code, ok: result?.ok });
}

async function main() {
    if (!provider.user || !provider.pass) {
        console.error('[mail-bridge] Set free IMAP credentials in server/local.env:');
        console.error('  Gmail:   GMAIL_IMAP_USER + GMAIL_IMAP_PASS (https://myaccount.google.com/apppasswords)');
        console.error('  Outlook: OUTLOOK_IMAP_USER + OUTLOOK_IMAP_PASS');
        process.exit(1);
    }
    if (!TOKEN && !process.env.MAIL_BRIDGE_WEBHOOK) {
        console.error('[mail-bridge] Set MAIL_FORWARD_TOKEN (from Auto Bidder → Enable email forward)');
        console.error('[mail-bridge] Or use in-app Gmail (free) connect — no bridge script needed.');
        process.exit(1);
    }

    const client = new ImapFlow({
        host: provider.host,
        port: 993,
        secure: true,
        auth: { user: provider.user, pass: provider.pass },
        logger: false
    });
    console.log(`[mail-bridge] ${provider.name} connecting to`, provider.host, 'as', provider.user);

    client.on('error', (err) => console.error('[mail-bridge] error', err?.message || err));

    await client.connect();
    console.log('[mail-bridge] connected as', provider.user, '→', WEBHOOK.replace(/token=[^&]+/, 'token=…'));

    const lock = await client.getMailboxLock('INBOX');
    try {
        for await (const msg of client.fetch({ seen: false, since: new Date(Date.now() - 2 * 24 * 3600 * 1000) }, { uid: true })) {
            try {
                await handleUid(client, msg.uid);
            } catch (err) {
                console.warn('[mail-bridge] fetch uid', msg.uid, err?.message || err);
            }
        }
    } finally {
        lock.release();
    }

    client.on('exists', async () => {
        try {
            const lock2 = await client.getMailboxLock('INBOX');
            try {
                const uids = await client.search({ seen: false }, { uid: true });
                const list = Array.isArray(uids) ? uids.slice(-5) : [];
                for (const id of list) {
                    await handleUid(client, id);
                }
            } finally {
                lock2.release();
            }
        } catch (err) {
            console.warn('[mail-bridge] exists handler', err?.message || err);
        }
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            await client.idle();
        } catch (err) {
            console.warn('[mail-bridge] idle ended', err?.message || err);
            await new Promise((r) => setTimeout(r, 5000));
            if (!client.usable) {
                await client.connect().catch(() => {});
            }
        }
    }
}

main().catch((err) => {
    console.error('[mail-bridge] fatal', err?.message || err);
    process.exit(1);
});
