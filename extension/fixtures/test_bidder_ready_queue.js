'use strict';
/**
 * Regression: selected Job Link ready queue returns Greenhouse app for bob
 * and for admin (admins may bid any profile). Verifies OneTrust URL is Greenhouse.
 *
 * Run: node extension/fixtures/test_bidder_ready_queue.js
 */
const assert = require('assert');

const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';

async function login(username, password) {
    const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `login ${res.status}`);
    return data;
}

async function ready(token, query) {
    const q = new URLSearchParams(query);
    const res = await fetch(`${BASE}/user/bidder/ready?${q}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `ready ${res.status}`);
    return data;
}

(async () => {
    const bob = await login('bob', 'bob123');
    const admin = await login('admin', 'admin123');

    const bobReady = await ready(bob.token, { limit: '50', job_link_ids: '5' });
    assert.ok(bobReady.items.length >= 1, 'bob must see ready CV for job link #5');
    const item = bobReady.items[0];
    assert.equal(Number(item.job_link_id), 5, 'job_link_id must be 5');
    assert.ok(/greenhouse\.io/i.test(item.open_url || item.job_url), 'OneTrust must be Greenhouse URL');
    assert.ok(item.resume_filename, 'resume_filename required');
    assert.equal(item.generation_status, 'ready');

    const adminReady = await ready(admin.token, { limit: '50', job_link_ids: '5', profile_id: '2' });
    assert.ok(adminReady.items.length >= 1, 'admin must see ready CV for profile 2 + job link #5');
    assert.equal(adminReady.filter?.admin, true, 'ready filter.admin flag for admin');

    // Simulate extension bug: profile filter hides ready when popup profile is wrong.
    const wrongProfile = await ready(bob.token, {
        limit: '50',
        job_link_ids: '5',
        profile_id: '99999'
    });
    assert.equal(wrongProfile.items.length, 0, 'unknown profile_id must return empty');

    const noProfileFilter = await ready(bob.token, { limit: '50', job_link_ids: '5' });
    assert.ok(noProfileFilter.items.length >= 1, 'job_link_ids without profile_id must still return items');

    // Session sync contract: Process payload must carry page token + application ids.
    const processPayload = {
        type: 'JOB_APPLY_BIDDER_PROCESS_QUEUE',
        jobLinkIds: [5],
        applicationIds: bobReady.items.map((r) => r.id),
        token: bob.token,
        user: bob.user,
        selectedProfileId: item.profile_id
    };
    assert.ok(processPayload.token, 'page token required');
    assert.ok(processPayload.applicationIds.includes(item.id), 'applicationIds must include ready app');
    assert.ok(Number(processPayload.selectedProfileId) > 0, 'selectedProfileId from ready app');

    console.log('PASS bidder ready queue for OneTrust #5', {
        bobCount: bobReady.items.length,
        appId: item.id,
        url: item.open_url || item.job_url
    });
})().catch((err) => {
    console.error('FAIL', err.message || err);
    process.exit(1);
});
