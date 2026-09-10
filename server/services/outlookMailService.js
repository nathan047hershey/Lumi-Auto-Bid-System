/**
 * TOKEN ENCRYPTION: access_token and refresh_token are encrypted with AES-256-GCM
 * before storage. Key derived from OUTLOOK_TOKEN_KEY (or JWT_SECRET as fallback).
 */

/**
 * Token encryption using AES-256-GCM.
 * Key derived from OUTLOOK_TOKEN_KEY or falls back to JWT_SECRET.
 * Tokens stored in DB are encrypted; decrypted only in memory during use.
 */
function getTokenKey() {
    const key = process.env.OUTLOOK_TOKEN_KEY || process.env.JWT_SECRET;
    if (!key) {
        throw new Error('Set OUTLOOK_TOKEN_KEY or JWT_SECRET in server/.env to encrypt Outlook tokens');
    }
    // Ensure 32 bytes for AES-256
    return crypto.createHash('sha256').update(key).digest();
}

function encryptToken(plain) {
    if (!plain) return null;
    const key = getTokenKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: iv:authTag:encrypted (all base64)
    return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted.toString('base64')
    ].join(':');
}

function decryptToken(encrypted) {
    if (!encrypted) return null;
    // Detect legacy unencrypted tokens (no colons, looks like JWT or plain string)
    if (!/^[A-Za-z0-9+/=]+:([A-Za-z0-9+/=]+:)?[A-Za-z0-9+/=]+$/.test(encrypted)) {
        return encrypted; // Already plain text (legacy)
    }
    try {
        const [ivB64, authTagB64, dataB64] = encrypted.split(':');
        if (!ivB64 || !authTagB64 || !dataB64) return encrypted;
        const key = getTokenKey();
        const iv = Buffer.from(ivB64, 'base64');
        const authTag = Buffer.from(authTagB64, 'base64');
        const encryptedData = Buffer.from(dataB64, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(encryptedData) + decipher.final('utf8');
    } catch (err) {
        console.warn('[outlook] token decrypt failed, returning as-is:', err?.message);
        return encrypted; // Fallback: return as-is
    }
}


'use strict';
/**
 * Microsoft Graph mail — multi-mailbox (free Graph API for personal Outlook/Hotmail).
 *
 * Preferred receive modes (all use Graph — not IMAP):
 *   1. Push change notifications when MAIL_WEBHOOK_PUBLIC_BASE is public HTTPS
 *   2. Otherwise auto Graph poll + on-demand sync during OTP wait
 *
 * Set OUTLOOK_CLIENT_ID (Azure app, personal accounts, public client).
 * No 60s poll unless OUTLOOK_POLL_ENABLED=1 or auto-poll fallback applies.
 */

const crypto = require('crypto');
const axios = require('axios');
const { getDb, getOne, getAll, runQuery, saveDatabase } = require('../config/database');

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * OAuth2 Authority host for Microsoft identity platform.
 *
 * Options:
 *   - "consumers"  : Personal Microsoft accounts (outlook.com, hotmail.com, live.com)
 *   - "common"     : Multi-tenant (any organization's accounts)
 *   - "{tenant-id}": Specific organization (e.g., "myorganization.onmicrosoft.com")
 *
 * Set via OUTLOOK_AUTH_TENANT in server/.env
 */
function getAuthTenant() {
    return String(process.env.OUTLOOK_AUTH_TENANT || 'consumers').trim().toLowerCase();
}

function getAuthHost() {
    const tenant = getAuthTenant();
    // Validate tenant is safe (alphanumeric, hyphens, underscores)
    if (!/^[a-z0-9\-_]+$/i.test(tenant)) {
        throw new Error(`Invalid OUTLOOK_AUTH_TENANT value: "${tenant}"`);
    }
    return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

const AUTH_HOST = getAuthHost();
const SCOPES = 'offline_access User.Read Mail.Read';
const POLL_ENABLED = /^(1|true|yes)$/i.test(String(process.env.OUTLOOK_POLL_ENABLED || '').trim());
const SYNC_MS = Math.max(60_000, Number(process.env.OUTLOOK_SYNC_MS) || 300_000);
const MAX_SYNC = 25;
/** Sync Graph inbox while waiting for OTP (default ON). Set OUTLOOK_ON_DEMAND_GRAPH=0 to disable. */
const ON_DEMAND_GRAPH = !/^(0|false|off|no)$/i.test(String(process.env.OUTLOOK_ON_DEMAND_GRAPH ?? '1').trim());
/** When push URL is localhost, auto-enable Graph poll so OTP still works. */
const AUTO_POLL_WHEN_NO_TUNNEL = !/^(0|false|off|no)$/i.test(String(process.env.OUTLOOK_GRAPH_AUTO_POLL ?? '1').trim());

let syncTimer = null;
let syncInFlight = false;
let renewTimer = null;

function clientId() {
    return String(process.env.OUTLOOK_CLIENT_ID || '').trim();
}

function clientSecret() {
    return String(process.env.OUTLOOK_CLIENT_SECRET || '').trim();
}

function redirectUri() {
    const port = process.env.PORT || 9017;
    return String(process.env.OUTLOOK_REDIRECT_URI || `http://127.0.0.1:${port}/api/user/outlook/callback`).trim();
}

function publicBase() {
    const fromEnv = String(process.env.MAIL_WEBHOOK_PUBLIC_BASE || '').trim().replace(/\/$/, '');
    if (fromEnv) return fromEnv;
    const port = process.env.PORT || 9017;
    return `http://127.0.0.1:${port}`;
}

function graphNotifyUrl() {
    return `${publicBase()}/api/hooks/graph-mail`;
}

function hasPublicNotifyUrl() {
    const url = graphNotifyUrl();
    return !!url && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(url);
}

/** Graph inbox sync on a timer (explicit poll or auto when tunnel missing). */
function graphPollActive() {
    if (!clientId()) return false;
    if (POLL_ENABLED) return true;
    if (AUTO_POLL_WHEN_NO_TUNNEL && !hasPublicNotifyUrl()) return true;
    return false;
}

function ensureTables() {
    const db = getDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS outlook_mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        email TEXT,
        display_name TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        connected_at TEXT,
        updated_at TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        subscription_id TEXT,
        subscription_expires_at TEXT,
        client_state TEXT,
        UNIQUE(user_id, email)
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_outlook_mb_user ON outlook_mailboxes(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_outlook_mb_sub ON outlook_mailboxes(subscription_id)`);

    // Migrate legacy single-account table if present
    try {
        const legacy = getAll(`SELECT * FROM outlook_accounts`);
        for (const row of legacy) {
            if (!decryptedRefresh && !row.access_token) continue;
            const email = row.email || `legacy-user-${row.user_id}@local`;
            const exists = getOne(
                `SELECT id FROM outlook_mailboxes WHERE user_id = ? AND lower(email) = lower(?)`,
                [row.user_id, email]
            );
            if (exists) continue;
            runQuery(
                `INSERT INTO outlook_mailboxes (
                    user_id, email, display_name, access_token, refresh_token, expires_at, scope,
                    connected_at, updated_at, last_sync_at, last_error,
                    subscription_id, subscription_expires_at, client_state
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    row.user_id, email, row.display_name, row.access_token, decryptedRefresh,
                    row.expires_at, row.scope, row.connected_at, row.updated_at, row.last_sync_at,
                    row.last_error, row.subscription_id, row.subscription_expires_at, row.client_state
                ]
            );
        }
    } catch (_) { /* no legacy table */ }

    db.run(`
      CREATE TABLE IF NOT EXISTS outlook_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mailbox_id INTEGER,
        graph_id TEXT NOT NULL,
        subject TEXT,
        from_address TEXT,
        from_name TEXT,
        received_at TEXT,
        body_preview TEXT,
        body_text TEXT,
        otp_code TEXT,
        is_read INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, graph_id)
      )
    `);
    try { db.run(`ALTER TABLE outlook_messages ADD COLUMN mailbox_id INTEGER`); } catch (_) { /* exists */ }
    db.run(`CREATE INDEX IF NOT EXISTS idx_outlook_msg_user_recv ON outlook_messages(user_id, received_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_outlook_msg_otp ON outlook_messages(user_id, otp_code)`);
    try { saveDatabase(); } catch (_) { /* ignore */ }
}

function configStatus() {
    const id = clientId();
    const pushReady = hasPublicNotifyUrl();
    const pollActive = graphPollActive();
    const tenant = getAuthTenant();
    return {
        mode: pushReady ? 'graph_push_multi' : (pollActive ? 'graph_poll_multi' : 'graph_connect_only'),
        provider: 'microsoft_graph',
        configured: !!id,
        clientIdSet: !!id,
        hasSecret: !!clientSecret(),
        redirectUri: redirectUri(),
        scopes: SCOPES,
        pollEnabled: POLL_ENABLED,
        pollActive,
        onDemandGraph: ON_DEMAND_GRAPH,
        syncMs: SYNC_MS,
        notifyUrl: graphNotifyUrl(),
        publicBase: publicBase(),
        needsTunnel: !pushReady,
        pushReady,
        multiMailbox: true,
        authTenant: tenant,
        authTenantDescription: tenant === 'consumers' ? 'Personal Microsoft accounts' :
            tenant === 'common' ? 'Multi-tenant (any organization)' :
            'Organization-specific tenant',
        azureSetupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
    };
}

function getMailbox(mailboxId) {
    ensureTables();
    return getOne(`SELECT * FROM outlook_mailboxes WHERE id = ?`, [mailboxId]) || null;
}

function getMailboxForUser(userId, mailboxId) {
    ensureTables();
    return getOne(
        `SELECT * FROM outlook_mailboxes WHERE id = ? AND user_id = ?`,
        [mailboxId, userId]
    ) || null;
}

/** @deprecated use listMailboxes — returns first mailbox for compat */
function getAccount(userId) {
    const list = listMailboxes(userId);
    return list[0] || null;
}

function listMailboxes(userId) {
    ensureTables();
    return getAll(
        `SELECT * FROM outlook_mailboxes WHERE user_id = ? ORDER BY id ASC`,
        [userId]
    );
}

function accountPublic(row) {
    if (!row) return null;
    return {
        id: row.id,
        mailbox_id: row.id,
        connected: !!(decryptedRefresh || row.access_token),
        email: row.email || null,
        display_name: row.display_name || null,
        connected_at: row.connected_at || null,
        last_sync_at: row.last_sync_at || null,
        last_error: row.last_error || null,
        expires_at: row.expires_at || null,
        subscription_id: row.subscription_id || null,
        subscription_expires_at: row.subscription_expires_at || null,
        push_enabled: !!(row.subscription_id && row.subscription_expires_at
            && new Date(row.subscription_expires_at).getTime() > Date.now())
    };
}

function listMailboxesPublic(userId) {
    return listMailboxes(userId).map(accountPublic);
}

function extractOtp(text) {
    const raw = String(text || '');
    if (!raw.trim()) return null;
    const patterns = [
        /(?:security\s*code|verification\s*code|one[-\s]?time(?:\s+pass(?:code|word))?|otp|code is|code:)\s*[:\-]?\s*([A-Za-z0-9]{4,12})/i,
        /\b(\d{6})\b/,
        /\b(\d{4,8})\b/,
        // Greenhouse sometimes sends mixed alphanumeric tokens
        /\b([A-Za-z][A-Za-z0-9]{3,11}|\d*[A-Za-z]\d+[A-Za-z0-9]*)\b/
    ];
    for (const re of patterns) {
        const m = raw.match(re);
        if (m?.[1] && !/^(http|https|gmail|outlook|code|security)$/i.test(m[1])) {
            return m[1];
        }
    }
    return null;
}

function htmlToText(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function upsertInboundMessage(userId, msg) {
    ensureTables();
    runQuery(
        `INSERT INTO outlook_messages (
            user_id, mailbox_id, graph_id, subject, from_address, from_name, received_at,
            body_preview, body_text, otp_code, is_read
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, graph_id) DO UPDATE SET
            mailbox_id = COALESCE(excluded.mailbox_id, outlook_messages.mailbox_id),
            subject = excluded.subject,
            body_preview = excluded.body_preview,
            body_text = excluded.body_text,
            otp_code = COALESCE(excluded.otp_code, outlook_messages.otp_code),
            is_read = excluded.is_read`,
        [
            userId,
            msg.mailbox_id || null,
            msg.graph_id,
            msg.subject || '',
            msg.from_address || '',
            msg.from_name || '',
            msg.received_at || null,
            msg.body_preview || '',
            (msg.body_text || '').slice(0, 20000),
            msg.otp_code || null,
            msg.is_read ? 1 : 0
        ]
    );
    return msg.otp_code || null;
}

async function tokenRequest(form) {
    const body = new URLSearchParams(form);
    if (clientSecret()) body.set('client_secret', clientSecret());
    const { data } = await axios.post(`${AUTH_HOST}/token`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        validateStatus: () => true
    });
    if (!data?.access_token) {
        throw new Error(String(data?.error_description || data?.error || 'token_failed'));
    }
    return data;
}

async function startDeviceCode() {
    if (!clientId()) {
        throw new Error('OUTLOOK_CLIENT_ID is not set — create an Azure app (personal accounts) first');
    }
    const body = new URLSearchParams({ client_id: clientId(), scope: SCOPES });
    const { data } = await axios.post(`${AUTH_HOST}/devicecode`, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000,
        validateStatus: () => true
    });
    if (!data?.device_code) {
        throw new Error(data?.error_description || data?.error || 'device_code_failed');
    }
    return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri || 'https://www.microsoft.com/devicelogin',
        verification_uri_complete: data.verification_uri_complete || null,
        expires_in: data.expires_in,
        interval: data.interval || 5,
        message: data.message
    };
}

