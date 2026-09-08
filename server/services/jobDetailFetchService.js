// =============================================================================
// services/jobDetailFetchService.js — RabbitMQ worker for job-detail fetching
// =============================================================================
'use strict';

function formatError(err) {
    if (err && typeof err === 'object') {
        if (err.constructor && err.constructor.name === 'AggregateError') {
            return 'AggregateError: ' + (err.errors || []).map((e) => {
                if (e instanceof Error) return e.message;
                return String(e);
            }).join('; ');
        }
        if (err instanceof Error) return err.message;
    }
    return String(err);
}

const amqp = require('amqplib');
const {
    scrapeJobLinkById,
    cleanupStaleFetching,
    listDueJobLinkIds
} = require('./jobLinkScraper');

const AMQP_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
const QUEUE = process.env.JOB_DETAIL_FETCH_QUEUE || 'job_detail_fetch';
const PREFETCH = parseInt(process.env.JOB_DETAIL_FETCH_PREFETCH || 1, 10);
const RETRY_POLL_MS = parseInt(process.env.JOB_DETAIL_RETRY_POLL_MS || 30000, 10);
const RECONNECT_MS = parseInt(process.env.JOB_DETAIL_RECONNECT_MS || 60000, 10);
const LOG_COOLDOWN_MS = Math.max(30000, parseInt(process.env.RABBITMQ_LOG_COOLDOWN_MS || 120000, 10) || 120000);
const CIRCUIT_MS = Math.max(15000, parseInt(process.env.RABBITMQ_CIRCUIT_MS || 60000, 10) || 60000);

let connection = null;
let channel = null;
let consumerTag = null;
let workerStartedAt = null;
let queueDepth = 0;
let processingCount = 0;
let processedTotal = 0;
let failedTotal = 0;
let lastMessageAt = null;
let lastError = null;
let connecting = null;
let retryTimer = null;
let reconnectTimer = null;
let wantWorker = false;
let shuttingDown = false;
let brokerDownUntil = 0;
let lastConnectFailLogAt = 0;
let mode = 'inline';

async function connect() {
    if (channel) return channel;
    if (Date.now() < brokerDownUntil) {
        const err = new Error(lastError || 'RabbitMQ temporarily unavailable');
        err.code = 'RABBITMQ_CIRCUIT_OPEN';
        throw err;
    }
    if (connecting) return connecting;
    connecting = (async () => {
        try {
            connection = await amqp.connect(AMQP_URL);
            connection.on('error', (err) => {
                lastError = formatError(err);
                console.error('[jobDetailFetch] connection error:', lastError);
            });
            connection.on('close', () => {
                console.log('[jobDetailFetch] connection closed');
                connection = null;
                channel = null;
                consumerTag = null;
                mode = 'inline';
                brokerDownUntil = Date.now() + CIRCUIT_MS;
                if (!shuttingDown && wantWorker) {
                    scheduleReconnect();
                }
            });
            channel = await connection.createConfirmChannel();
            await channel.assertQueue(QUEUE, { durable: true });
            brokerDownUntil = 0;
            mode = 'rabbit';
            console.log(`[jobDetailFetch] connected to ${AMQP_URL.replace(/\/\/.*@/, '//***@')} (queue=${QUEUE})`);
            return channel;
        } catch (err) {
            lastError = formatError(err);
            brokerDownUntil = Date.now() + CIRCUIT_MS;
            mode = 'inline';
            const now = Date.now();
            if (now - lastConnectFailLogAt >= LOG_COOLDOWN_MS) {
                lastConnectFailLogAt = now;
                console.warn(
                    `[jobDetailFetch] RabbitMQ unavailable (${lastError}) — inline scrape + retry scheduler`
                );
            }
            throw err;
        } finally {
            connecting = null;
        }
    })();
    return connecting;
}

function scheduleReconnect() {
    if (reconnectTimer || shuttingDown) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        if (shuttingDown || !wantWorker) return;
        try {
            await startWorker();
            if (channel) console.log('[jobDetailFetch] reconnected');
        } catch (err) {
            lastError = formatError(err);
            scheduleReconnect();
        }
    }, RECONNECT_MS);
}

async function refreshQueueDepth() {
    try {
        const ch = await connect();
        const info = await ch.checkQueue(QUEUE);
        queueDepth = info.messageCount;
    } catch (_) { /* soft-fail */ }
}

async function enqueueJobDetailFetch(jobLinkId, opts = {}) {
    if (!Number.isInteger(jobLinkId)) {
        throw new Error('jobLinkId must be an integer');
    }
    const payload = {
        jobLinkId,
        enqueuedAt: new Date().toISOString(),
        ...opts
    };
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
        const now = Date.now();
        if (now - lastConnectFailLogAt >= LOG_COOLDOWN_MS) {
            lastConnectFailLogAt = now;
            console.warn('[jobDetailFetch] RabbitMQ unavailable, falling back to in-process scrape:', formatError(queueErr));
        }
        mode = 'inline';
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
}

