'use strict';
/**
 * Free Gmail receive via IMAP App Password (no paid inbound API).
 *
 * Setup (Google, free):
 *   1. Enable 2-Step Verification on the Google account
 *   2. Create an App Password: https://myaccount.google.com/apppasswords
 *   3. Auto Bidder → Advanced → Gmail (free) → Connect with email + app password
 *
 * Messages land in outlook_messages so waitForOtp / extension OTP flow
 * works unchanged. Background poll is light; waitForOtp also syncs on demand.
 */

const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { getOne, getAll, runQuery, saveDatabase, getDb } = require('../config/database');
const { extractOtp, htmlToText, upsertInboundMessage } = require('./outlookMailService');

const HOST_DEFAULT = 'imap.gmail.com';
const POLL_MS = Math.max(15_000, Number(process.env.GMAIL_IMAP_POLL_MS) || 30_000);
const LOOKBACK_MS = Math.max(60_000, Number(process.env.GMAIL_IMAP_LOOKBACK_MS) || 2 * 24 * 3600 * 1000);
const FILTER_RE = /greenhouse|security\s*code|verification\s*code|one[-\s]?time|confirm\s+your\s+email|passcode|otp/i;

let pollTimer = null;
let pollInFlight = false;

function secretKey() {
    const raw = String(
        process.env.GMAIL_IMAP_SECRET
        || process.env.OUTLOOK_CLIENT_ID
        || process.env.JWT_SECRET
        || 'lumi-local-gmail-imap'
    ).trim();
    return crypto.createHash('sha256').update(raw).digest();
}

function encryptPass(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptPass(blob) {
    const s = String(blob || '');
    if (!s.startsWith('v1:')) return s; // legacy / plain (bridge scripts)
    const [, ivB64, tagB64, dataB64] = s.split(':');
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        secretKey(),
        Buffer.from(ivB64, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final()
    ]).toString('utf8');
}

function ensureTables() {
    const db = getDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS gmail_imap_mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        app_password_enc TEXT NOT NULL,
        host TEXT DEFAULT 'imap.gmail.com',
        enabled INTEGER DEFAULT 1,
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(user_id, email)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_gmail_imap_user ON gmail_imap_mailboxes(user_id)`);
    try { saveDatabase(); } catch (_) { /* ignore */ }
}

function configStatus() {
    return {
        gmail_imap: true,
        free: true,
        host_default: HOST_DEFAULT,
        poll_ms: POLL_MS,
        setup_url: 'https://myaccount.google.com/apppasswords',
        note: 'Free Gmail App Password + IMAP — no Google Cloud / Pub/Sub / paid inbound API'
    };
}

function mailboxPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        host: row.host || HOST_DEFAULT,
        enabled: !!row.enabled,
        last_sync_at: row.last_sync_at || null,
        last_error: row.last_error || null,
        provider: 'gmail_imap',
        free: true
    };
}

function listMailboxes(userId) {
    ensureTables();
    return getAll(
        `SELECT * FROM gmail_imap_mailboxes WHERE user_id = ? ORDER BY id ASC`,
        [userId]
    );
}

function listMailboxesPublic(userId) {
    return listMailboxes(userId).map(mailboxPublic);
}

function getMailboxForUser(userId, mailboxId) {
    ensureTables();
    return getOne(
        `SELECT * FROM gmail_imap_mailboxes WHERE id = ? AND user_id = ?`,
        [mailboxId, userId]
    ) || null;
}

function listEnabledAll() {
    ensureTables();
    return getAll(
        `SELECT * FROM gmail_imap_mailboxes WHERE enabled = 1 ORDER BY id ASC`
    );
}

async function verifyCredentials(email, appPassword, host = HOST_DEFAULT) {
    const client = new ImapFlow({
        host: host || HOST_DEFAULT,
        port: 993,
        secure: true,
        auth: { user: String(email).trim(), pass: String(appPassword).replace(/\s+/g, '') },
        logger: false,
        greetingTimeout: 20000
    });
    try {
        await client.connect();
        await client.mailboxOpen('INBOX');
        return { ok: true };
    } finally {
        try { await client.logout(); } catch (_) { /* ignore */ }
    }
}

async function connectMailbox(userId, { email, app_password, host } = {}) {
    ensureTables();
    const uid = parseInt(userId, 10);
    const addr = String(email || '').trim().toLowerCase();
    const pass = String(app_password || '').replace(/\s+/g, '');
    const imapHost = String(host || HOST_DEFAULT).trim() || HOST_DEFAULT;
    if (!uid) throw Object.assign(new Error('user_id required'), { status: 400 });
    if (!addr || !addr.includes('@')) {
        throw Object.assign(new Error('Valid Gmail address required'), { status: 400 });
    }
    if (!pass || pass.length < 8) {
        throw Object.assign(new Error('Gmail App Password required (16 chars from Google)'), { status: 400 });
    }

    await verifyCredentials(addr, pass, imapHost);

    const now = new Date().toISOString();
    const enc = encryptPass(pass);
    const existing = getOne(
        `SELECT id FROM gmail_imap_mailboxes WHERE user_id = ? AND lower(email) = lower(?)`,
        [uid, addr]
    );
    if (existing) {
        runQuery(
            `UPDATE gmail_imap_mailboxes
             SET app_password_enc = ?, host = ?, enabled = 1, last_error = NULL, updated_at = ?
             WHERE id = ?`,
            [enc, imapHost, now, existing.id]
        );
    } else {
        runQuery(
            `INSERT INTO gmail_imap_mailboxes
              (user_id, email, app_password_enc, host, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
            [uid, addr, enc, imapHost, now, now]
        );
    }
    const row = getOne(
        `SELECT * FROM gmail_imap_mailboxes WHERE user_id = ? AND lower(email) = lower(?)`,
        [uid, addr]
    );
    // Immediate pull so OTP wait can work right away
    syncMailbox(row.id).catch(() => {});
    return mailboxPublic(row);
}