/**
 * Completes device login and ADDS a mailbox (or refreshes if that email already linked).
 */
async function pollDeviceCode(userId, deviceCode, { maxWaitMs = 15 * 60 * 1000 } = {}) {
    ensureTables();
    const uid = parseInt(userId, 10);
    if (!uid) throw new Error('user_id required');
    const started = Date.now();
    let intervalSec = 5;
    while (Date.now() - started < maxWaitMs) {
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
        const body = new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: clientId(),
            device_code: deviceCode
        });
        if (clientSecret()) body.set('client_secret', clientSecret());
        const { data } = await axios.post(`${AUTH_HOST}/token`, body.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000,
            validateStatus: () => true
        });
        if (data?.access_token) {
            const mailbox = await saveTokensForNewOrExisting(uid, data);
            await refreshProfile(mailbox.id);
            const updated = getMailbox(mailbox.id);
            try {
                await ensureMailSubscription(mailbox.id);
            } catch (err) {
                console.warn('[outlook] subscription after connect:', err?.message || err);
            }
            if (POLL_ENABLED || graphPollActive()) ensureSyncLoop();
            return accountPublic(getMailbox(mailbox.id) || updated);
        }
        if (data?.error === 'authorization_pending') continue;
        if (data?.error === 'slow_down') {
            intervalSec += 2;
            continue;
        }
        if (data?.error === 'expired_token') throw new Error('Device code expired — start again');
        if (data?.error === 'authorization_declined') throw new Error('Authorization declined');
        throw new Error(data?.error_description || data?.error || 'device_poll_failed');
    }
    throw new Error('Timed out waiting for Outlook sign-in');
}

