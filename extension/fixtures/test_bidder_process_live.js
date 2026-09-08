'use strict';
/**
 * Live Process proof: Chromium + unpacked Lumi → Process OneTrust #5 →
 * bid course must show queue_started then form_detected | no_form | needs_captcha | blocked_ats.
 *
 * Requires API :9017 and client :5173.
 *   node extension/fixtures/test_bidder_process_live.js
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'extension');
const FRONT = process.env.FRONT_BASE || 'http://127.0.0.1:5173';
const API = process.env.API_BASE || 'http://127.0.0.1:9017';
const JOB_LINK_ID = 5;
const PROFILE_ID = 2;
const MARKER = `live_process_${Date.now()}`;

async function api(method, urlPath, body, token) {
    const res = await fetch(`${API}${urlPath}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    return { status: res.status, json };
}

function postMessageCommand(page, type, extra = {}, timeoutMs = 25000) {
    return page.evaluate(
        ({ type, extra, timeoutMs }) =>
            new Promise((resolve) => {
                const requestId = `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const timer = setTimeout(
                    () => resolve({ ok: false, error: 'timeout', requestId }),
                    timeoutMs
                );
                const onMsg = (event) => {
                    if (event.source !== window) return;
                    if (event.data?.type !== 'JOB_APPLY_BIDDER_EXTENSION_REPLY') return;
                    if (event.data?.requestId !== requestId) return;
                    clearTimeout(timer);
                    window.removeEventListener('message', onMsg);
                    resolve(event.data);
                };
                window.addEventListener('message', onMsg);
                window.postMessage({ type, requestId, ...extra }, '*');
            }),
        { type, extra, timeoutMs }
    );
}

async function courseEvents(token, courseId) {
    // Prefer admin detail (sees any owner's course); fall back to user detail.
    let detail = await api('GET', `/admin/bid-courses/${courseId}`, null, token);
    if (detail.status === 404 || detail.status === 403) {
        detail = await api('GET', `/user/bid-courses/${courseId}`, null, token);
    }
    if (detail.status !== 200) {
        console.warn('course detail', detail.status, detail.json);
        return [];
    }
    return detail.json?.events || [];
}

async function waitForTimeline(token, applicationId, courseId, { afterEventId = 0, timeoutMs = 180000 } = {}) {
    const formOk = new Set([
        'form_detected',
        'no_form',
        'needs_captcha',
        'login_wall',
        'blocked_ats',
        'open_failed'
    ]);
    const fillOk = new Set([
        'fill_done',
        'fill_failed',
        'awaiting_manual_submit',
        'ready_to_submit',
        'needs_manual',
        'ai_failed',
        'package_saved'
    ]);
    const started = Date.now();
    let lastTypes = [];
    let sawForm = null;
    while (Date.now() - started < timeoutMs) {
        const events = await courseEvents(token, courseId);
        const fresh = events.filter((e) => Number(e.id) > Number(afterEventId));
        lastTypes = fresh.map((e) => e.event_type);
        if (!sawForm) {
            sawForm = lastTypes.find((t) => formOk.has(t)) || null;
        }
        // Terminal ATS/open failures count as done without fill.
        if (sawForm && ['no_form', 'needs_captcha', 'login_wall', 'blocked_ats', 'open_failed'].includes(sawForm)) {
            return { ok: true, types: lastTypes, outcome: sawForm, allTypes: events.map((e) => e.event_type) };
        }
        const fillOutcome = lastTypes.find((t) => fillOk.has(t));
        if (sawForm === 'form_detected' && fillOutcome) {
            return {
                ok: true,
                types: lastTypes,
                outcome: fillOutcome,
                form: sawForm,
                allTypes: events.map((e) => e.event_type)
            };
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, types: lastTypes, outcome: sawForm || null };
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    assert.ok(manifest.version === '1.8.11' || /^1\.8\.(1[1-9]|\d{2,})$/.test(manifest.version)
        || (() => {
            const p = String(manifest.version).split('.').map((n) => parseInt(n, 10) || 0);
            return p[0] > 1 || (p[0] === 1 && p[1] > 8) || (p[0] === 1 && p[1] === 8 && p[2] >= 11);
        })(), `need Lumi >= 1.8.11, got ${manifest.version}`);

    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        console.error('FAIL need playwright');
        process.exit(1);
    }

    const login = await api('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(login.status, 200, 'admin login');
    const token = login.json.token;
    assert.ok(token, 'token');

    const ready = await api(
        'GET',
        `/user/bidder/ready?profile_id=${PROFILE_ID}&job_link_ids=${JOB_LINK_ID}`,
        null,
        token
    );
    assert.ok(ready.json?.items?.length >= 1, 'OneTrust ready missing for admin');
    const app = ready.json.items[0];
    assert.equal(Number(app.job_link_id), JOB_LINK_ID);

    // Mark timeline so we can find this run
    const enq = await api(
        'POST',
        '/user/bid-courses/event',
        {
            application_id: app.id,
            event_type: 'queue_enqueued',
            company_name: app.company_name,
            job_role: app.job_role,
            job_url: app.open_url || app.job_url,
            meta: { source: 'test_bidder_process_live', marker: MARKER }
        },
        token
    );
    assert.equal(enq.status, 200, 'queue_enqueued');
    const courseId = enq.json?.course?.id;
    assert.ok(courseId, 'course id');
    const beforeEvents = await courseEvents(token, courseId);
    const afterEventId = beforeEvents.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    console.log('course', courseId, 'afterEventId', afterEventId);

    // Keep Chromium profiles under .tmp/ (gitignored) — never litter repo root.
    const tmpRoot = path.join(ROOT, '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const userData = path.join(tmpRoot, `lumi-process-profile-${Date.now()}`);
    fs.mkdirSync(userData, { recursive: true });

    const context = await chromium.launchPersistentContext(userData, {
        headless: false,
        args: [
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`,
            '--no-first-run',
            '--no-default-browser-check'
        ]
    });

    try {
        // Wait for extension SW
        for (let i = 0; i < 30; i++) {
            const sw = context.serviceWorkers()[0]
                || (await context.waitForEvent('serviceworker', { timeout: 1500 }).catch(() => null));
            if (sw) break;
            await new Promise((r) => setTimeout(r, 200));
        }

        const page = await context.newPage();
        await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(({ token: t, user }) => {
            localStorage.setItem('token', t);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token, user: login.json.user });

        await page.goto(`${FRONT}/admin/job-links`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        // Ensure bridge is bound (Connect path)
        const bridge = await page.evaluate(() => ({
            version: window.__LUMI_BRIDGE_VERSION__ || null,
            bound: !!window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__
        }));
        console.log('bridge', bridge);

        const ping = await postMessageCommand(page, 'JOB_APPLY_BIDDER_PING', {}, 8000);
        console.log('ping', { ok: ping.ok, version: ping.version, error: ping.error });
        assert.ok(ping.ok, `PING failed: ${ping.error || JSON.stringify(ping)}`);
        assert.ok(ping.version, 'PING version');

        // Clear any leftover queue lock from a prior crash/run.
        await postMessageCommand(page, 'JOB_APPLY_BIDDER_STOP', {}, 5000);

        const processReply = await postMessageCommand(
            page,
            'JOB_APPLY_BIDDER_PROCESS_QUEUE',
            {
                jobLinkIds: [JOB_LINK_ID],
                applicationIds: [app.id],
                token,
                user: login.json.user,
                selectedProfileId: PROFILE_ID
            },
            30000
        );
        console.log('process reply', {
            ok: processReply.ok,
            started: processReply.started,
            queued: processReply.queued,
            error: processReply.error,
            processed: processReply.processed
        });

        assert.ok(
            processReply.ok !== false || Number(processReply.queued) > 0 || processReply.started,
            `Process failed empty: ${JSON.stringify(processReply)}`
        );
        assert.ok(
            Number(processReply.queued) >= 1 || processReply.started === true,
            `expected queued≥1, got ${JSON.stringify(processReply)}`
        );

        const timeline = await waitForTimeline(token, app.id, courseId, {
            afterEventId,
            timeoutMs: 180000
        });
        console.log('timeline', timeline);
        assert.ok(timeline.ok, `timeline incomplete; saw ${timeline.types.join(',')}`);
        assert.ok(timeline.types.includes('queue_started'), `missing fresh queue_started; saw ${timeline.types.join(',')}`);
        assert.ok(
            timeline.outcome,
            `missing form/fill outcome; saw ${timeline.types.join(',')}`
        );

        console.log('PASS live Process OneTrust', {
            manifest: manifest.version,
            applicationId: app.id,
            courseId,
            queued: processReply.queued,
            outcome: timeline.outcome,
            types: timeline.types
        });
    } finally {
        await context.close().catch(() => {});
        // Best-effort cleanup so the tree stays clean.
        try {
            fs.rmSync(userData, { recursive: true, force: true });
        } catch (_) { /* locked on Windows sometimes */ }
    }
}

main().catch((err) => {
    console.error('FAIL', err.message || err);
    process.exit(1);
});
