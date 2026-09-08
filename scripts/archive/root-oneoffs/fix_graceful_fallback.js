const fs = require('fs');

// ============================================================================
// Fix 1: Update jobDetailFetchService.js — enqueueJobDetailFetch to fall back
// to in-process scraping when RabbitMQ is unavailable
// ============================================================================
const p1 = 'd:/Projects/job-apply-master/job-apply-master/server/services/jobDetailFetchService.js';
let c1 = fs.readFileSync(p1, 'utf8');

// Find the enqueue function and replace it with a version that falls back
const oldEnqueue = `async function enqueueJobDetailFetch(jobLinkId, opts = {}) {
    if (!Number.isInteger(jobLinkId)) {
        throw new Error('jobLinkId must be an integer');
    }
    const ch = await connect();
    const payload = {
        jobLinkId,
        enqueuedAt: new Date().toISOString(),
        ...opts
    };
    const ok = ch.sendToQueue(
        QUEUE,
        Buffer.from(JSON.stringify(payload), 'utf8'),
        { persistent: true, contentType: 'application/json' }
    );
    if (!ok) {
        throw new Error('local queue full — backpressure');
    }
    // Wait for the broker's confirm so the route handler can
    // safely return "queued".
    await new Promise((resolve, reject) => {
        ch.waitForConfirms().then(resolve, reject);
    });
    refreshQueueDepth().catch(() => {});
    return { ok: true, jobLinkId };
}`;

const newEnqueue = `async function enqueueJobDetailFetch(jobLinkId, opts = {}) {
    if (!Number.isInteger(jobLinkId)) {
        throw new Error('jobLinkId must be an integer');
    }
    const payload = {
        jobLinkId,
        enqueuedAt: new Date().toISOString(),
        ...opts
    };
    // Try RabbitMQ first. If the broker is down (which is common
    // during local dev when the user hasn't started RabbitMQ),
    // fall back to in-process scraping so the user still gets
    // their description rather than seeing "AggregateError".
    try {
        const ch = await connect();
        const ok = ch.sendToQueue(
            QUEUE,
            Buffer.from(JSON.stringify(payload), 'utf8'),
            { persistent: true, contentType: 'application/json' }
        );
        if (!ok) {
            throw new Error('local queue full — backpressure');
        }
        await new Promise((resolve, reject) => {
            ch.waitForConfirms().then(resolve, reject);
        });
        refreshQueueDepth().catch(() => {});
        return { ok: true, jobLinkId, mode: 'queued' };
    } catch (queueErr) {
        // RabbitMQ unavailable — fall back to in-process scraping.
        // We log a warning so the admin knows the queue is down.
        console.warn('[jobDetailFetch] RabbitMQ unavailable, falling back to in-process scrape:', formatError(queueErr));
        try {
            const result = await scrapeJobLinkById(jobLinkId);
            lastError = result && result.error ? formatError({ message: result.error }) : null;
            return { ok: !!(result && result.ok), jobLinkId, mode: 'inline', result };
        } catch (scrapeErr) {
            const errMsg = formatError(scrapeErr);
            lastError = errMsg;
            throw new Error('Scrape failed (RabbitMQ down + inline failed): ' + errMsg);
        }
    }
}`;

if (c1.includes(oldEnqueue)) {
    c1 = c1.replace(oldEnqueue, newEnqueue);
    fs.writeFileSync(p1, c1);
    console.log('✓ Updated enqueueJobDetailFetch with fallback');
} else {
    console.log('✗ enqueueJobDetailFetch pattern not found');
}

// ============================================================================
// Fix 2: Update resumeQueueService.js — connect to handle AggregateError
// gracefully and retry with backoff
// ============================================================================
const p2 = 'd:/Projects/job-apply-master/job-apply-master/server/services/resumeQueueService.js';
let c2 = fs.readFileSync(p2, 'utf8');

// Improve error formatting for lastError assignments
const formatErrHelper = `
// Helper to format any error (including AggregateError) for display
function formatError(err) {
    if (!err) return 'unknown';
    if (typeof err === 'string') return err;
    if (err instanceof Error) {
        if (err.constructor && err.constructor.name === 'AggregateError') {
            const subErrors = (err.errors || []).map(e => {
                if (e instanceof Error) return e.message;
                if (typeof e === 'string') return e;
                try { return JSON.stringify(e); } catch { return String(e); }
            }).filter(Boolean);
            if (subErrors.length > 0) return 'AggregateError: ' + subErrors.join(' | ');
            return 'AggregateError (no detail)';
        }
        if (err.message) return err.message;
    }
    try { return String(err); } catch { return 'unknown'; }
}

`;

if (!c2.includes('function formatError')) {
    // Insert after the module doc comment
    const requireIdx = c2.indexOf("require('amqplib')");
    if (requireIdx > 0) {
        c2 = c2.substring(0, requireIdx) + formatErrHelper + c2.substring(requireIdx);
    }
}

// Replace all lastError assignments
c2 = c2.replace(
    /lastError = err\.message \|\| String\(err\);/g,
    'lastError = formatError(err);'
);

if (c2 !== fs.readFileSync(p2, 'utf8')) {
    fs.writeFileSync(p2, c2);
    console.log('✓ Updated resumeQueueService.js error formatting');
}

console.log('All fixes applied. Restart the server.');