async function saveTokensForNewOrExisting(userId, tokenData) {
    ensureTables();
    const expiresAt = Date.now() + (Math.max(60, Number(tokenData.expires_in) || 3600) - 60) * 1000;
    const now = new Date().toISOString();
    // Peek profile with the new access token to learn email before insert
    const me = await axios.get(`${GRAPH}/me`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        params: { $select: 'displayName,mail,userPrincipalName' },
        timeout: 30000,
        validateStatus: () => true
    });
    const email = me.data?.mail || me.data?.userPrincipalName || `unknown-${Date.now()}@outlook.local`;
    const displayName = me.data?.displayName || null;

    const existing = getOne(
        `SELECT * FROM outlook_mailboxes WHERE user_id = ? AND lower(email) = lower(?)`,
        [userId, email]
    );
    if (existing) {
        runQuery(
            `UPDATE outlook_mailboxes SET
                access_token = ?, refresh_token = COALESCE(?, refresh_token),
                expires_at = ?, scope = ?, display_name = ?,
                updated_at = ?, last_error = NULL
             WHERE id = ?`,
            [
                encryptToken(tokenData.access_token),
                tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
                expiresAt,
                tokenData.scope || SCOPES,
                displayName,
                now,
                existing.id
            ]
        );
        return getMailbox(existing.id);
    }

    runQuery(
        `INSERT INTO outlook_mailboxes (
            user_id, email, display_name, access_token, refresh_token, expires_at, scope,
            connected_at, updated_at, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            userId,
            email,
            displayName,
            encryptToken(tokenData.access_token),
            tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
            expiresAt,
            tokenData.scope || SCOPES,
            now,
            now
        ]
    );
    return getOne(
        `SELECT * FROM outlook_mailboxes WHERE user_id = ? AND lower(email) = lower(?)`,
        [userId, email]
    );
}

async function saveTokens(mailboxId, tokenData) {
    ensureTables();
    const existing = getMailbox(mailboxId);
    if (!existing) throw new Error('mailbox not found');
    const expiresAt = Date.now() + (Math.max(60, Number(tokenData.expires_in) || 3600) - 60) * 1000;
    runQuery(
        `UPDATE outlook_mailboxes SET
            access_token = ?,
            refresh_token = COALESCE(?, refresh_token),
            expires_at = ?,
            scope = ?,
            updated_at = ?,
            last_error = NULL
         WHERE id = ?`,
        [
            encryptToken(tokenData.access_token),
            tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
            expiresAt,
            tokenData.scope || SCOPES,
            new Date().toISOString(),
            mailboxId
        ]
    );
}

async function getAccessToken(mailboxId) {
    const row = getMailbox(mailboxId);
    if (!row?.access_token && !row?.refresh_token) {
        throw new Error('Outlook Graph mailbox not connected');
    }
    // Decrypt tokens from DB (they are encrypted at rest)
    const decryptedAccess = decryptToken(row.access_token);
    const decryptedRefresh = decryptToken(row.refresh_token);
    if (decryptedAccess && row.expires_at && Date.now() < Number(row.expires_at) - 15_000) {
        return decryptedAccess;
    }
    if (!decryptedRefresh) throw new Error('Outlook session expired — reconnect this mailbox');
    const data = await tokenRequest({
        client_id: clientId(),
        grant_type: 'refresh_token',
        refresh_token: decryptToken(row.refresh_token),
        scope: SCOPES
    });
    await saveTokens(mailboxId, data);
    return data.access_token;
}

async function graphGet(mailboxId, path, params = {}) {
    const token = await getAccessToken(mailboxId);
    const { data, status } = await axios.get(`${GRAPH}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        params,
        timeout: 30000,
        validateStatus: () => true
    });
    if (status === 401) {
        const row = getMailbox(mailboxId);
        if (row?.refresh_token) {
            const tok = await tokenRequest({
                client_id: clientId(),
                grant_type: 'refresh_token',
                refresh_token: decryptToken(row.refresh_token),
                scope: SCOPES
            });
            await saveTokens(mailboxId, tok);
            const again = await axios.get(`${GRAPH}${path}`, {
                headers: { Authorization: `Bearer ${tok.access_token}` },
                params,
                timeout: 30000,
                validateStatus: () => true
            });
            if (again.status >= 400) {
                throw new Error(again.data?.error?.message || `graph_${again.status}`);
            }
            return again.data;
        }
    }
    if (status >= 400) {
        throw new Error(data?.error?.message || `graph_${status}`);
    }
    return data;
}