function disconnectMailbox(userId, mailboxId) {
    ensureTables();
    const row = getMailboxForUser(userId, mailboxId);
    if (!row) return { ok: false, error: 'not_found' };
    runQuery(`DELETE FROM gmail_imap_mailboxes WHERE id = ? AND user_id = ?`, [mailboxId, userId]);
    return { ok: true, mailbox_id: mailboxId };
}

function disconnectAll(userId) {
    ensureTables();
    runQuery(`DELETE FROM gmail_imap_mailboxes WHERE user_id = ?`, [userId]);
    return { ok: true };
}

function decodeMimeHeader(value) {
    const raw = String(value || '').replace(/\r/g, '').trim();
    // =?UTF-8?B?...?=  / =?UTF-8?Q?...?=
    return raw.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
        try {
            if (String(enc).toUpperCase() === 'B') {
                return Buffer.from(data, 'base64').toString('utf8');
            }
            const q = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) =>
                String.fromCharCode(parseInt(h, 16))
            );
            return Buffer.from(q, 'binary').toString(charset || 'utf8');
        } catch {
            return raw;
        }
    });
}

function parseRawMessage(rawBuf) {
    const raw = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf || '');
    const subject = decodeMimeHeader(raw.match(/^Subject:\s*(.+)$/im)?.[1] || '');
    const fromLine = decodeMimeHeader(raw.match(/^From:\s*(.+)$/im)?.[1] || '');
    const messageId = (raw.match(/^Message-ID:\s*(.+)$/im)?.[1] || '').replace(/\r/g, '').trim();
    const dateHdr = (raw.match(/^Date:\s*(.+)$/im)?.[1] || '').replace(/\r/g, '').trim();
    const split = raw.split(/\r?\n\r?\n/);
    let body = split.slice(1).join('\n\n').slice(0, 80000);
    // Prefer text/plain chunk if multipart markers present
    const plain = body.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
    const htmlPart = body.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/i);
    let text = '';
    let html = '';
    if (plain?.[1]) text = plain[1].replace(/=\r?\n/g, '').slice(0, 50000);
    if (htmlPart?.[1]) html = htmlPart[1].replace(/=\r?\n/g, '').slice(0, 50000);
    if (!text && html) text = htmlToText(html);
    if (!text) text = body.replace(/=\r?\n/g, '').slice(0, 50000);
    const fromMatch = fromLine.match(/<?([^\s<>]+@[^\s<>]+)>?/);
    let receivedAt = new Date().toISOString();
    if (dateHdr) {
        const d = new Date(dateHdr);
        if (!Number.isNaN(d.getTime())) receivedAt = d.toISOString();
    }
    return {
        subject,
        from_address: fromMatch?.[1] || fromLine.slice(0, 200),
        from_name: fromLine.replace(/<[^>]+>/, '').trim().slice(0, 200),
        message_id: messageId,
        text,
        html,
        received_at: receivedAt
    };
}

