/**
 * Analyze page: bid-course state snapshot + MiniMax narrative analysis.
 */
const axios = require('axios');
const { listCoursesForUser, listCoursesAll } = require('./bidCourseService');
const { getProviderConfig } = require('./settingsService');
const { recordMinimaxResponse, withUsageContext } = require('./aiUsageService');

const analyzeCooldownMs = 30 * 1000;
const lastAnalyzeAt = new Map();

const STUCK_RE = /needs_manual|needs_captcha|captcha|no_form|ai_failed|login_wall|fill_failed|blocked_ats|open_failed/i;

function summarizeRows(rows) {
    const summary = {
        total: rows.length,
        unknown: 0,
        applied: 0,
        interview: 0,
        rejected: 0,
        stuck: 0
    };
    const compactRows = rows.map((c) => {
        const outcome = String(c.outcome || 'unknown');
        if (summary[outcome] != null) summary[outcome] += 1;
        else summary.unknown += 1;
        const lastEvent = c.last_event_type || null;
        const stuck = lastEvent && STUCK_RE.test(lastEvent);
        if (stuck) summary.stuck += 1;
        return {
            id: c.id,
            application_id: c.application_id,
            user_id: c.user_id || null,
            user_username: c.user_username || null,
            company_name: c.company_name || '',
            job_role: c.job_role || '',
            outcome,
            last_event_type: lastEvent,
            stuck: !!stuck,
            started_at: c.started_at || null,
            filled_at: c.filled_at || null,
            applied_at: c.applied_at || null,
            cv_provider: c.cv_provider || null,
            answers_provider: c.answers_provider || null,
            answers_model: c.answers_model || null
        };
    });
    const applied = summary.applied + summary.interview + summary.rejected;
    summary.interview_rate = applied > 0
        ? Math.round((summary.interview / applied) * 1000) / 10
        : null;
    return { summary, rows: compactRows };
}

function buildBidSnapshot({ userId, profileId, limit = 100, allUsers = false } = {}) {
    const rows = allUsers
        ? listCoursesAll({ limit })
        : listCoursesForUser(userId, { profileId, limit });
    return summarizeRows(rows);
}

function stripReasoning(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function runBidAnalysis({ userId, profileId, allUsers = false } = {}) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid <= 0) {
        throw new Error('user_id required');
    }

    const cooldownKey = allUsers ? `admin:${uid}` : String(uid);
    const prev = lastAnalyzeAt.get(cooldownKey) || 0;
    const wait = analyzeCooldownMs - (Date.now() - prev);
    if (wait > 0) {
        const err = new Error(`Please wait ${Math.ceil(wait / 1000)}s before running another analysis`);
        err.status = 429;
        err.retryAfterSec = Math.ceil(wait / 1000);
        throw err;
    }

    const snapshot = buildBidSnapshot({
        userId: uid,
        profileId,
        limit: allUsers ? 120 : 80,
        allUsers
    });
    if (!snapshot.rows.length) {
        return {
            analysis: 'No bid courses logged yet. Generate a CV, fill a form, or run Auto Bidder — courses will appear here for analysis.',
            generated_at: new Date().toISOString(),
            snapshot_summary: snapshot.summary,
            provider: null,
            model: null
        };
    }

    const systemPrompt = `You analyze a job applicant's bid-course outcomes.
Write 4–7 short bullet points (plain text, each starting with "- ").
Be specific to the data. Cover: outcome mix, stuck/manual issues, what to fix next, and one clear action.
No fluff, no markdown headings, no inventing companies not in the data.`;

    const userPrompt = `BID SNAPSHOT JSON:
${JSON.stringify({ summary: snapshot.summary, sample: snapshot.rows.slice(0, 40) }, null, 2)}

Summarize the current bid state and what to improve.`;

    const provider = getProviderConfig();
    let response;
    try {
        response = await withUsageContext(
            { userId: uid, profileId, kind: 'analyze' },
            async () => {
                let active = provider;
                try {
                    return await axios.post(active.apiUrl, {
                        model: active.model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userPrompt }
                        ],
                        max_tokens: 600,
                        temperature: 0.4
                    }, {
                        headers: {
                            Authorization: `Bearer ${active.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 60000
                    });
                } catch (err) {
                    const { isMinimaxQuotaError, getAlternateMinimaxConfig, promoteMinimaxSlot } = require('./settingsService');
                    if (active.provider === 'minimax' && isMinimaxQuotaError(err)) {
                        const alt = getAlternateMinimaxConfig(active.minimax_key_slot, { model: active.model });
                        if (alt?.apiKey && alt.apiKey !== active.apiKey) {
                            try { promoteMinimaxSlot(alt.minimax_key_slot); } catch (_) { /* ignore */ }
                            active = alt;
                            return axios.post(active.apiUrl, {
                                model: active.model,
                                messages: [
                                    { role: 'system', content: systemPrompt },
                                    { role: 'user', content: userPrompt }
                                ],
                                max_tokens: 600,
                                temperature: 0.4
                            }, {
                                headers: {
                                    Authorization: `Bearer ${active.apiKey}`,
                                    'Content-Type': 'application/json'
                                },
                                timeout: 60000
                            });
                        }
                    }
                    throw err;
                }
            }
        );
    } catch (err) {
        const status = err.response?.status || err.status;
        const upstream = err.response?.data?.error?.message
            || err.response?.data?.base_resp?.status_msg
            || err.response?.data?.message
            || err.message;
        if (status === 429 || /rate limit|quota|usage limit/i.test(String(upstream || ''))) {
            const e = new Error(
                'MiniMax rate/quota limit hit. Wait a bit, or switch to Key 1/2 in Admin Settings, then try again.'
            );
            e.status = 429;
            e.retryAfterSec = 60;
            throw e;
        }
        const e = new Error(upstream || 'MiniMax analysis failed');
        e.status = status && status >= 400 ? status : 500;
        throw e;
    }

    recordMinimaxResponse(response, {
        provider: provider.provider,
        model: provider.model,
        kind: 'analyze',
        userId: uid,
        profileId
    });

    lastAnalyzeAt.set(cooldownKey, Date.now());

    const analysis = stripReasoning(response.data?.choices?.[0]?.message?.content || '');
    if (!analysis) {
        throw new Error('MiniMax returned empty analysis');
    }

    return {
        analysis,
        generated_at: new Date().toISOString(),
        snapshot_summary: snapshot.summary,
        provider: provider.provider,
        model: provider.model
    };
}

module.exports = {
    buildBidSnapshot,
    runBidAnalysis
};