async function graphPost(mailboxId, path, body) {
    const token = await getAccessToken(mailboxId);
    const { data, status } = await axios.post(`${GRAPH}${path}`, body, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 30000,
        validateStatus: () => true
    });
    if (status >= 400) {
        throw new Error(data?.error?.message || `graph_post_${status}`);
    }
    return data;
}

async function graphDelete(mailboxId, path) {
    const token = await getAccessToken(mailboxId);
    const { status, data } = await axios.delete(`${GRAPH}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 30000,
        validateStatus: () => true
    });
    if (status >= 400 && status !== 404) {
        throw new Error(data?.error?.message || `graph_delete_${status}`);
    }
}

async function refreshProfile(mailboxId) {
    const me = await graphGet(mailboxId, '/me', {
        $select: 'displayName,mail,userPrincipalName'
    });
    const email = me.mail || me.userPrincipalName || null;
    runQuery(
        `UPDATE outlook_mailboxes SET email = ?, display_name = ?, updated_at = ? WHERE id = ?`,
        [email, me.displayName || null, new Date().toISOString(), mailboxId]
    );
    return { email, display_name: me.displayName || null };
}

function upsertMessage(userId, mailboxId, msg) {
    const from = msg.from?.emailAddress || {};
    const bodyText = msg.body?.contentType === 'html'
        ? htmlToText(msg.body?.content)
        : String(msg.body?.content || msg.bodyPreview || '');
    const otp = extractOtp(`${msg.subject || ''}\n${msg.bodyPreview || ''}\n${bodyText}`);
    return upsertInboundMessage(userId, {
        mailbox_id: mailboxId,
        graph_id: msg.id,
        subject: msg.subject || '',
        from_address: from.address || '',
        from_name: from.name || '',
        received_at: msg.receivedDateTime || null,
        body_preview: msg.bodyPreview || '',
        body_text: bodyText,
        otp_code: otp,
        is_read: msg.isRead ? 1 : 0
    });
}

async function syncInbox(mailboxIdOrUserId, maybeUserId) {
    // Compat: syncInbox(userId) syncs all; syncInbox(mailboxId) syncs one if row exists
    ensureTables();
    let mailbox = getMailbox(mailboxIdOrUserId);
    if (!mailbox && maybeUserId == null) {
        // treat as userId — sync all mailboxes
        return syncAllMailboxesForUser(mailboxIdOrUserId);
    }
    if (!mailbox) throw new Error('mailbox not found');
    const uid = mailbox.user_id;
    try {
        const data = await graphGet(mailbox.id, '/me/mailFolders/inbox/messages', {
            $top: MAX_SYNC,
            $orderby: 'receivedDateTime desc',
            $select: 'id,subject,from,receivedDateTime,bodyPreview,body,isRead'
        });
        const list = Array.isArray(data?.value) ? data.value : [];
        let otps = 0;
        for (const msg of list) {
            if (upsertMessage(uid, mailbox.id, msg)) otps += 1;
        }
        runQuery(
            `UPDATE outlook_mailboxes SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
            [new Date().toISOString(), new Date().toISOString(), mailbox.id]
        );
        return { ok: true, mailbox_id: mailbox.id, email: mailbox.email, synced: list.length, withOtp: otps };
    } catch (err) {
        const msg = err?.message || String(err);
        runQuery(
            `UPDATE outlook_mailboxes SET last_error = ?, updated_at = ? WHERE id = ?`,
            [msg.slice(0, 500), new Date().toISOString(), mailbox.id]
        );
        throw err;
    }
}

