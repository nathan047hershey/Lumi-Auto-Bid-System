/**
 * Persist MiniMax (and other AI) call counts for the Analyze page.
 * Use withUsageContext() around route handlers so nested callers inherit user/kind.
 */
const { AsyncLocalStorage } = require('async_hooks');
const { runQuery, getAll, getOne } = require('../config/database');

const usageAls = new AsyncLocalStorage();

const KINDS = new Set(['chat', 'cv', 'answers', 'bidder', 'analyze', 'other']);

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
 * Record one AI call. Prefer MiniMax successes; other providers may be stored if passed.
 */
function recordUsage({
    userId,
    profileId,
    provider,
    kind,
    model,
    usage,
    success = true
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
        runQuery(
            `INSERT INTO ai_usage_events (
                user_id, profile_id, provider, kind, model,
                prompt_tokens, completion_tokens, total_tokens, success, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
                Number.isInteger(uid) && uid > 0 ? uid : null,
                Number.isInteger(pid) && pid > 0 ? pid : null,
                prov,
                k,
                model ? String(model).slice(0, 120) : null,
                tokens.prompt_tokens,
                tokens.completion_tokens,
                tokens.total_tokens,
                success ? 1 : 0
            ]
        );
    } catch (err) {
        console.warn('[ai-usage] record failed:', err.message || err);
    }
}

/** Record from an OpenAI-style chat completion response when provider is MiniMax. */
function recordMinimaxResponse(response, overrides = {}) {
    const ctx = currentUsageContext();
    const provider = String(overrides.provider || 'minimax').toLowerCase();
    if (provider !== 'minimax') return;
    const model = overrides.model
        || response?.data?.model
        || response?.config?.data?.model
        || null;
    recordUsage({
        userId: overrides.userId,
        profileId: overrides.profileId,
        provider: 'minimax',
        kind: overrides.kind || ctx.kind || 'other',
        model,
        usage: response?.data?.usage || overrides.usage,
        success: overrides.success !== false
    });
}

function countCalls(whereExtra, params) {
    const row = getOne(
        `SELECT COUNT(*) AS calls,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
         FROM ai_usage_events
         WHERE provider = 'minimax'
           AND success = 1
           ${whereExtra}`,
        params
    );
    return {
        calls: Number(row?.calls) || 0,
        total_tokens: Number(row?.total_tokens) || 0
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

    // MiniMax quota is per chat/completion call — every kind counts.
    const today = countCalls(
        `${scopeSql} AND created_at >= datetime('now', 'start of day')`,
        [...scopeParams]
    );
    const last5h = countCalls(
        `${scopeSql} AND created_at >= datetime('now', '-5 hours')`,
        [...scopeParams]
    );
    const last7 = countCalls(
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

    // Optional quota from env so the UI can show remaining (MiniMax Token Plan style).
    const limitToday = Number(process.env.MINIMAX_CHAT_LIMIT_DAY) || null;
    const limit5h = Number(process.env.MINIMAX_CHAT_LIMIT_5H) || null;
    const limitWeek = Number(process.env.MINIMAX_CHAT_LIMIT_WEEK) || null;

    return {
        since_days: days,
        // Primary: each successful MiniMax API call = 1 chat count
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
        // Back-compat fields
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
        scope: Number.isInteger(uid) && uid > 0 ? 'user' : 'all'
    };
}

function emptySummary() {
    return {
        since_days: 30,
        chat_counts: {
            today: 0,
            last_5_hours: 0,
            last_7_days: 0,
            period: 0,
            by_kind_today: {},
            by_kind_period: {}
        },
        chat_count: 0,
        generate_chat_count: 0,
        total_calls: 0,
        total_tokens: 0,
        by_kind: {},
        today: { calls: 0, total_tokens: 0 },
        last_5_hours: { calls: 0, total_tokens: 0 },
        last_7_days: { calls: 0, total_tokens: 0 },
        limits: { day: null, hours_5: null, week: null },
        recent: [],
        scope: 'user'
    };
}

module.exports = {
    withUsageContext,
    currentUsageContext,
    recordUsage,
    recordMinimaxResponse,
    getUsageSummary,
    KINDS
};