async function startWorker() {
    wantWorker = true;
    if (consumerTag) return { consumerTag, mode: 'rabbit' };
    let ch;
    try {
        ch = await connect();
    } catch (err) {
        startRetryScheduler();
        console.log('[jobDetailFetch] worker idle in-process (RabbitMQ unavailable; retry-scheduler active)');
        return { consumerTag: null, mode: 'inline' };
    }
    await ch.prefetch(PREFETCH);
    const { consumerTag: tag } = await ch.consume(QUEUE, async (msg) => {
        if (!msg) return;
        let parsed = null;
        try {
            parsed = JSON.parse(msg.content.toString('utf8'));
        } catch (err) {
            console.error('[jobDetailFetch] bad message body, dropping:', err.message);
            ch.nack(msg, false, false);
            failedTotal += 1;
            return;
        }

        const jobLinkId = parsed.jobLinkId;
        processingCount += 1;
        queueDepth = Math.max(0, queueDepth - 1);
        lastMessageAt = new Date();
        try {
            const result = await scrapeJobLinkById(jobLinkId);
            if (result && result.ok) {
                ch.ack(msg);
                processedTotal += 1;
            } else if (result && result.skipped) {
                // Already claimed / no longer needs fetch — ack so we don't loop.
                ch.ack(msg);
                processedTotal += 1;
            } else {
                const errMsg = (result && result.error) || 'unknown';
                const transient = /unreachable|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up/i.test(errMsg);
                ch.nack(msg, false, transient);
                lastError = formatError({ message: errMsg });
                if (transient) {
                    console.warn(`[jobDetailFetch] transient failure for job_link=${jobLinkId}, requeued: ${errMsg}`);
                } else {
                    console.warn(`[jobDetailFetch] permanent failure for job_link=${jobLinkId}, dropped: ${errMsg}`);
                }
                failedTotal += 1;
            }
        } catch (err) {
            lastError = formatError(err);
            console.error(`[jobDetailFetch] handler crashed for job_link=${jobLinkId}:`, err.message);
            ch.nack(msg, false, true);
            failedTotal += 1;
        } finally {
            processingCount = Math.max(0, processingCount - 1);
            refreshQueueDepth().catch(() => {});
        }
    });
    consumerTag = tag;
    workerStartedAt = new Date();
    mode = 'rabbit';
    console.log(`[jobDetailFetch] worker started (queue=${QUEUE}, prefetch=${PREFETCH}, consumerTag=${tag})`);
    refreshQueueDepth().catch(() => {});
    startRetryScheduler();
    return { consumerTag: tag, mode: 'rabbit' };
}

/**
 * Periodically recover stale `fetching` rows and re-enqueue pending/failed
 * that are due. Fixes intermittent "never scrapes again" after first fail
 * when the old cron was removed.
 */
function startRetryScheduler() {
    if (retryTimer) return;
    const tick = async () => {
        if (shuttingDown) return;
        try {
            cleanupStaleFetching();
            const ids = listDueJobLinkIds(40);
            for (const id of ids) {
                try {
                    await enqueueJobDetailFetch(id, { source: 'retry-scheduler' });
                } catch (err) {
                    console.warn(`[jobDetailFetch] retry enqueue ${id}:`, formatError(err));
                }
            }
            if (ids.length) {
                console.log(`[jobDetailFetch] retry-scheduler enqueued ${ids.length} due row(s)`);
            }
        } catch (err) {
            console.warn('[jobDetailFetch] retry-scheduler error:', formatError(err));
        }
    };
    // First pass shortly after boot (boot recovery already ran once in initProvider)
    setTimeout(tick, 8000);
    retryTimer = setInterval(tick, RETRY_POLL_MS);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

function stopRetryScheduler() {
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

async function stopWorker() {
    wantWorker = false;
    stopRetryScheduler();
    if (!consumerTag || !channel) return;
    try {
        await channel.cancel(consumerTag);
        console.log(`[jobDetailFetch] worker stopped (consumerTag=${consumerTag})`);
    } catch (err) {
        console.warn('[jobDetailFetch] cancel failed:', err.message);
    }
    consumerTag = null;
    workerStartedAt = null;
}

async function closeQueue() {
    shuttingDown = true;
    await stopWorker();
    try {
        if (channel) await channel.close();
    } catch (_) { /* ignore */ }
    try {
        if (connection) await connection.close();
    } catch (_) { /* ignore */ }
    channel = null;
    connection = null;
}

function getStatus() {
    return {
        connected: Boolean(connection && channel),
        mode: channel ? 'rabbit' : 'inline',
        queueName: QUEUE,
        amqpUrl: AMQP_URL.replace(/\/\/.*@/, '//***@'),
        prefetch: PREFETCH,
        queueDepth,
        processingCount,
        processedTotal,
        failedTotal,
        workerStartedAt,
        lastMessageAt,
        lastError: channel
            ? lastError
            : (lastError || 'RabbitMQ unavailable — inline scrape + retry scheduler'),
        retryScheduler: Boolean(retryTimer),
        retryPollMs: RETRY_POLL_MS,
        circuitOpen: Date.now() < brokerDownUntil
    };
}

module.exports = {
    enqueueJobDetailFetch,
    startWorker,
    stopWorker,
    closeQueue,
    refreshQueueDepth,
    getStatus,
    startRetryScheduler,
    QUEUE
};
