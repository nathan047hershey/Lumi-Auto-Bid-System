/**
 * Persist MiniMax / Groq (and other AI) call counts for the Analyze page.
 * Use withUsageContext() around route handlers so nested callers inherit user/kind.
 */
const { AsyncLocalStorage } = require('async_hooks');
const { runQuery, getAll, getOne } = require('../config/database');

const usageAls = new AsyncLocalStorage();

const KINDS = new Set(['chat', 'cv', 'answers', 'bidder', 'analyze', 'checkout', 'other']);

/** Free-tier defaults for autofill model openai/gpt-oss-20b (override via env). */
function groqFreeLimits() {
    const rpd = Number(process.env.GROQ_RPD_LIMIT);
    const tpd = Number(process.env.GROQ_TPD_LIMIT);
    return {
        rpd: Number.isFinite(rpd) && rpd > 0 ? rpd : 1000,
        tpd: Number.isFinite(tpd) && tpd > 0 ? tpd : 200000
    };
}

function withUsageContext(ctx, fn) {
    const parent = usageAls.getStore() || {};
    const next = { ...parent, ...(ctx || {}) };
    if (typeof fn !== 'function') {
        return usageAls.run(next, () => next);
    }
    return usageAls.run(next, fn);
}

function currentUsageContext() {
    return usageAls.getStore() || {};
}

function normalizeKind(kind) {
    const k = String(kind || 'other').toLowerCase().slice(0, 40);
    return KINDS.has(k) ? k : 'other';
}

function parseUsage(usage) {
    if (!usage || typeof usage !== 'object') {
        return { prompt_tokens: null, completion_tokens: null, total_tokens: null };
    }
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens);
    const total = Number(
        usage.total_tokens
        ?? ((Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0))
    );
    return {
        prompt_tokens: Number.isFinite(prompt) ? prompt : null,
        completion_tokens: Number.isFinite(completion) ? completion : null,
        total_tokens: Number.isFinite(total) && total > 0 ? total : null
    };
}

/**
 * Record one AI call (MiniMax, Groq, …).
 */
