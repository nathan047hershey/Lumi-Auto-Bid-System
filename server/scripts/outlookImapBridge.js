'use strict';
/**
 * Local Outlook.com → Lumi bridge via IMAP IDLE (event-driven, not 60s app poll).
 *
 * Setup once:
 *   1. Create an Outlook app password: https://account.live.com/proofs/AppPassword
 *   2. Put in server/.env (or local.env):
 *        OUTLOOK_IMAP_USER=you@outlook.com
 *        OUTLOOK_IMAP_PASS=your-app-password
 *        MAIL_FORWARD_TOKEN=<token from Auto Bidder forward webhook>
 *   3. npm run mail:bridge   (from repo root) or node server/scripts/outlookImapBridge.js
 *
 * Matching Greenhouse / security-code mail is POSTed to the local inbound webhook.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({
    path: require('path').join(__dirname, '..', 'local.env'),
    override: true
});

const { ImapFlow } = require('imapflow');
const axios = require('axios');

const USER = String(process.env.OUTLOOK_IMAP_USER || '').trim();
const PASS = String(process.env.OUTLOOK_IMAP_PASS || '').trim();
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
    // crude body: after first blank line
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
    if (!USER || !PASS) {
        console.error('[mail-bridge] Set OUTLOOK_IMAP_USER and OUTLOOK_IMAP_PASS in server/local.env');
        console.error('[mail-bridge] Create app password at https://account.live.com/proofs/AppPassword');
        process.exit(1);
    }
    if (!TOKEN && !process.env.MAIL_BRIDGE_WEBHOOK) {
        console.error('[mail-bridge] Set MAIL_FORWARD_TOKEN (from Auto Bidder → Enable email forward)');
        process.exit(1);
    }

    // Personal Outlook.com: imap-mail.outlook.com. M365/work: outlook.office365.com.
    const host = String(process.env.OUTLOOK_IMAP_HOST || 'imap-mail.outlook.com').trim();
    const client = new ImapFlow({
        host,
        port: 993,
        secure: true,
        auth: { user: USER, pass: PASS },
        logger: false
    });
    console.log('[mail-bridge] connecting to', host, 'as', USER);

    client.on('error', (err) => console.error('[mail-bridge] error', err?.message || err));

    await client.connect();
    console.log('[mail-bridge] connected as', USER, '→', WEBHOOK.replace(/token=[^&]+/, 'token=…'));

    const lock = await client.getMailboxLock('INBOX');
    try {
        // Catch recent unread that may already be waiting
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
                const status = client.mailbox;
                if (!status?.exists) return;
                const uid = status.exists; // sequence approx; better: search recent
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

    // Keep IDLE alive
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