async function syncAllMailboxesForUser(userId) {
    const boxes = listMailboxes(userId);
    const results = [];
    for (const b of boxes) {
        try {
            results.push(await syncInbox(b.id));
        } catch (err) {
            results.push({ ok: false, mailbox_id: b.id, email: b.email, error: err.message });
        }
    }
    return { ok: true, mailboxes: results.length, results };
}

function listMessages(userId, { limit = 30 } = {}) {
    ensureTables();
    return getAll(
        `SELECT id, mailbox_id, graph_id, subject, from_address, from_name, received_at,
                body_preview, otp_code, is_read, created_at
         FROM outlook_messages
         WHERE user_id = ?
         ORDER BY received_at DESC, id DESC
         LIMIT ?`,
        [userId, Math.min(100, Math.max(1, Number(limit) || 30))]
    );
}

function findLatestOtp(userId, { afterIso = null, fromHint = null } = {}) {
    ensureTables();
    const params = [userId];
    let sql = `
      SELECT * FROM outlook_messages
      WHERE user_id = ? AND otp_code IS NOT NULL AND otp_code != ''
    `;
    if (afterIso) {
        sql += ` AND received_at >= ?`;
        params.push(afterIso);
    }
    if (fromHint) {
        sql += ` AND (lower(from_address) LIKE ? OR lower(subject) LIKE ? OR lower(body_preview) LIKE ?)`;
        const h = `%${String(fromHint).toLowerCase()}%`;
        params.push(h, h, h);
    }
    sql += ` ORDER BY received_at DESC, id DESC LIMIT 1`;
    return getOne(sql, params) || null;
}