function recordUsage({
    userId,
    profileId,
    provider,
    kind,
    model,
    usage,
    success = true,
    keySlot = null
} = {}) {
    try {
        const ctx = currentUsageContext();
        const uid = userId != null ? parseInt(userId, 10) : (ctx.userId != null ? parseInt(ctx.userId, 10) : null);
        const pid = profileId != null
            ? parseInt(profileId, 10)
            : (ctx.profileId != null ? parseInt(ctx.profileId, 10) : null);
        const prov = String(provider || ctx.provider || 'minimax').toLowerCase().slice(0, 40);
        const k = normalizeKind(kind || ctx.kind || 'other');
        const tokens = parseUsage(usage);
        const slotRaw = keySlot != null ? Number(keySlot) : (ctx.keySlot != null ? Number(ctx.keySlot) : null);
        const slot = Number.isInteger(slotRaw) && slotRaw > 0 ? slotRaw : null;
        runQuery(
            `INSERT INTO ai_usage_events (
                user_id, profile_id, provider, kind, model,
                prompt_tokens, completion_tokens, total_tokens, success, key_slot, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
                Number.isInteger(uid) && uid > 0 ? uid : null,
                Number.isInteger(pid) && pid > 0 ? pid : null,
                prov,
                k,
                model ? String(model).slice(0, 120) : null,
                tokens.prompt_tokens,
                tokens.completion_tokens,
                tokens.total_tokens,
                success ? 1 : 0,
                slot
            ]
        );
    } catch (err) {
        console.warn('[ai-usage] record failed:', err.message || err);
    }
}

/**
 * Record from an OpenAI-style chat completion response.
 * MiniMax + Groq (and others when provider is set explicitly).
 */
function recordAiResponse(response, overrides = {}) {
    const ctx = currentUsageContext();
    const provider = String(overrides.provider || ctx.provider || 'minimax').toLowerCase();
    if (!provider || provider === 'local') return;
    const model = overrides.model
        || response?.data?.model
        || response?.config?.data?.model
        || null;
    const keySlot = overrides.keySlot
        ?? overrides.groq_key_slot
        ?? overrides.minimax_key_slot
        ?? null;
    recordUsage({
        userId: overrides.userId,
        profileId: overrides.profileId,
        provider,
        kind: overrides.kind || ctx.kind || 'other',
        model,
        usage: response?.data?.usage || overrides.usage,
        success: overrides.success !== false,
        keySlot
    });
}

/** @deprecated prefer recordAiResponse — kept for MiniMax-only call sites */
function recordMinimaxResponse(response, overrides = {}) {
    const provider = String(overrides.provider || 'minimax').toLowerCase();
    if (provider !== 'minimax') {
        // Still record Groq/other when callers pass provider explicitly.
        return recordAiResponse(response, overrides);
    }
    return recordAiResponse(response, { ...overrides, provider: 'minimax' });
}

function countCalls(provider, whereExtra, params) {
    const row = getOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = ?
           AND success = 1
           ${whereExtra}`,
        [provider, ...params]
    );
    return {
        calls: Number(row?.calls) || 0,
        total_tokens: Number(row?.total_tokens) || 0
    };
}

function getGroqUsageSummary({ userId, profileId, sinceDays = 30 } = {}) {
    const uid = userId != null ? parseInt(userId, 10) : null;
    const days = Math.min(Math.max(parseInt(sinceDays, 10) || 30, 1), 365);
    const scopeParams = [];
    let userClause = '';
    if (Number.isInteger(uid) && uid > 0) {
        userClause = ' AND user_id = ? ';
        scopeParams.push(uid);
    }
    let profileClause = '';
    if (profileId) {
        const pid = parseInt(profileId, 10);
        if (Number.isInteger(pid) && pid > 0) {
            profileClause = ' AND profile_id = ? ';
            scopeParams.push(pid);
        }
    }
    const scopeSql = `${userClause}${profileClause}`;
    const limits = groqFreeLimits();

    let keysConfigured = 0;
    let activeSlot = 1;
    let activeModel = 'openai/gpt-oss-20b';
    try {
        const {
            listResolvedGroqKeys,
            getActiveGroqSlot,
            getAnswersGroqRescueConfig
        } = require('./settingsService');
        keysConfigured = listResolvedGroqKeys().length;
        activeSlot = getActiveGroqSlot();
        const cfg = getAnswersGroqRescueConfig();
        if (cfg?.model) activeModel = cfg.model;
    } catch (_) { /* settings may be unavailable in tests */ }

    const today = countCalls(
        'groq',
        `${scopeSql} AND created_at >= datetime('now', 'start of day')`,
        [...scopeParams]
    );
    const last5h = countCalls(
        'groq',
        `${scopeSql} AND created_at >= datetime('now', '-5 hours')`,
        [...scopeParams]
    );
    const last7 = countCalls(
        'groq',
        `${scopeSql} AND created_at >= datetime('now', '-7 days')`,
        [...scopeParams]
    );
    const period = countCalls(
        'groq',
        `${scopeSql} AND created_at >= datetime('now', '-' || ? || ' days')`,
        [...scopeParams, days]
    );

    const tokenSplitToday = getOne(
        `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(AVG(total_tokens), 0) AS avg_tokens,
                COALESCE(MAX(total_tokens), 0) AS max_tokens
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', 'start of day')`,
        [...scopeParams]
    ) || {};

    const tokenSplitPeriod = getOne(
        `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(AVG(total_tokens), 0) AS avg_tokens,
                COALESCE(MAX(total_tokens), 0) AS max_tokens
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')`,
        [...scopeParams, days]
    ) || {};

    const failToday = getOne(
        `SELECT COUNT(*) AS fails
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 0
           ${scopeSql}
           AND created_at >= datetime('now', 'start of day')`,
        [...scopeParams]
    );
    const failPeriod = getOne(
        `SELECT COUNT(*) AS fails
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 0
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')`,
        [...scopeParams, days]
    );

    const byKeyTodayRows = getAll(
        `SELECT COALESCE(key_slot, 0) AS key_slot,
                COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(AVG(total_tokens), 0) AS avg_tokens
         FROM ai_usage_events
         WHERE provider = 'groq'
           AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', 'start of day')
         GROUP BY COALESCE(key_slot, 0)
         ORDER BY key_slot ASC`,
        [...scopeParams]
    );
    const byKeyPeriodRows = getAll(
        `SELECT COALESCE(key_slot, 0) AS key_slot,
                COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = 'groq'
           AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY COALESCE(key_slot, 0)`,
        [...scopeParams, days]
    );
    const periodByKey = new Map();
    for (const row of byKeyPeriodRows || []) {
        periodByKey.set(Number(row.key_slot) || 0, {
            calls: Number(row.calls) || 0,
            total_tokens: Number(row.total_tokens) || 0
        });
    }

    const byKeyMap = new Map();
    for (const row of byKeyTodayRows || []) {
        const slot = Number(row.key_slot) || 0;
        byKeyMap.set(slot, {
            slot: slot || null,
            calls_today: Number(row.calls) || 0,
            tokens_today: Number(row.total_tokens) || 0,
            prompt_tokens_today: Number(row.prompt_tokens) || 0,
            completion_tokens_today: Number(row.completion_tokens) || 0,
            avg_tokens_today: Math.round(Number(row.avg_tokens) || 0)
        });
    }

    const by_key = [];
    const slotCount = Math.max(keysConfigured, ...[...byKeyMap.keys()].filter((n) => n > 0), 0);
    for (let s = 1; s <= slotCount; s++) {
        const hit = byKeyMap.get(s) || {
            slot: s,
            calls_today: 0,
            tokens_today: 0,
            prompt_tokens_today: 0,
            completion_tokens_today: 0,
            avg_tokens_today: 0
        };
        const per = periodByKey.get(s) || { calls: 0, total_tokens: 0 };
        const rpdRem = Math.max(0, limits.rpd - hit.calls_today);
        const tpdRem = Math.max(0, limits.tpd - hit.tokens_today);
        const rpdPct = Math.min(100, Math.round((hit.calls_today / limits.rpd) * 100));
        const tpdPct = Math.min(100, Math.round((hit.tokens_today / limits.tpd) * 100));
        by_key.push({
            slot: s,
            active: s === activeSlot,
            calls_today: hit.calls_today,
            tokens_today: hit.tokens_today,
            prompt_tokens_today: hit.prompt_tokens_today,
            completion_tokens_today: hit.completion_tokens_today,
            avg_tokens_today: hit.avg_tokens_today,
            calls_period: per.calls,
            tokens_period: per.total_tokens,
            rpd_limit: limits.rpd,
            tpd_limit: limits.tpd,
            rpd_remaining: rpdRem,
            tpd_remaining: tpdRem,
            rpd_used_pct: rpdPct,
            tpd_used_pct: tpdPct,
            binding_limit: tpdPct >= rpdPct ? 'tpd' : 'rpd',
            health: Math.max(rpdPct, tpdPct) >= 90 ? 'critical'
                : Math.max(rpdPct, tpdPct) >= 70 ? 'warn'
                    : 'ok'
        });
    }
    if (byKeyMap.has(0)) {
        const hit = byKeyMap.get(0);
        const per = periodByKey.get(0) || { calls: 0, total_tokens: 0 };
        by_key.push({
            slot: null,
            active: false,
            unlabeled: true,
            calls_today: hit.calls_today,
            tokens_today: hit.tokens_today,
            calls_period: per.calls,
            tokens_period: per.total_tokens,
            rpd_limit: null,
            tpd_limit: null,
            rpd_remaining: null,
            tpd_remaining: null,
            rpd_used_pct: null,
            tpd_used_pct: null,
            health: 'ok'
        });
    }

    const kindTodayRows = getAll(
        `SELECT kind, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(AVG(total_tokens), 0) AS avg_tokens
         FROM ai_usage_events
         WHERE provider = 'groq'
           AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', 'start of day')
         GROUP BY kind`,
        [...scopeParams]
    );
    const by_kind_today = {};
    for (const row of kindTodayRows || []) {
        by_kind_today[row.kind || 'other'] = {
            calls: Number(row.calls) || 0,
            total_tokens: Number(row.total_tokens) || 0,
            avg_tokens: Math.round(Number(row.avg_tokens) || 0)
        };
    }

    const kindPeriodRows = getAll(
        `SELECT kind, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens
         FROM ai_usage_events
         WHERE provider = 'groq'
           AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY kind
         ORDER BY calls DESC`,
        [...scopeParams, days]
    );
    const by_kind_period = {};
    for (const row of kindPeriodRows || []) {
        by_kind_period[row.kind || 'other'] = {
            calls: Number(row.calls) || 0,
            total_tokens: Number(row.total_tokens) || 0,
            prompt_tokens: Number(row.prompt_tokens) || 0,
            completion_tokens: Number(row.completion_tokens) || 0
        };
    }

    const modelRows = getAll(
        `SELECT COALESCE(model, '(unknown)') AS model,
                COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY COALESCE(model, '(unknown)')
         ORDER BY calls DESC
         LIMIT 8`,
        [...scopeParams, days]
    );
    const by_model = (modelRows || []).map((r) => ({
        model: r.model,
        calls: Number(r.calls) || 0,
        total_tokens: Number(r.total_tokens) || 0
    }));

    const hourlyRows = getAll(
        `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
                COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', 'start of day')
         GROUP BY hour
         ORDER BY hour ASC`,
        [...scopeParams]
    );
    const hourly_today = Array.from({ length: 24 }, (_, hour) => {
        const hit = (hourlyRows || []).find((r) => Number(r.hour) === hour);
        return {
            hour,
            label: `${String(hour).padStart(2, '0')}:00`,
            calls: Number(hit?.calls) || 0,
            total_tokens: Number(hit?.total_tokens) || 0
        };
    });
    const peakHour = hourly_today.reduce(
        (best, h) => (h.calls > (best?.calls || 0) ? h : best),
        null
    );

    const dailyRows = getAll(
        `SELECT date(created_at) AS day,
                COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = 'groq' AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY date(created_at)
         ORDER BY day ASC`,
        [...scopeParams, Math.min(days, 30)]
    );
    const daily_series = (dailyRows || []).map((r) => ({
        day: r.day,
        calls: Number(r.calls) || 0,
        total_tokens: Number(r.total_tokens) || 0
    }));

    const recent = getAll(
        `SELECT id, kind, model, key_slot, prompt_tokens, completion_tokens, total_tokens, success, created_at
         FROM ai_usage_events
         WHERE provider = 'groq'
           ${scopeSql}
         ORDER BY id DESC
         LIMIT 40`,
        [...scopeParams]
    );

    const avgTok = Math.round(Number(tokenSplitToday.avg_tokens) || Number(tokenSplitPeriod.avg_tokens) || 6000);
    const tokensPerFill = Math.max(2000, avgTok * 2);
    const callsPerFill = 2;
    const rpdLeft = Math.max(0, keysConfigured * limits.rpd - today.calls);
    const tpdLeft = Math.max(0, keysConfigured * limits.tpd - today.total_tokens);
    const estByRpd = keysConfigured ? Math.floor(rpdLeft / callsPerFill) : 0;
    const estByTpd = keysConfigured ? Math.floor(tpdLeft / tokensPerFill) : 0;
    const estLeft = Math.min(estByRpd, estByTpd);
    const bindingPool = estByTpd <= estByRpd ? 'tpd' : 'rpd';

    const hottest = [...by_key]
        .filter((k) => !k.unlabeled)
        .sort((a, b) => Math.max(b.tpd_used_pct || 0, b.rpd_used_pct || 0)
            - Math.max(a.tpd_used_pct || 0, a.rpd_used_pct || 0))[0];

    const report_lines = [
        `Groq autofill report · model ${activeModel} · ${keysConfigured} org key(s) · active slot ${activeSlot}`,
        `Today: ${today.calls} calls / ${today.total_tokens.toLocaleString()} tokens`
            + ` (prompt ${Number(tokenSplitToday.prompt_tokens || 0).toLocaleString()}`
            + ` · completion ${Number(tokenSplitToday.completion_tokens || 0).toLocaleString()})`
            + ` · avg ${Math.round(Number(tokenSplitToday.avg_tokens) || 0)} tok/call`
            + ` · fails ${Number(failToday?.fails) || 0}`,
        `Last 5h: ${last5h.calls} calls · Last 7d: ${last7.calls} calls / ${last7.total_tokens.toLocaleString()} tokens`
            + ` · Period ${days}d: ${period.calls} calls / ${period.total_tokens.toLocaleString()} tokens`,
        `Pool capacity: ${(keysConfigured * limits.rpd).toLocaleString()} RPD · ${(keysConfigured * limits.tpd).toLocaleString()} TPD`
            + ` · remaining ~${rpdLeft.toLocaleString()} req / ${tpdLeft.toLocaleString()} tok`,
        `Est. autofills left today: ~${estLeft} (limited by ${bindingPool.toUpperCase()};`
            + ` assumes ~${callsPerFill} calls + ~${tokensPerFill.toLocaleString()} tokens/app)`,
        peakHour && peakHour.calls
            ? `Peak hour today: ${peakHour.label} UTC (${peakHour.calls} calls)`
            : 'Peak hour today: no traffic yet',
        hottest
            ? `Hottest key: #${hottest.slot} · RPD ${hottest.rpd_used_pct}% · TPD ${hottest.tpd_used_pct}% (${hottest.health})`
            : 'Hottest key: n/a',
        Object.keys(by_kind_today).length
            ? `Kinds today: ${Object.entries(by_kind_today).map(([k, v]) => `${k}=${v.calls}`).join(', ')}`
            : 'Kinds today: none yet',
        by_model.length
            ? `Models (${days}d): ${by_model.map((m) => `${m.model} (${m.calls})`).join(', ')}`
            : 'Models: none logged yet'
    ];

    return {
        keys_configured: keysConfigured,
        active_slot: activeSlot,
        active_model: activeModel,
        limits,
        today: {
            calls: today.calls,
            total_tokens: today.total_tokens,
            prompt_tokens: Number(tokenSplitToday.prompt_tokens) || 0,
            completion_tokens: Number(tokenSplitToday.completion_tokens) || 0,
            avg_tokens: Math.round(Number(tokenSplitToday.avg_tokens) || 0),
            max_tokens: Number(tokenSplitToday.max_tokens) || 0,
            fails: Number(failToday?.fails) || 0
        },
        last_5_hours: { calls: last5h.calls, total_tokens: last5h.total_tokens },
        last_7_days: { calls: last7.calls, total_tokens: last7.total_tokens },
        period: {
            calls: period.calls,
            total_tokens: period.total_tokens,
            prompt_tokens: Number(tokenSplitPeriod.prompt_tokens) || 0,
            completion_tokens: Number(tokenSplitPeriod.completion_tokens) || 0,
            avg_tokens: Math.round(Number(tokenSplitPeriod.avg_tokens) || 0),
            max_tokens: Number(tokenSplitPeriod.max_tokens) || 0,
            fails: Number(failPeriod?.fails) || 0,
            since_days: days
        },
        by_key,
        by_kind_today,
        by_kind_period,
        by_model,
        hourly_today,
        daily_series,
        peak_hour: peakHour && peakHour.calls ? peakHour : null,
        pool: {
            calls_today: today.calls,
            tokens_today: today.total_tokens,
            rpd_capacity: keysConfigured * limits.rpd,
            tpd_capacity: keysConfigured * limits.tpd,
            rpd_remaining: rpdLeft,
            tpd_remaining: tpdLeft,
            rpd_used_pct: keysConfigured
                ? Math.min(100, Math.round((today.calls / (keysConfigured * limits.rpd)) * 100))
                : 0,
            tpd_used_pct: keysConfigured
                ? Math.min(100, Math.round((today.total_tokens / (keysConfigured * limits.tpd)) * 100))
                : 0,
            binding_limit: bindingPool,
            est_autofills_left_by_rpd: estByRpd,
            est_autofills_left_by_tpd: estByTpd,
            est_autofills_left: estLeft,
            assumed_calls_per_fill: callsPerFill,
            assumed_tokens_per_fill: tokensPerFill
        },
        report: report_lines.join('\n'),
        report_lines,
        recent: recent || [],
        model_note: 'Free-tier defaults assume openai/gpt-oss-20b (1k RPD / 200k TPD per org).'
    };
}

function getUsageSummary({ userId, profileId, sinceDays = 30 } = {}) {
    const uid = userId != null ? parseInt(userId, 10) : null;
    const days = Math.min(Math.max(parseInt(sinceDays, 10) || 30, 1), 365);
    const scopeParams = [];
    let userClause = '';
    if (Number.isInteger(uid) && uid > 0) {
        userClause = ' AND user_id = ? ';
        scopeParams.push(uid);
    }
    let profileClause = '';
    if (profileId) {
        const pid = parseInt(profileId, 10);
        if (Number.isInteger(pid) && pid > 0) {
            profileClause = ' AND profile_id = ? ';
            scopeParams.push(pid);
        }
    }
    const scopeSql = `${userClause}${profileClause}`;

    const byKindRows = getAll(
        `SELECT kind,
                COUNT(*) AS calls,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = 'minimax'
           AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', '-' || ? || ' days')
         GROUP BY kind`,
        [...scopeParams, days]
    );

    const byKind = {};
    let totalCalls = 0;
    let totalTokens = 0;
    for (const row of byKindRows || []) {
        const k = row.kind || 'other';
        const calls = Number(row.calls) || 0;
        const tokens = Number(row.total_tokens) || 0;
        byKind[k] = {
            calls,
            prompt_tokens: Number(row.prompt_tokens) || 0,
            completion_tokens: Number(row.completion_tokens) || 0,
            total_tokens: tokens
        };
        totalCalls += calls;
        totalTokens += tokens;
    }

    const today = countCalls(
        'minimax',
        `${scopeSql} AND created_at >= datetime('now', 'start of day')`,
        [...scopeParams]
    );
    const last5h = countCalls(
        'minimax',
        `${scopeSql} AND created_at >= datetime('now', '-5 hours')`,
        [...scopeParams]
    );
    const last7 = countCalls(
        'minimax',
        `${scopeSql} AND created_at >= datetime('now', '-7 days')`,
        [...scopeParams]
    );

    const kindTodayRows = getAll(
        `SELECT kind, COUNT(*) AS calls
         FROM ai_usage_events
         WHERE provider = 'minimax'
           AND success = 1
           ${scopeSql}
           AND created_at >= datetime('now', 'start of day')
         GROUP BY kind`,
        [...scopeParams]
    );
    const by_kind_today = {};
    for (const row of kindTodayRows || []) {
        by_kind_today[row.kind || 'other'] = Number(row.calls) || 0;
    }

    const recent = getAll(
        `SELECT id, kind, model, prompt_tokens, completion_tokens, total_tokens, created_at, user_id
         FROM ai_usage_events
         WHERE provider = 'minimax'
           AND success = 1
           ${scopeSql}
         ORDER BY id DESC
         LIMIT 30`,
        [...scopeParams]
    );

    const limitToday = Number(process.env.MINIMAX_CHAT_LIMIT_DAY) || null;
    const limit5h = Number(process.env.MINIMAX_CHAT_LIMIT_5H) || null;
    const limitWeek = Number(process.env.MINIMAX_CHAT_LIMIT_WEEK) || null;

    let groq = null;
    try {
        groq = getGroqUsageSummary({ userId, profileId, sinceDays: days });
    } catch (err) {
        console.warn('[ai-usage] groq summary failed:', err.message || err);
        groq = {
            keys_configured: 0,
            active_slot: 1,
            limits: groqFreeLimits(),
            today: { calls: 0, total_tokens: 0 },
            by_key: [],
            pool: { calls_today: 0, tokens_today: 0, rpd_capacity: 0, tpd_capacity: 0 }
        };
    }

    return {
        since_days: days,
        chat_counts: {
            today: today.calls,
            last_5_hours: last5h.calls,
            last_7_days: last7.calls,
            period: totalCalls,
            by_kind_today,
            by_kind_period: Object.fromEntries(
                Object.entries(byKind).map(([k, v]) => [k, v.calls || 0])
            )
        },
        chat_count: byKind.chat?.calls || 0,
        generate_chat_count: byKind.chat?.calls || 0,
        total_calls: totalCalls,
        total_tokens: totalTokens,
        by_kind: byKind,
        today: { calls: today.calls, total_tokens: today.total_tokens },
        last_5_hours: { calls: last5h.calls, total_tokens: last5h.total_tokens },
        last_7_days: { calls: last7.calls, total_tokens: last7.total_tokens },
        limits: {
            day: Number.isFinite(limitToday) && limitToday > 0 ? limitToday : null,
            hours_5: Number.isFinite(limit5h) && limit5h > 0 ? limit5h : null,
            week: Number.isFinite(limitWeek) && limitWeek > 0 ? limitWeek : null
        },
        recent: recent || [],
        groq,
        scope: Number.isInteger(uid) && uid > 0 ? 'user' : 'all'
    };
}

module.exports = {
    withUsageContext,
    currentUsageContext,
    recordUsage,
    recordAiResponse,
    recordMinimaxResponse,
    getUsageSummary,
    getGroqUsageSummary,
    KINDS
};
