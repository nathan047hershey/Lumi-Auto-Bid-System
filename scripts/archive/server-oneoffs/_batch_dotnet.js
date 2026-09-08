// =============================================================================
// _batch_dotnet.js
//
// End-to-end batch script for a list of .NET stack job links supplied by
// the admin. Walks each link through:
//   1. Insert into job_links with source_url + techstack='dotnet' + fetch_status='pending'
//   2. Trigger the LinkedIn / ATS scraper for that row
//   3. Poll until fetch_status flips to 'success' (description populated)
//      or 'failed' (skip after a timeout)
//   4. If success, kick the auto-apply cron — that scans for fetched rows,
//      scores profiles, and enqueues (profile, job_link) pairs onto the
//      RabbitMQ resume_generation queue. The single worker (prefetch=1)
//      picks them up one at a time.
//
// Run from /var/www/myapp/job-apply/server with the server running.
//
// Usage:
//   node _batch_dotnet.js
// =============================================================================
'use strict';

const path = require('path');
const {
    getDb, saveDatabase, runQuery, getOne, getAll
} = require('./config/database');
const resumeQueue = require('./services/resumeQueueService');
const jobMatchService = require('./services/jobMatchService');

const ADMIN_URL = process.env.BATCH_TARGET || 'http://localhost:8001';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';

// The .NET links the admin handed us. We pass them through verbatim so
// any future re-run uses the same canonical list. The order is roughly
// fastest-fetching first (Greenhouse, Workday, easyapply) and the slow
// LinkedIn-redirector last.
const LINKS = [
    {
        url: 'https://job-boards.greenhouse.io/topsteptrader/jobs/7824625003',
        company: 'Topstep',
        position: 'Software Engineer'
    },
    {
        url: 'https://recruiting.paylocity.com/Recruiting/Jobs/Apply/4235912/Digital-Consultants-LLC?source=LinkedIn_Feed',
        company: 'Digital Consultants LLC',
        position: 'Full Stack Engineer'
    },
    {
        url: 'https://job-boards.greenhouse.io/publicinput/jobs/4363686009?gh_src=5t8v5msn9us',
        company: 'PublicInput',
        position: 'Software Engineer'
    },
    {
        url: 'https://easyapply.co/a/6320865c-78f5-4f6f-8d35-c9bfbec58546?rcid=LinkedIn',
        company: null,
        position: null
    },
    {
        url: 'https://emcins.wd5.myworkdayjobs.com/en-US/EMC_Careers/job/Remote-in-US/Senior-Software-Engineer---EMC-Life_R6480?source=LinkedIn',
        company: 'EMC Insurance',
        position: 'Senior Software Engineer'
    },
    {
        url: 'https://careers.nlsnow.com/jobs/681614-senior-solutions-engineer?utm_source=LinkedIn',
        company: 'NLSNOW',
        position: 'Senior Solutions Engineer'
    },
    {
        url: 'https://careers.blizzard.com/global/en/job/BLENGLOBALR027589EXTERNALENGLOBAL/Senior-Software-Engineer-II-Web-Ecommerce-Battle-net-Austin-TX-Irvine-CA-Remote?utm_source=linkedin&utm_medium=phenom-feeds',
        company: 'Blizzard Entertainment',
        position: 'Senior Software Engineer II, Web Ecommerce (Battle.net)'
    },
    {
        url: 'https://www.adzuna.com/details/5837210905?v=99729CCFD0843247E7A11F24A1CDB15676C3D674&frd=abb4719b636c5ac8f61cdc005e0cf4a6&ccd=de68f0fddabce7e95b368363efafdd36&r=22381007&utm_source=linkedin6&utm_medium=organic&partnerb=1&chnlid=1098&title=Full%20Stack%20Software%20Engineer%20%E2%80%93%20.NET&a=e',
        company: null,
        position: 'Full Stack Software Engineer - .NET'
    },
    {
        url: 'https://dsp.prng.co/KxbJwWb?source=rd_linkedin_jobposting',
        company: null,
        position: null
    }
];

const SCRAPE_TIMEOUT_MS = 90 * 1000; // 90s per row
const SCRAPE_POLL_MS = 2000;

// -----------------------------------------------------------------------------
// Tiny HTTP client — keeps the script self-contained (no axios / node-fetch).
// -----------------------------------------------------------------------------
async function http(method, path, body, token) {
    const url = new URL(path, ADMIN_URL);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
}

