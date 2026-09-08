'use strict';
/**
 * Inbound email via forwarding / automation — no inbox polling.
 *
 * Flow:
 * 1. User enables a per-account forward token in Auto Bidder
 * 2. Outlook rule / Power Automate / Zapier / Mailgun Inbound Parse
 *    POSTs each matching message to /api/hooks/inbound-mail
 * 3. OTP is extracted and stored; waitForOtp only watches local DB
 *
 * Graph OAuth sync is optional and OFF by default (see outlookMailService).
 */

const crypto = require('crypto');
const { getOne, getAll, runQuery, saveDatabase, getDb } = require('../config/database');
const { extractOtp, htmlToText, upsertInboundMessage } = require('./outlookMailService');

function ensureTables() {
    const db = getDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS mail_forward_tokens (
        user_id INTEGER PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at TEXT,
        updated_at TEXT,
        last_used_at TEXT,
        receive_count INTEGER DEFAULT 0
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mail_fwd_token ON mail_forward_tokens(token)`);
    try { saveDatabase(); } catch (_) { /* ignore */ }
}

function publicBase() {
    const fromEnv = String(process.env.MAIL_WEBHOOK_PUBLIC_BASE || '').trim().replace(/\/$/, '');
    if (fromEnv) return fromEnv;
    const port = process.env.PORT || 9017;
    return `http://127.0.0.1:${port}`;
}

function webhookPath(token) {
    return `/api/hooks/inbound-mail?token=${encodeURIComponent(token)}`;
}

function webhookUrlForToken(token) {
    return `${publicBase()}${webhookPath(token)}`;
}

function getForwardByUser(userId) {
    ensureTables();
    return getOne(`SELECT * FROM mail_forward_tokens WHERE user_id = ?`, [userId]) || null;
}

function getForwardByToken(token) {
    ensureTables();
    const t = String(token || '').trim();
    if (!t) return null;
    return getOne(`SELECT * FROM mail_forward_tokens WHERE token = ?`, [t]) || null;
}

function forwardPublic(row) {
    if (!row) return null;
    return {
        enabled: true,
        token: row.token,
        webhook_url: webhookUrlForToken(row.token),
        webhook_path: webhookPath(row.token),
        created_at: row.created_at || null,
        last_used_at: row.last_used_at || null,
        receive_count: Number(row.receive_count) || 0,
        public_base: publicBase(),
        needs_tunnel: !String(process.env.MAIL_WEBHOOK_PUBLIC_BASE || '').trim()
    };
}

function enableForward(userId, { rotate = false } = {}) {
    ensureTables();
    const uid = parseInt(userId, 10);
    if (!uid) throw new Error('user_id required');
    const existing = getForwardByUser(uid);
    if (existing && !rotate) {
        return forwardPublic(existing);
    }
    const token = crypto.randomBytes(24).toString('hex');
    const now = new Date().toISOString();
    if (existing) {
        runQuery(
            `UPDATE mail_forward_tokens
             SET token = ?, updated_at = ?, last_used_at = NULL, receive_count = 0
             WHERE user_id = ?`,
            [token, now, uid]
        );
    } else {
        runQuery(
            `INSERT INTO mail_forward_tokens (user_id, token, label, created_at, updated_at, receive_count)
             VALUES (?, ?, ?, ?, ?, 0)`,
            [uid, token, 'default', now, now]
        );
    }
    return forwardPublic(getForwardByUser(uid));
}

function disableForward(userId) {
    ensureTables();
    runQuery(`DELETE FROM mail_forward_tokens WHERE user_id = ?`, [userId]);
    return { ok: true };
}

function configStatus() {
    return {
        mode: 'forward',
        public_base: publicBase(),
        needs_tunnel: !String(process.env.MAIL_WEBHOOK_PUBLIC_BASE || '').trim(),
        poll_disabled: true
    };
}

/**
 * Normalize Zapier / Make / Power Automate / Mailgun / SendGrid / raw JSON bodies.
 */
function normalizeInboundPayload(req) {
    const body = req.body || {};
    const q = req.query || {};

    // Mailgun Inbound Parse (urlencoded)
    if (body['body-plain'] || body['body-html'] || (body.sender && body.subject != null && body['Message-Id'])) {
        return {
            subject: body.subject || '',
            from_address: body.sender || body.from || '',
            from_name: '',
            text: body['body-plain'] || '',
            html: body['body-html'] || '',
            message_id: body['Message-Id'] || body['message-id'] || null,
            received_at: new Date().toISOString()
        };
    }

    // SendGrid Inbound Parse often uses multipart; text fields land in body
    if (body.text || body.html || body.email) {
        const fromRaw = body.from || body.envelope || '';
        const fromMatch = String(fromRaw).match(/<?([^\s<>]+@[^\s<>]+)>?/);
        return {
            subject: body.subject || '',
            from_address: fromMatch?.[1] || String(fromRaw).slice(0, 200),
            from_name: '',
            text: body.text || '',
            html: body.html || '',
            message_id: body.headers?.match?.(/Message-ID:\s*(.+)/i)?.[1]
                || body.messageId
                || null,
            received_at: body.received_at || new Date().toISOString()
        };
    }

    // Power Automate / Zapier / Make / generic JSON
    const subject = body.subject || body.Subject || body.title || q.subject || '';
    const text = body.text
        || body.body
        || body.Body
        || body.plain
        || body.preview
        || body.bodyPreview
        || '';
    const html = body.html || body.Html || body.bodyHtml || '';
    const from = body.from
        || body.from_address
        || body.From
        || body.sender
        || body.fromAddress
        || '';
    const fromObj = typeof from === 'object'
        ? (from.email || from.address || from.emailAddress?.address || '')
        : String(from || '');

    return {
        subject: String(subject || ''),
        from_address: fromObj,
        from_name: body.from_name || body.fromName || '',
        text: String(text || ''),
        html: String(html || ''),
        message_id: body.message_id || body.messageId || body.id || null,
        received_at: body.received_at || body.receivedAt || body.receivedDateTime || new Date().toISOString()
    };
}

function ingestForwardedMail(token, payload) {
    ensureTables();
    const row = getForwardByToken(token);
    if (!row) {
        const err = new Error('invalid_forward_token');
        err.status = 401;
        throw err;
    }

    const subject = String(payload.subject || '');
    const text = payload.text || (payload.html ? htmlToText(payload.html) : '');
    const preview = String(text || subject).slice(0, 500);
    const otp = extractOtp(`${subject}\n${preview}\n${text}`);
    const graphId = payload.message_id
        ? `fwd:${String(payload.message_id).slice(0, 180)}`
        : `fwd:${crypto.createHash('sha256')
            .update([row.user_id, subject, payload.from_address, preview, payload.received_at].join('|'))
            .digest('hex')
            .slice(0, 40)}`;

    upsertInboundMessage(row.user_id, {
        graph_id: graphId,
        subject,
        from_address: payload.from_address || '',
        from_name: payload.from_name || '',
        received_at: payload.received_at || new Date().toISOString(),
        body_preview: preview,
        body_text: String(text || '').slice(0, 20000),
        otp_code: otp,
        is_read: 0
    });

    runQuery(
        `UPDATE mail_forward_tokens
         SET last_used_at = ?, receive_count = COALESCE(receive_count, 0) + 1, updated_at = ?
         WHERE user_id = ?`,
        [new Date().toISOString(), new Date().toISOString(), row.user_id]
    );

    return {
        ok: true,
        user_id: row.user_id,
        otp_code: otp,
        subject,
        graph_id: graphId
    };
}

function listRecent(userId, { limit = 20 } = {}) {
    return getAll(
        `SELECT id, graph_id, subject, from_address, received_at, body_preview, otp_code, created_at
         FROM outlook_messages
         WHERE user_id = ?
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
        [userId, Math.min(50, Math.max(1, Number(limit) || 20))]
    );
}

module.exports = {
    ensureTables,
    configStatus,
    getForwardByUser,
    getForwardByToken,
    forwardPublic,
    enableForward,
    disableForward,
    normalizeInboundPayload,
    ingestForwardedMail,
    listRecent,
    webhookUrlForToken,
    publicBase
};