async function waitForOtp(userId, {
    timeoutMs = 180_000,
    pollMs = 2000,
    afterIso = null,
    fromHint = 'greenhouse'
} = {}) {
    const started = Date.now();
    const after = afterIso || new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const interval = Math.max(1000, Number(pollMs) || 2000);
    let lastGmailSync = 0;
    let lastGraphSync = 0;

    while (Date.now() - started < timeoutMs) {
        // Microsoft Graph — preferred for Outlook/Hotmail OTPs
        if (ON_DEMAND_GRAPH && clientId() && Date.now() - lastGraphSync >= 5000) {
            lastGraphSync = Date.now();
            await syncAllMailboxesForUser(userId).catch(() => {});
        }
        // Free Gmail IMAP — pull periodically while waiting for OTP (not every tick)
        if (Date.now() - lastGmailSync >= 8000) {
            lastGmailSync = Date.now();
            try {
                const gmailImap = require('./gmailImapService');
                await gmailImap.syncAllForUser(userId);
            } catch (_) { /* optional */ }
        }
        const hit = findLatestOtp(userId, { afterIso: after, fromHint });
        if (hit?.otp_code) {
            return {
                ok: true,
                code: hit.otp_code,
                subject: hit.subject,
                from: hit.from_address,
                received_at: hit.received_at,
                mailbox_id: hit.mailbox_id,
                via: 'local'
            };
        }
        const any = findLatestOtp(userId, { afterIso: after, fromHint: null });
        if (any?.otp_code && /greenhouse|security code|verification|verify/i.test(
            `${any.subject || ''} ${any.from_address || ''} ${any.body_preview || ''}`
        )) {
            return {
                ok: true,
                code: any.otp_code,
                subject: any.subject,
                from: any.from_address,
                received_at: any.received_at,
                mailbox_id: any.mailbox_id,
                via: 'local'
            };
        }
        await new Promise((r) => setTimeout(r, interval));
    }
    return { ok: false, error: 'otp_timeout' };
}

async function disconnectMailbox(userId, mailboxId) {
    ensureTables();
    const row = getMailboxForUser(userId, mailboxId);
    if (!row) return { ok: false, error: 'not_found' };
    if (row.subscription_id) {
        await deleteMailSubscription(row.id).catch(() => {});
    }
    runQuery(`DELETE FROM outlook_messages WHERE user_id = ? AND mailbox_id = ?`, [userId, mailboxId]);
    runQuery(`DELETE FROM outlook_mailboxes WHERE id = ? AND user_id = ?`, [mailboxId, userId]);
    return { ok: true, mailbox_id: mailboxId };
}

