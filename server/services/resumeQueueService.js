// =============================================================================
// services/resumeQueueService.js
// =============================================================================
//
// Resume-generation worklist for auto-apply.
//
// Prefers RabbitMQ when available. When the broker is down (common on
// local Windows without Docker/Erlang), falls back to an in-process
// serial queue (prefetch=1) so auto-apply never depends on a throw +
// inline catch in the cron.
//
// Status reports mode: 'rabbit' | 'inline'.
// =============================================================================

'use strict';

function formatError(err) {
    if (!err) return 'unknown';
    if (typeof err === 'string') return err;
    if (err instanceof Error) {
        if (err.constructor && err.constructor.name === 'AggregateError') {
            const subErrors = (err.errors || []).map((e) => {
                if (e instanceof Error) return e.message;
                if (typeof e === 'string') return e;
                try { return JSON.stringify(e); } catch { return String(e); }
            }).filter(Boolean);
            if (subErrors.length > 0) return `AggregateError: ${subErrors.join(' | ')}`;
            return 'AggregateError (no detail)';
        }
        if (err.message) return err.message;
    }
    try { return String(err); } catch { return 'unknown'; }
}

const amqp = require('amqplib');

const AMQP_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
const QUEUE = process.env.RABBITMQ_QUEUE || 'resume_generation';
const PREFETCH = Math.max(1, parseInt(process.env.RABBITMQ_PREFETCH || 1, 10));
/** How long to stop hammering a dead broker (ms). */
const CIRCUIT_MS = Math.max(15000, parseInt(process.env.RABBITMQ_CIRCUIT_MS || 60000, 10) || 60000);
/** Log connect failures at most once per this window. */
const LOG_COOLDOWN_MS = Math.max(30000, parseInt(process.env.RABBITMQ_LOG_COOLDOWN_MS || 120000, 10) || 120000);

let connection = null;
let channel = null;
let consumerTag = null;
let connecting = null;
let queueDepth = 0;
let processingCount = 0;
let processedTotal = 0;
let failedTotal = 0;
let lastError = null;
let workerStartedAt = null;
let lastMessageAt = null;
let brokerDownUntil = 0;
let lastConnectFailLogAt = 0;
let mode = 'inline'; // 'rabbit' | 'inline'

// In-process serial queue (used when Rabbit is down)
const localQueue = [];
const localQueuedKeys = new Set();
let localHandler = null;
let localPumpRunning = false;

function jobKey(profileId, jobLinkId) {
    return `${Number(profileId)}:${Number(jobLinkId)}`;
}

function noteConnectFailure(err) {
    lastError = formatError(err);
    brokerDownUntil = Date.now() + CIRCUIT_MS;
    mode = 'inline';
    const now = Date.now();
    if (now - lastConnectFailLogAt >= LOG_COOLDOWN_MS) {
        lastConnectFailLogAt = now;
        console.warn(
            `[resumeQueue] RabbitMQ unavailable (${lastError}) — using in-process queue `
            + `(retry after ${Math.round(CIRCUIT_MS / 1000)}s)`
        );
    }
}

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
                const now = Date.now();
                if (now - lastConnectFailLogAt >= LOG_COOLDOWN_MS) {
                    lastConnectFailLogAt = now;
                    console.error('[resumeQueue] connection error:', lastError);
                }
            });
            connection.on('close', () => {
                console.warn('[resumeQueue] connection closed — falling back to in-process queue');
                channel = null;
                connection = null;
                consumerTag = null;
                mode = 'inline';
                brokerDownUntil = Date.now() + CIRCUIT_MS;
            });
            channel = await connection.createConfirmChannel();
            await channel.assertQueue(QUEUE, { durable: true });
            brokerDownUntil = 0;
            mode = 'rabbit';
            console.log(`[resumeQueue] connected to ${AMQP_URL.replace(/:[^:@/]+@/, ':***@')} (queue=${QUEUE})`);
            return channel;
        } catch (err) {
            connecting = null;
            noteConnectFailure(err);
            throw err;
        } finally {
            connecting = null;
        }
    })();
    return connecting;
}

function enqueueLocal(profileId, jobLinkId, opts = {}) {
    const base = jobKey(profileId, jobLinkId);
    const key = opts.force ? `${base}:force:${Date.now()}` : base;
    if (!opts.force && localQueuedKeys.has(base)) {
        return { ok: true, mode: 'inline', deduped: true };
    }
    localQueuedKeys.add(key);
    localQueue.push({
        profileId: Number(profileId),
        jobLinkId: Number(jobLinkId),
        enqueuedAt: new Date().toISOString(),
        correlationId: opts.correlationId || null,
        _key: key
    });
    if (mode !== 'rabbit') queueDepth = localQueue.length;
    pumpLocal();
    return { ok: true, mode: 'inline' };
}

function pumpLocal() {
    if (localPumpRunning || !localHandler) return;
    if (!localQueue.length) return;
    localPumpRunning = true;
    (async () => {
        while (localQueue.length && localHandler) {
            const job = localQueue.shift();
            if (mode !== 'rabbit') queueDepth = localQueue.length;
            processingCount += 1;
            lastMessageAt = new Date();
            try {
                await localHandler({
                    profileId: job.profileId,
                    jobLinkId: job.jobLinkId,
                    enqueuedAt: job.enqueuedAt,
                    correlationId: job.correlationId
                });
                processedTotal += 1;
            } catch (err) {
                lastError = formatError(err);
                failedTotal += 1;
                console.error(
                    `[resumeQueue] inline handler failed for job_link=${job.jobLinkId} profile=${job.profileId}:`,
                    err.message || err
                );
            } finally {
                if (job?._key) localQueuedKeys.delete(job._key);
                processingCount = Math.max(0, processingCount - 1);
                if (mode !== 'rabbit') queueDepth = localQueue.length;
            }
        }
    })()
        .catch((err) => {
            lastError = formatError(err);
            console.error('[resumeQueue] inline pump error:', lastError);
        })
        .finally(() => {
            localPumpRunning = false;
            if (localQueue.length && localHandler) pumpLocal();
        });
}

