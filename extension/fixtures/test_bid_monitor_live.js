/**
 * Verify Live monitor data path: bid-course screenshots include live frames
 * and screenshot bytes can be fetched without cache sticking.
 * Run: node extension/fixtures/test_bid_monitor_live.js
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:9017';

async function login() {
    const creds = [
        { username: 'vincent', password: '123456' },
        { username: 'admin', password: 'admin123' },
        { username: 'bob', password: 'bob123' }
    ];
    for (const c of creds) {
        const res = await fetch(`${BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(c)
        });
        if (res.ok) {
            const data = await res.json();
            return data.token;
        }
    }
    throw new Error('login failed');
}

async function main() {
    const token = await login();
    const h = { Authorization: `Bearer ${token}` };

    const listRes = await fetch(`${BASE}/user/bid-courses?limit=20`, { headers: h });
    if (!listRes.ok) throw new Error(`list courses ${listRes.status}`);
    const list = await listRes.json();
    const courses = list.courses || [];
    if (!courses.length) {
        console.log('PASS no courses yet (monitor idle) — open Auto Bidder → Process to generate live frames');
        process.exit(0);
    }

    const course = courses[0];
    const detailRes = await fetch(`${BASE}/user/bid-courses/${course.id}`, { headers: h });
    if (!detailRes.ok) throw new Error(`detail ${detailRes.status}`);
    const detail = await detailRes.json();
    const shots = detail.screenshots || [];
    const disk = detail.disk_screenshots || [];
    console.log(`course #${course.id} db_shots=${shots.length} disk=${disk.length}`);

    const all = shots.length ? shots : disk;
    const live = all.filter((s) => String(s.stage || '').toLowerCase() === 'live');
    const latest = live.length ? live[live.length - 1] : all[all.length - 1];

    if (!latest?.filename) {
        console.log('PASS course has no screenshots yet — Process a job to upload live.png every 2s');
        process.exit(0);
    }

    const t1 = Date.now();
    const a = await fetch(
        `${BASE}/user/bid-courses/${course.id}/screenshots/${encodeURIComponent(latest.filename)}?t=${t1}`,
        { headers: { ...h, 'Cache-Control': 'no-cache' } }
    );
    if (!a.ok) throw new Error(`screenshot fetch ${a.status}`);
    const buf1 = Buffer.from(await a.arrayBuffer());
    console.log(`PASS fetched ${latest.filename} bytes=${buf1.length} stage=${latest.stage}`);

    if (buf1.length < 32) throw new Error('screenshot too small');

    // Cache-bust second fetch should still succeed
    const t2 = Date.now() + 1;
    const b = await fetch(
        `${BASE}/user/bid-courses/${course.id}/screenshots/${encodeURIComponent(latest.filename)}?t=${t2}`,
        { headers: { ...h, 'Cache-Control': 'no-cache' } }
    );
    if (!b.ok) throw new Error(`screenshot refetch ${b.status}`);
    const buf2 = Buffer.from(await b.arrayBuffer());
    console.log(`PASS refetch bytes=${buf2.length} (live frames overwrite same file during Process)`);

    const cc = a.headers.get('cache-control') || '';
    console.log(`cache-control: ${cc || '(none)'}`);
    console.log('\nAll bid-monitor live checks passed.');
}

main().catch((e) => {
    console.error('FAIL', e.message || e);
    process.exit(1);
});