function disconnect(userId) {
    ensureTables();
    const boxes = listMailboxes(userId);
    for (const b of boxes) {
        deleteMailSubscription(b.id).catch(() => {});
    }
    runQuery(`DELETE FROM outlook_messages WHERE user_id = ?`, [userId]);
    runQuery(`DELETE FROM outlook_mailboxes WHERE user_id = ?`, [userId]);
    try { runQuery(`DELETE FROM outlook_accounts WHERE user_id = ?`, [userId]); } catch (_) { /* ignore */ }
    return { ok: true };
}

async function ensureMailSubscription(mailboxId) {
    ensureTables();
    const existing = getMailbox(mailboxId);
    if (!existing) throw new Error('mailbox not found');
    if (!clientId()) throw new Error('OUTLOOK_CLIENT_ID not set');
    const notifyUrl = graphNotifyUrl();
    if (!hasPublicNotifyUrl()) {
        throw new Error('Graph push needs a public HTTPS URL — start cloudflared and set MAIL_WEBHOOK_PUBLIC_BASE (OTP still works via Graph sync without push)');
    }

    if (existing.subscription_id && existing.subscription_expires_at) {
        const exp = new Date(existing.subscription_expires_at).getTime();
        if (exp > Date.now() + 12 * 3600 * 1000) {
            return {
                subscription_id: existing.subscription_id,
                expires_at: existing.subscription_expires_at,
                notify_url: notifyUrl,
                mailbox_id: existing.id,
                email: existing.email,
                reused: true
            };
        }
        await deleteMailSubscription(existing.id).catch(() => {});
    }

    const clientState = existing.client_state || crypto.randomBytes(16).toString('hex');
    const expires = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
    const created = await graphPost(existing.id, '/subscriptions', {
        changeType: 'created',
        notificationUrl: notifyUrl,
        resource: "me/mailFolders('inbox')/messages",
        expirationDateTime: expires,
        clientState
    });

    runQuery(
        `UPDATE outlook_mailboxes
         SET subscription_id = ?, subscription_expires_at = ?, client_state = ?,
             last_error = NULL, updated_at = ?
         WHERE id = ?`,
        [created.id, created.expirationDateTime || expires, clientState, new Date().toISOString(), existing.id]
    );

    console.log(`[outlook] Graph push mailbox=${existing.id} ${existing.email} exp=${created.expirationDateTime || expires}`);
    return {
        subscription_id: created.id,
        expires_at: created.expirationDateTime || expires,
        notify_url: notifyUrl,
        mailbox_id: existing.id,
        email: existing.email,
        reused: false
    };
}

async function ensureAllSubscriptions(userId) {
    const results = [];
    for (const b of listMailboxes(userId)) {
        try {
            results.push(await ensureMailSubscription(b.id));
        } catch (err) {
            results.push({ ok: false, mailbox_id: b.id, email: b.email, error: err.message });
        }
    }
    return { results };
}