/**
 * Enqueue one resume-generation job. Prefers RabbitMQ; on broker failure
 * uses the in-process serial queue (never throws for "broker down").
 */
async function enqueueGeneration(profileId, jobLinkId, opts = {}) {
    try {
        const ch = await connect();
        const payload = {
            profileId: Number(profileId),
            jobLinkId: Number(jobLinkId),
            enqueuedAt: new Date().toISOString(),
            correlationId: opts.correlationId || null
        };
        await new Promise((resolve, reject) => {
            const ok = ch.sendToQueue(
                QUEUE,
                Buffer.from(JSON.stringify(payload)),
                {
                    persistent: true,
                    contentType: 'application/json',
                    messageId: `gen-${payload.jobLinkId}-${payload.profileId}-${Date.now()}`
                },
                (err) => {
                    if (err) {
                        lastError = formatError(err);
                        reject(err);
                    } else {
                        queueDepth += 1;
                        resolve(true);
                    }
                }
            );
            if (!ok) ch.once('drain', () => resolve(true));
        });
        mode = 'rabbit';
        return { ok: true, mode: 'rabbit' };
    } catch (err) {
        noteConnectFailure(err);
        return enqueueLocal(profileId, jobLinkId, opts);
    }
}

async function refreshQueueStats() {
    if (mode === 'inline' || !channel) {
        queueDepth = localQueue.length;
        return { messageCount: localQueue.length, consumerCount: localHandler ? 1 : 0, mode: 'inline' };
    }
    try {
        const ch = await connect();
        const info = await ch.checkQueue(QUEUE);
        queueDepth = info.messageCount;
        return { messageCount: info.messageCount, consumerCount: info.consumerCount, mode: 'rabbit' };
    } catch (err) {
        noteConnectFailure(err);
        queueDepth = localQueue.length;
        return { messageCount: localQueue.length, consumerCount: localHandler ? 1 : 0, mode: 'inline' };
    }
}

async function startWorker(handler) {
    localHandler = handler;
    workerStartedAt = workerStartedAt || new Date();
    pumpLocal();

    try {
        const ch = await connect();
        await ch.prefetch(PREFETCH);
        const { consumerTag: tag } = await ch.consume(QUEUE, async (msg) => {
            if (!msg) return;
            let parsed = null;
            try {
                parsed = JSON.parse(msg.content.toString('utf8'));
            } catch (err) {
                console.error('[resumeQueue] bad message body, dropping:', err.message);
                ch.nack(msg, false, false);
                failedTotal += 1;
                return;
            }

            processingCount += 1;
            queueDepth = Math.max(0, queueDepth - 1);
            lastMessageAt = new Date();
            try {
                await handler(parsed);
                ch.ack(msg);
                processedTotal += 1;
            } catch (err) {
                lastError = formatError(err);
                console.error(
                    `[resumeQueue] handler failed for job_link=${parsed.jobLinkId} profile=${parsed.profileId}:`,
                    err.message
                );
                ch.nack(msg, false, false);
                failedTotal += 1;
            } finally {
                processingCount = Math.max(0, processingCount - 1);
            }
        });
        consumerTag = tag;
        workerStartedAt = new Date();
        mode = 'rabbit';
        console.log(`[resumeQueue] worker started (queue=${QUEUE}, prefetch=${PREFETCH}, consumerTag=${tag})`);
        return { consumerTag: tag, mode: 'rabbit' };
    } catch (err) {
        noteConnectFailure(err);
        console.log('[resumeQueue] worker started in-process (RabbitMQ unavailable)');
        return { consumerTag: null, mode: 'inline' };
    }
}

async function stopWorker() {
    if (channel && consumerTag) {
        try {
            await channel.cancel(consumerTag);
            console.log(`[resumeQueue] worker stopped (consumerTag=${consumerTag})`);
        } catch (err) {
            console.warn('[resumeQueue] stopWorker error:', err.message);
        }
    }
    consumerTag = null;
    localHandler = null;
}

async function close() {
    try {
        await stopWorker();
        if (channel) await channel.close();
        if (connection) await connection.close();
    } catch (err) {
        console.warn('[resumeQueue] close error:', err.message);
    } finally {
        channel = null;
        connection = null;
        consumerTag = null;
        localHandler = null;
        localQueue.length = 0;
        localQueuedKeys.clear();
    }
}

function getStatus() {
    const inlineDepth = localQueue.length;
    const effectiveDepth = mode === 'rabbit' ? queueDepth : inlineDepth;
    return {
        connected: !!channel,
        mode: channel ? 'rabbit' : 'inline',
        queueName: QUEUE,
        amqpUrl: AMQP_URL.replace(/:[^:@/]+@/, ':***@'),
        prefetch: PREFETCH,
        queueDepth: effectiveDepth,
        inlineQueueDepth: inlineDepth,
        processingCount,
        processedTotal,
        failedTotal,
        workerStartedAt,
        lastMessageAt,
        lastError: channel ? lastError : (lastError || 'RabbitMQ unavailable — using in-process queue'),
        circuitOpen: Date.now() < brokerDownUntil,
        circuitOpenUntil: brokerDownUntil || null
    };
}

module.exports = {
    connect,
    enqueueGeneration,
    refreshQueueStats,
    startWorker,
    stopWorker,
    close,
    getStatus
};
