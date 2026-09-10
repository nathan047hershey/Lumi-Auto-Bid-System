// Load environment variables from .env (must be first)
const path = require('path');
require('dotenv').config();
// Optional local overrides (gitignored). Use for API keys you don't want
// to paste through the Admin Settings UI — e.g. MiniMax Key 2.
require('dotenv').config({
    path: path.join(__dirname, 'local.env'),
    override: true
});

const express = require('express');
const cors = require('cors');
// path already required above

const { initDatabase } = require('./config/database');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const callerRoutes = require('./routes/caller');
const managerRoutes = require('./routes/manager');
const { router: jobLinksRouter, adminWriteRouter: jobLinksAdminRouter } = require('./routes/jobLinks');
const { initProvider, shutdownProvider } = require('./services/jobLinkScraper');
const jobDetailFetchService = require('./services/jobDetailFetchService');
const { startCron: startAutoApplyCron, stopCron: stopAutoApplyCron, startWorker: startAutoApplyWorker, stopWorker: stopAutoApplyWorker, closeQueue: closeAutoApplyQueue } = require('./services/jobMatchService');

const app = express();
const PORT = process.env.PORT || 9017;

// Middleware
app.use(cors({
    // Vite client + Chrome extension (Mode 1 bidder). Extensions send an
    // Origin like chrome-extension://<id>; allow those plus local dev.
    // Also allow all origins in production (Render deployments)
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (process.env.NODE_ENV === 'production') {
            // Allow all origins in production
            return callback(null, true);
        }
        if (
            origin === 'http://localhost:5173'
            || origin === 'http://localhost:3000'
            || origin === 'http://127.0.0.1:5173'
            || origin.startsWith('chrome-extension://')
        ) {
            return callback(null, true);
        }
        return callback(null, false);
    },
    credentials: true
}));
app.use(express.json({
    // DOCX templates are uploaded as base64 inside JSON, which inflates
    // the wire payload by ~33%. We cap uploads at 25 MB on the wire so a
    // 10 MB raw DOCX (the client-side cap) still fits, with headroom for
    // the JSON envelope (filename, name, description, etc.).
    limit: '25mb'
}));
// Mailgun / form-style inbound parse for /api/hooks/inbound-mail
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Static files for resumes (<repo>/database/resumes by default)
const { RESUMES_DIR, DATA_ROOT } = require('./config/paths');
app.use('/resumes', express.static(RESUMES_DIR));
console.log('[boot] serving resumes from', RESUMES_DIR, '(DATA_ROOT', DATA_ROOT + ')');

// Health check must be registered before jobLinksRouter (mounted at `/`
// with a global requireAuth middleware that would otherwise block it).
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Public mail-forward webhook (token-secured) — MUST be before jobLinksRouter
// which mounts at `/` with global requireAuth and would 401 unauthenticated POSTs.
app.use('/api/hooks', require('./routes/inboundMail'));
app.use('/hooks', require('./routes/inboundMail'));