async function login() {
    const { status, json } = await http('POST', '/auth/login', {
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD
    });
    if (status !== 200 || !json.token) {
        throw new Error(`login failed status=${status} body=${JSON.stringify(json)}`);
    }
    return json.token;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollScrapeResult(jobLinkId, token) {
    const start = Date.now();
    while (Date.now() - start < SCRAPE_TIMEOUT_MS) {
        await sleep(SCRAPE_POLL_MS);
        const { json } = await http('GET', `/job-links/${jobLinkId}`, null, token);
        const row = json.data || json;
        if (!row || !row.id) {
            throw new Error(`job_link ${jobLinkId} vanished`);
        }
        const descLen = (row.job_description || '').length;
        console.log(
            `    [poll] job_link=${jobLinkId} ` +
            `fetch_status=${row.fetch_status} desc_len=${descLen}`
        );
        if (row.fetch_status === 'success' && descLen > 100) {
            return row;
        }
        if (row.fetch_status === 'failed') {
            throw new Error(`scrape failed: ${row.fetch_error || 'unknown'}`);
        }
    }
    throw new Error(`scrape timeout after ${SCRAPE_TIMEOUT_MS}ms`);
}

async function main() {
    const token = await login();
    console.log(`[batch] logged in (token ${token.slice(0, 12)}…)`);

    // Pause the auto-apply cron while we build up the batch, then
    // run one big tick at the end. Otherwise the cron's natural
    // 5-min tick could process rows out of order or skip them
    // if our scrape is still in flight.
    console.log('[batch] ensuring database is loaded…');
    getDb();
    saveDatabase();

    const results = [];
    for (const link of LINKS) {
        console.log(`\n[batch] ─── ${link.company || 'unknown'} : ${link.url}`);

        // 1. INSERT — duplicate URLs collapse to the same row.
        const { status, json } = await http('POST', '/job-links', {
            techstack: 'dotnet',
            source_url: link.url,
            job_apply_url: link.url,
            company_name: link.company,
            position_title: link.position,
            location: link.company ? 'Remote' : null,
            is_available: true
        }, token);

        if (![200, 201].includes(status)) {
            // 409 = duplicate, treat as success-after-existing
            if (status === 409 && json.existing_id) {
                console.log(`    existing job_link id=${json.existing_id}`);
                results.push({ ok: 'duplicate', id: json.existing_id, url: link.url });
                continue;
            }
            console.error(`    POST /job-links failed status=${status}`, json);
            results.push({ ok: false, status, url: link.url, error: json.error || json });
            continue;
        }

        const row = (json.data || json);
        const jobLinkId = row.id;
        console.log(`    inserted id=${jobLinkId} fetch_status=${row.fetch_status}`);

        // 2. Trigger an on-demand scrape for this row. The admin
        // endpoint fires the same python-service provider the
        // cron uses, just synchronously-ish for one id.
        const scrapeRes = await http('POST', `/job-links/${jobLinkId}/scrape`, {}, token);
        console.log(`    scrape kicked: status=${scrapeRes.status}`);

        // 3. Poll until fetch_status flips to 'success' (with a
        // real description) or 'failed'.
        try {
            const fresh = await pollScrapeResult(jobLinkId, token);
            console.log(
                `    ✔ fetched: company=${fresh.company_name || '?'} ` +
                `position=${fresh.position_title || '?'} ` +
                `desc_len=${(fresh.job_description || '').length}`
            );
            results.push({ ok: true, id: jobLinkId, url: link.url, row: fresh });
        } catch (err) {
            console.error(`    ✘ ${err.message}`);
            results.push({ ok: false, id: jobLinkId, url: link.url, error: err.message });
        }
    }

    // 4. Fire one auto-apply tick. The cron will pick up every
    // fetched job_link without auto apps yet and enqueue
    // (profile, job_link) pairs onto the RabbitMQ
    // resume_generation queue.
    console.log('\n[batch] ─── triggering auto-apply tick');
    const trigger = await http('POST', '/admin/auto-apply/trigger', {}, token);
    const s = trigger.json.status || {};
    console.log(
        `[batch] tick status: queue=${s.queue && s.queue.queueDepth} ` +
        `processing=${s.queue && s.queue.processingCount} ` +
        `processedTotal=${s.queue && s.queue.processedTotal}`
    );

    // 5. Watch the queue for ~90s so we can see the worker drain
    // it. Each resume takes 20-60s.
    const start = Date.now();
    while (Date.now() - start < 120 * 1000) {
        await sleep(5000);
        const stat = await http('GET', '/admin/auto-apply/queue', null, token);
        const q = stat.json.queue || {};
        console.log(
            `[batch] queue: backlog=${q.queueDepth} ` +
            `processing=${q.processingCount} ` +
            `processed=${q.processedTotal} failed=${q.failedTotal}`
        );
        if (q.queueDepth === 0 && q.processingCount === 0) {
            console.log('[batch] queue drained — done');
            break;
        }
    }

    // 6. Report per-link outcome.
    console.log('\n[batch] ─── per-link outcome');
    const ok = results.filter((r) => r.ok === true).length;
    const dup = results.filter((r) => r.ok === 'duplicate').length;
    const fail = results.filter((r) => r.ok === false).length;
    console.log(`[batch] total=${results.length} ok=${ok} duplicate=${dup} failed=${fail}`);
    for (const r of results) {
        const idStr = r.id ? `id=${r.id}` : 'no-id';
        if (r.ok === true) {
            console.log(`  ✔ ${idStr} ${r.url}`);
        } else if (r.ok === 'duplicate') {
            console.log(`  ↻ ${idStr} (already in DB) ${r.url}`);
        } else {
            console.log(`  ✘ ${idStr} ${r.url} — ${r.error}`);
        }
    }

    // 7. Show the final job_applications summary so we can see
    // what got queued + processed.
    const apps = getAll(
        `SELECT ja.id, ja.job_link_id, jl.company_name, jl.position_title,
                ja.source, ja.generation_status,
                SUBSTR(ja.resume_filename, 1, 80) AS resume_filename
         FROM job_applications ja
         JOIN job_links jl ON jl.id = ja.job_link_id
         WHERE ja.source = 'auto' AND ja.created_at > datetime('now', '-1 hour')
         ORDER BY ja.id DESC`
    );
    console.log('\n[batch] recent auto applications:');
    if (apps.length === 0) {
        console.log('  (none)');
    } else {
        console.table(apps.map((a) => ({
            id: a.id,
            job_link: a.job_link_id,
            company: a.company_name,
            position: (a.position_title || '').slice(0, 40),
            status: a.generation_status,
            file: a.resume_filename
        })));
    }
}

main().catch((err) => {
    console.error('[batch] FATAL', err);
    process.exit(1);
});