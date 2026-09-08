'use strict';
/**
 * Live bridge test: launch Chromium with unpacked Lumi, open Job Links,
 * confirm app-bridge announces v1.8.8+ and PING returns the version.
 *
 * Run from repo root (needs client on :5173):
 *   node extension/fixtures/test_bidder_bridge_live.js
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'extension');
const FRONT = process.env.FRONT_BASE || 'http://127.0.0.1:5173';
const API = process.env.API_BASE || 'http://127.0.0.1:9017';

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    assert.ok(
        String(manifest.version).split('.').map(Number).reduce((a, b, i) => a || (b - [1, 8, 8][i] || 0), 0) >= 0
            || manifest.version === '1.8.8'
            || Number(manifest.version.replace(/\./g, '')) >= 188,
        `manifest must be 1.8.8+, got ${manifest.version}`
    );
    // Semver compare
    const parts = String(manifest.version).split('.').map((n) => parseInt(n, 10) || 0);
    const min = [1, 8, 8];
    let okVer = true;
    for (let i = 0; i < 3; i++) {
        if ((parts[i] || 0) > min[i]) break;
        if ((parts[i] || 0) < min[i]) {
            okVer = false;
            break;
        }
    }
    assert.ok(okVer, `need Lumi >= 1.8.8, got ${manifest.version}`);

    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch {
        try {
            ({ chromium } = require('patchright'));
        } catch {
            console.error('FAIL need playwright or patchright installed');
            process.exit(1);
        }
    }

    // Keep Chromium profiles under .tmp/ (gitignored) — never litter repo root.
    const tmpRoot = path.join(ROOT, '.tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const userData = path.join(tmpRoot, 'lumi-bridge-profile');
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
        // Wait for service worker / extension id
        let extId = null;
        for (let i = 0; i < 40; i++) {
            const sw = context.serviceWorkers()[0]
                || (await context.waitForEvent('serviceworker', { timeout: 2000 }).catch(() => null));
            if (sw) {
                const u = sw.url();
                const m = u.match(/chrome-extension:\/\/([a-p]+)\//);
                if (m) {
                    extId = m[1];
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        if (!extId) {
            // Fallback: background page from older APIs
            const bgs = context.backgroundPages?.() || [];
            for (const bg of bgs) {
                const m = bg.url().match(/chrome-extension:\/\/([a-p]+)\//);
                if (m) extId = m[1];
            }
        }
        console.log('extensionId', extId || '(unknown — MV3 SW may still work via content scripts)');

        const page = await context.newPage();
        // Login via API then inject token (faster than UI login)
        const loginRes = await fetch(`${API}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'bob', password: 'bob123' })
        });
        const login = await loginRes.json();
        if (!login.token) throw new Error('login failed: ' + JSON.stringify(login));

        await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(({ token, user }) => {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }, { token: login.token, user: login.user });

        await page.goto(`${FRONT}/admin/job-links`, { waitUntil: 'networkidle' });
        // Give content script time to inject
        await page.waitForTimeout(1500);

        const bridge = await page.evaluate(() => ({
            version: window.__LUMI_BRIDGE_VERSION__ || null,
            bound: !!window.__JOB_APPLY_BIDDER_APP_BRIDGE_BOUND__,
            gen: window.__JOB_APPLY_BIDDER_APP_BRIDGE_VERSION__ || null
        }));
        console.log('bridge window flags', bridge);

        // Ping via postMessage protocol
        const ping = await page.evaluate(() => new Promise((resolve) => {
            const requestId = `ping_${Date.now()}`;
            const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 5000);
            const onMsg = (event) => {
                if (event.source !== window) return;
                if (event.data?.type !== 'JOB_APPLY_BIDDER_EXTENSION_REPLY') return;
                if (event.data?.requestId !== requestId) return;
                clearTimeout(timer);
                window.removeEventListener('message', onMsg);
                resolve(event.data);
            };
            window.addEventListener('message', onMsg);
            window.postMessage({ type: 'JOB_APPLY_BIDDER_PING', requestId }, '*');
        }));
        console.log('ping reply', ping);

        assert.ok(ping.ok, `PING failed: ${ping.error || JSON.stringify(ping)}`);
        assert.ok(ping.version, 'PING must return version');
        const p = String(ping.version).split('.').map((n) => parseInt(n, 10) || 0);
        assert.ok(
            p[0] > 1 || (p[0] === 1 && p[1] > 8) || (p[0] === 1 && p[1] === 8 && p[2] >= 8),
            `PING version ${ping.version} < 1.8.8`
        );

        // Ready queue still good
        const readyRes = await fetch(
            `${API}/user/bidder/ready?limit=5&job_link_ids=5&profile_id=2`,
            { headers: { Authorization: `Bearer ${login.token}` } }
        );
        const ready = await readyRes.json();
        assert.ok(ready.items?.length >= 1, 'OneTrust ready missing');

        console.log('PASS live Lumi bridge', {
            manifest: manifest.version,
            pingVersion: ping.version,
            readyApp: ready.items[0].id,
            company: ready.items[0].company_name
        });
    } finally {
        await context.close().catch(() => {});
        try {
            fs.rmSync(userData, { recursive: true, force: true });
        } catch (_) { /* locked on Windows sometimes */ }
    }
}

main().catch((err) => {
    console.error('FAIL', err.message || err);
    process.exit(1);
});