// API Routes
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
// Job Links — list / create / update / delete are available to any
// authenticated user (the directory is the team's shared view). The
// scrape endpoint alone is admin-only because it makes outbound
// requests to LinkedIn from the server's IP — we don't want a regular
// user to be able to burst many fetches at once.
//
// Mounting:
//   - `jobLinksRouter` (public reads + writes) is mounted at `/`,
//     so its paths are `/job-links`, `/job-links/:id`, etc.
//   - `jobLinksAdminRouter` (the scrape endpoint) is mounted at
//     `/admin` BEFORE `adminRoutes` so its own `requireAdmin`
//     intercepts the request before the admin router's middleware
//     chain runs.
app.use('/',        jobLinksRouter);
app.use('/admin',   jobLinksAdminRouter);
app.use('/user',    userRoutes);
app.use('/caller',  callerRoutes);
app.use('/manager', managerRoutes);

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Initialize database and start server
async function startServer() {
    try {
        await initDatabase();
        console.log('Database initialized successfully');

        try {
            require('./services/bidderBrainService').ensureFieldAttemptTable();
            require('./services/bidderBrainService').ensureFillLessonTable();
            console.log('[boot] bidder-engine-v1 field-attempt table ready');
        } catch (err) {
            console.warn('[boot] bidder brain table skipped:', err.message);
        }

        // Apply MINIMAX_KEY_SLOT from local.env when DB has no slot yet.
        try {
            const settingsService = require('./services/settingsService');
            // When MINIMAX_PREFER_ENV=1, local.env MINIMAX_KEY_SLOT is the boot default.
            const preferEnv = String(process.env.MINIMAX_PREFER_ENV || '').trim() === '1'
                || String(process.env.MINIMAX_PREFER_ENV || '').trim().toLowerCase() === 'true';
            const synced = settingsService.syncMinimaxSlotFromEnv({ force: preferEnv });
            const mm = settingsService.getMinimaxKeysStatus(synced);
            console.log(
                `[boot] MiniMax Key ${mm.active_slot} active` +
                (mm.key_2?.is_set ? ` · Key 2 set (${mm.key_2.masked})` : ' · Key 2 not set') +
                (mm.keys_from_env ? ' · keys from local.env' : '')
            );
            try {
                const gq = settingsService.getGroqKeysStatus();
                const answers = settingsService.getAnswersProviderConfig();
                console.log(
                    `[boot] Answers engine: ${answers.provider} (${answers.model})` +
                    (gq.count ? ` · ${gq.count} Groq key(s)` : ' · no Groq keys yet')
                );
            } catch (ansErr) {
                console.warn('[boot] Answers provider:', ansErr.message);
            }
        } catch (err) {
            console.warn('[boot] MiniMax settings sync skipped:', err.message);
        }

        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`
╔════════════════════════════════════════════════╗
║  Job Application Management Platform - Server  ║
╠════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}        ║
╚════════════════════════════════════════════════╝
      `);
        });

        // Increase server timeout to 3 minutes for long-running AI requests
        server.timeout = 180000; // 3 minutes
        server.keepAliveTimeout = 185000; // Slightly longer than timeout
        server.headersTimeout = 190000; // Slightly longer than keepAliveTimeout

        // Initialise the LinkedIn / ATS scraper provider. No cron
        // here — fetching is driven by the RabbitMQ worker started
        // below. initProvider() also runs the one-time recovery
        // pass that flips any rows stuck in 'fetching' back to
        // 'pending' and re-enqueues them so a fresh boot never
        // silently drops work.
        initProvider().catch((err) => {
            console.error('[boot] failed to initialise scraper provider:', err.message);
        });

        // Boot the job-detail fetch worker (RabbitMQ consumer,
        // prefetch=1). Every POST /job-links (and the recovery
        // pass above) drops a message on the `job_detail_fetch`
        // queue; this worker pulls them one at a time and invokes
        // scrapeJobLinkById() in services/jobLinkScraper.js.
        try {
            await jobDetailFetchService.startWorker();
        } catch (err) {
            console.error('[boot] failed to start job-detail fetch worker:', err.message);
            // Still run the retry scheduler so pending/failed rows get
            // inline-scraped even when RabbitMQ is down at boot.
            try {
                jobDetailFetchService.startRetryScheduler();
            } catch (_) { /* ignore */ }
        }

        // Boot the auto-apply cron (5min default). Pulls freshly
        // fetched job_links, scores candidate profiles, and
        // enqueues (profile, job_link) pairs onto the
        // RabbitMQ-backed resume_generation queue. The actual
        // generation runs in the worker started below. See
        // services/jobMatchService.js for the matching heuristic
        // and services/resumeQueueService.js for the broker.
        startAutoApplyCron();

        // Boot the resume-generation worker (RabbitMQ consumer,
        // prefetch=1). Processes one message at a time so the AI
        // provider can't be stampeded. Failures are surfaced on
        // the job_applications row and the message is nacked
        // without requeue (poison-message protection).
        try {
            await startAutoApplyWorker();
        } catch (err) {
            console.error('[boot] failed to start resume-generation worker:', err.message);
        }

        // Outlook inbox sync (Greenhouse email security codes) — polls
        // connected accounts on an interval so OTPs arrive without watching mail.
        try {
            require('./services/outlookMailService').startOutlookMailService();
        } catch (err) {
            console.warn('[boot] Outlook mail service skipped:', err.message);
        }
        try {
            require('./services/gmailImapService').startGmailImapService();
        } catch (err) {
            console.warn('[boot] Gmail IMAP (free) service skipped:', err.message);
        }

        // Graceful shutdown — make sure the in-flight scrape gets a
        // chance to finish before the process exits. PM2 sends
        // SIGINT on reload, so this catches both `pm2 restart` and
        // `Ctrl+C` during local dev.
        const shutdown = async () => {
            console.log('Shutting down — stopping workers...');
            try { require('./services/outlookMailService').stopOutlookMailService(); } catch (_) { /* ignore */ }
            try { require('./services/gmailImapService').stopGmailImapService(); } catch (_) { /* ignore */ }
            try { await shutdownProvider(); } catch (_) { /* ignore */ }
            try { await jobDetailFetchService.closeQueue(); } catch (_) { /* ignore */ }
            try { await stopAutoApplyCron(); } catch (_) { /* ignore */ }
            try { await stopAutoApplyWorker(); } catch (_) { /* ignore */ }
            try { await closeAutoApplyQueue(); } catch (_) { /* ignore */ }
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 5000).unref();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer();
