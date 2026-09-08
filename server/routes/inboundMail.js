'use strict';
/**
 * Public inbound-mail webhook (no JWT).
 * Secured by per-user forward token in query/header/body.
 *
 * POST /api/hooks/inbound-mail?token=...
 * Compatible with Power Automate, Zapier, Make, Mailgun, SendGrid, generic JSON.
 */

const express = require('express');
const mailForward = require('../services/mailForwardService');

const router = express.Router();

function extractToken(req) {
    const h = req.headers.authorization || '';
    const bearer = /^Bearer\s+(.+)$/i.exec(h)?.[1];
    return String(
        req.query.token
        || req.headers['x-mail-forward-token']
        || bearer
        || req.body?.token
        || ''
    ).trim();
}

router.get('/inbound-mail', (req, res) => {
    res.json({
        ok: true,
        hint: 'POST JSON { subject, text, from } with ?token= your forward token',
        mode: 'forward'
    });
});

router.post('/inbound-mail', (req, res) => {
    try {
        const token = extractToken(req);
        if (!token) {
            return res.status(401).json({ error: 'token required (?token= or Authorization: Bearer)' });
        }
        const payload = mailForward.normalizeInboundPayload(req);
        const result = mailForward.ingestForwardedMail(token, payload);
        res.json(result);
    } catch (err) {
        const status = err.status || (/invalid_forward_token/i.test(err.message) ? 401 : 400);
        if (status >= 500) console.error('inbound-mail error:', err);
        res.status(status).json({ error: err.message || 'ingest failed' });
    }
});

/**
 * Microsoft Graph change notifications (mail created).
 * Validation: GET/POST ?validationToken=... must echo plain text.
 */
router.all('/graph-mail', async (req, res) => {
    const validation = req.query.validationToken || req.query.validationtoken;
    if (validation) {
        res.set('Content-Type', 'text/plain');
        return res.status(200).send(String(validation));
    }
    try {
        const outlookMail = require('../services/outlookMailService');
        // Respond 202 quickly; process async so Graph does not retry
        res.status(202).json({ accepted: true });
        const body = req.body || {};
        setImmediate(() => {
            outlookMail.handleGraphNotifications(body).catch((err) => {
                console.warn('[graph-mail] notify', err?.message || err);
            });
        });
    } catch (err) {
        console.error('graph-mail error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message || 'graph-mail failed' });
    }
});

module.exports = router;
