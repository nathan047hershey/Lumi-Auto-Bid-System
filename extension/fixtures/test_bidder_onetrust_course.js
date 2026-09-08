'use strict';
/**
 * Goal steps 2–3 (API side): OneTrust #5 ready + bid-course event visibility.
 * Run: node extension/fixtures/test_bidder_onetrust_course.js
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

async function api(token, path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, {
        ...opts,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {})
        }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${path} ${res.status}`);
    return data;
}

(async () => {
    const bob = await login('bob', 'bob123');
    const ready = await api(bob.token, '/user/bidder/ready?limit=5&job_link_ids=5&profile_id=2');
    assert.ok(ready.items.length >= 1, 'OneTrust ready for profile 2');
    const item = ready.items[0];
    assert.equal(Number(item.job_link_id), 5);
    assert.ok(/greenhouse\.io/i.test(item.open_url || item.job_url));

    const ev = await api(bob.token, '/user/bid-courses/event', {
        method: 'POST',
        body: JSON.stringify({
            application_id: item.id,
            event_type: 'queue_enqueued',
            company_name: item.company_name,
            job_role: item.job_role,
            job_url: item.open_url || item.job_url,
            meta: { source: 'test_bidder_onetrust_course', profile_id: 2, job_link_id: 5 }
        })
    });
    assert.ok(ev.course?.id, 'course created');
    assert.match(String(ev.course.company_name), /OneTrust/i);

    const detail = await api(bob.token, `/user/bid-courses/${ev.course.id}`);
    const types = (detail.events || []).map((e) => e.event_type);
    assert.ok(types.includes('queue_enqueued'), 'timeline has queue_enqueued');

    console.log('PASS OneTrust course path', {
        appId: item.id,
        courseId: ev.course.id,
        lastEvents: types.slice(-3)
    });
})().catch((err) => {
    console.error('FAIL', err.message || err);
    process.exit(1);
});