function interesting(msg) {
    const hay = `${msg.subject || ''}\n${msg.from_address || ''}\n${msg.text || ''}`;
    return FILTER_RE.test(hay) || !!extractOtp(hay);
}

async function syncMailbox(mailboxId) {
    ensureTables();
    const row = getOne(`SELECT * FROM gmail_imap_mailboxes WHERE id = ?`, [mailboxId]);
    if (!row || !row.enabled) return { ok: false, error: 'disabled_or_missing' };

    const pass = decryptPass(row.app_password_enc);
    const client = new ImapFlow({
        host: row.host || HOST_DEFAULT,
        port: 993,
        secure: true,
        auth: { user: row.email, pass },
        logger: false,
        greetingTimeout: 25000
    });

    let stored = 0;
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const since = new Date(Date.now() - LOOKBACK_MS);
            // Unread recent mail first; also search subject keywords when possible
            const uids = await client.search({
                seen: false,
                since
            }, { uid: true });
            const list = Array.isArray(uids) ? uids.slice(-25) : [];
            for (const uid of list) {
                try {
                    const downloaded = await client.download(uid, { uid: true });
                    const chunks = [];
                    for await (const chunk of downloaded.content) chunks.push(chunk);
                    const parsed = parseRawMessage(Buffer.concat(chunks));
                    if (!interesting(parsed)) continue;
                    const otp = extractOtp(`${parsed.subject}\n${parsed.text}`);
                    const graphId = parsed.message_id
                        ? `gmail:${String(parsed.message_id).slice(0, 180)}`
                        : `gmail:${row.id}:${uid}`;
                    upsertInboundMessage(row.user_id, {
                        mailbox_id: null,
                        graph_id: graphId,
                        subject: parsed.subject,
                        from_address: parsed.from_address,
                        from_name: parsed.from_name,
                        received_at: parsed.received_at,
                        body_preview: String(parsed.text || '').slice(0, 500),
                        body_text: String(parsed.text || '').slice(0, 20000),
                        otp_code: otp,
                        is_read: 0
                    });
                    stored += 1;
                } catch (err) {
                    console.warn('[gmail-imap] uid', uid, err?.message || err);
                }
            }
        } finally {
            lock.release();
        }
        const now = new Date().toISOString();
        runQuery(
            `UPDATE gmail_imap_mailboxes
             SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
            [now, now, row.id]
        );
        return { ok: true, stored, email: row.email };
    } catch (err) {
        const msg = err?.message || String(err);
        runQuery(
            `UPDATE gmail_imap_mailboxes SET last_error = ?, updated_at = ? WHERE id = ?`,
            [msg.slice(0, 500), new Date().toISOString(), row.id]
        );
        return { ok: false, error: msg, email: row.email };
    } finally {
        try { await client.logout(); } catch (_) { /* ignore */ }
    }
}

async function syncAllForUser(userId) {
    const boxes = listMailboxes(userId).filter((b) => b.enabled);
    const results = [];
    for (const b of boxes) {
        results.push(await syncMailbox(b.id));
    }
    return { ok: true, results };
}

async function syncAllConnected() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
        const boxes = listEnabledAll();
        for (const b of boxes) {
            await syncMailbox(b.id).catch(() => {});
        }
    } finally {
        pollInFlight = false;
    }
}

function startGmailImapService() {
    ensureTables();
    if (pollTimer) return;
    if (/^(0|false|off|no)$/i.test(String(process.env.GMAIL_IMAP_POLL_ENABLED || '1').trim())) {
        console.log('[gmail-imap] poll disabled (GMAIL_IMAP_POLL_ENABLED=0)');
        return;
    }
    pollTimer = setInterval(() => {
        syncAllConnected().catch((err) => console.warn('[gmail-imap] poll', err?.message || err));
    }, POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
    setTimeout(() => { syncAllConnected().catch(() => {}); }, 8000);
    console.log(`[gmail-imap] free IMAP receive enabled (poll ${POLL_MS}ms)`);
}

function stopGmailImapService() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

module.exports = {
    ensureTables,
    configStatus,
    listMailboxes,
    listMailboxesPublic,
    getMailboxForUser,
    connectMailbox,
    disconnectMailbox,
    disconnectAll,
    syncMailbox,
    syncAllForUser,
    syncAllConnected,
    startGmailImapService,
    stopGmailImapService,
    verifyCredentials
};