async function deleteMailSubscription(mailboxId) {
    const row = getMailbox(mailboxId);
    if (!row?.subscription_id) return { ok: true };
    try {
        await graphDelete(mailboxId, `/subscriptions/${row.subscription_id}`);
    } catch (_) { /* ignore */ }
    runQuery(
        `UPDATE outlook_mailboxes
         SET subscription_id = NULL, subscription_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
        [new Date().toISOString(), mailboxId]
    );
    return { ok: true };
}

async function fetchAndStoreMessage(mailboxId, messageId) {
    const box = getMailbox(mailboxId);
    if (!box) throw new Error('mailbox not found');
    const msg = await graphGet(mailboxId, `/me/messages/${encodeURIComponent(messageId)}`, {
        $select: 'id,subject,from,receivedDateTime,bodyPreview,body,isRead'
    });
    const otp = upsertMessage(box.user_id, mailboxId, msg);
    return { ok: true, graph_id: msg.id, subject: msg.subject, otp_code: otp, mailbox_id: mailboxId, email: box.email };
}

async function handleGraphNotifications(payload) {
    const items = Array.isArray(payload?.value) ? payload.value : [];
    const results = [];
    for (const n of items) {
        const row = getOne(
            `SELECT * FROM outlook_mailboxes WHERE subscription_id = ?`,
            [n.subscriptionId]
        );
        if (!row) {
            results.push({ ok: false, error: 'unknown_subscription', subscriptionId: n.subscriptionId });
            continue;
        }
        if (row.client_state && n.clientState && n.clientState !== row.client_state) {
            results.push({ ok: false, error: 'client_state_mismatch', mailbox_id: row.id });
            continue;
        }
        const messageId = n.resourceData?.id
            || (String(n.resource || '').match(/Messages\('([^']+)'\)/i) || [])[1]
            || (String(n.resource || '').match(/messages\/([^/]+)/i) || [])[1];
        if (!messageId) {
            try {
                await syncInbox(row.id);
                results.push({ ok: true, mailbox_id: row.id, via: 'sync_fallback' });
            } catch (err) {
                results.push({ ok: false, mailbox_id: row.id, error: err.message });
            }
            continue;
        }
        try {
            results.push(await fetchAndStoreMessage(row.id, messageId));
        } catch (err) {
            results.push({ ok: false, mailbox_id: row.id, error: err.message });
        }
    }
    return { handled: results.length, results };
}

function findUserBySubscription(subscriptionId) {
    ensureTables();
    return getOne(`SELECT * FROM outlook_mailboxes WHERE subscription_id = ?`, [subscriptionId]) || null;
}

function ensureSubscriptionRenewLoop() {
    if (renewTimer) return;
    renewTimer = setInterval(() => {
        renewExpiringSubscriptions().catch((err) => console.warn('[outlook] renew', err?.message || err));
    }, 6 * 60 * 60 * 1000);
    if (typeof renewTimer.unref === 'function') renewTimer.unref();
}

async function renewExpiringSubscriptions() {
    ensureTables();
    const rows = getAll(
        `SELECT id, subscription_expires_at FROM outlook_mailboxes
         WHERE subscription_id IS NOT NULL AND refresh_token IS NOT NULL`
    );
    const soon = Date.now() + 24 * 3600 * 1000;
    for (const r of rows) {
        const exp = r.subscription_expires_at ? new Date(r.subscription_expires_at).getTime() : 0;
        if (!exp || exp < soon) {
            try {
                await ensureMailSubscription(r.id);
            } catch (err) {
                console.warn('[outlook] renew mailbox', r.id, err?.message || err);
            }
        }
    }
}

async function syncAllConnected() {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
        ensureTables();
        const rows = getAll(`SELECT id FROM outlook_mailboxes WHERE refresh_token IS NOT NULL`);
        for (const r of rows) {
            try {
                await syncInbox(r.id);
            } catch (err) {
                console.warn('[outlook] sync mailbox', r.id, err?.message || err);
            }
        }
    } finally {
        syncInFlight = false;
    }
}

function ensureSyncLoop() {
    if (!graphPollActive()) return;
    if (syncTimer) return;
    if (!clientId()) return;
    syncTimer = setInterval(() => {
        syncAllConnected().catch((err) => console.warn('[outlook] sync loop', err?.message || err));
    }, SYNC_MS);
    if (typeof syncTimer.unref === 'function') syncTimer.unref();
}

function startOutlookMailService() {
    ensureTables();
    try {
        require('./mailForwardService').ensureTables();
    } catch (_) { /* ignore */ }
    ensureSubscriptionRenewLoop();
    if (graphPollActive()) {
        ensureSyncLoop();
        setTimeout(() => { syncAllConnected().catch(() => {}); }, 5000);
        console.log(
            POLL_ENABLED
                ? '[outlook] Graph poll enabled (OUTLOOK_POLL_ENABLED)'
                : '[outlook] Graph auto-poll (no public MAIL_WEBHOOK_PUBLIC_BASE — OTP via Graph sync)'
        );
    } else if (clientId()) {
        console.log('[outlook] receive mode = Graph push multi-mailbox');
    } else {
        console.log('[outlook] Graph idle — set OUTLOOK_CLIENT_ID to enable Outlook OTP');
    }
    setTimeout(() => { renewExpiringSubscriptions().catch(() => {}); }, 8000);
}

function stopOutlookMailService() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
    if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
    }
}

module.exports = {
    configStatus,
    getAccount,
    getMailbox,
    getMailboxForUser,
    listMailboxes,
    listMailboxesPublic,
    accountPublic,
    startDeviceCode,
    pollDeviceCode,
    refreshProfile,
    syncInbox,
    syncAllMailboxesForUser,
    listMessages,
    findLatestOtp,
    waitForOtp,
    disconnect,
    disconnectMailbox,
    extractOtp,
    htmlToText,
    upsertInboundMessage,
    ensureMailSubscription,
    ensureAllSubscriptions,
    deleteMailSubscription,
    handleGraphNotifications,
    findUserBySubscription,
    fetchAndStoreMessage,
    graphNotifyUrl,
    publicBase,
    startOutlookMailService,
    stopOutlookMailService,
    ensureSyncLoop,
    clientId
};






