/**
 * Gemini-only scrape rescue (NOT MiniMax).
 * Keys 1–3: Job Links scrape fallback. Key 4: reserved for other features — never used here.
 *
 * Flow: normal ATS scrape first → if fail/empty → cheap link check → Gemini extract.
 */
'use strict';

const axios = require('axios');

const SCRAPE_SLOTS = [1, 2, 3];
const RESERVED_SLOT = 4;
const MODEL_CANDIDATES = [
    process.env.GEMINI_SCRAPE_MODEL || '',
    'gemini-3.6-flash',
    'gemini-2.5-flash',
    'gemini-flash-latest'
].filter(Boolean);

let slotIndex = 0;
let lastError = null;
let lastSlotUsed = null;

function isPlaceholder(key) {
    if (!key || !String(key).trim()) return true;
    const t = String(key).trim().toLowerCase();
    return /^paste-|^your[-_]|change-me|xxx|example/.test(t);
}

function getScrapeKeys() {
    return SCRAPE_SLOTS.map((n) => {
        const raw = process.env[`GEMINI_API_KEY_${n}`];
        if (isPlaceholder(raw)) return null;
        return { slot: n, key: String(raw).trim() };
    }).filter(Boolean);
}

function getReservedKeyStatus() {
    const raw = process.env[`GEMINI_API_KEY_${RESERVED_SLOT}`];
    return {
        slot: RESERVED_SLOT,
        set: !isPlaceholder(raw),
        used_for_scrape: false
    };
}

function getStatus() {
    const keys = getScrapeKeys();
    return {
        provider: 'gemini',
        scrape_slots: SCRAPE_SLOTS,
        reserved_slot: RESERVED_SLOT,
        scrape_keys_set: keys.map((k) => k.slot),
        scrape_keys_count: keys.length,
        reserved: getReservedKeyStatus(),
        models: MODEL_CANDIDATES,
        lastError,
        lastSlotUsed
    };
}

/**
 * Cheap link liveness check (no Gemini).
 */
async function checkJobLinkAlive(url, timeoutMs = 15000) {
    if (!url || !/^https?:\/\//i.test(url)) {
        return { ok: false, reason: 'invalid_url' };
    }
    try {
        const res = await axios.get(url, {
            timeout: timeoutMs,
            maxRedirects: 5,
            validateStatus: () => true,
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml'
            },
            responseType: 'text',
            transformResponse: [(d) => d]
        });
        const status = res.status;
        if (status === 404 || status === 410 || status === 451) {
            return { ok: false, reason: `http_${status}`, status };
        }
        if (status >= 500) {
            return { ok: false, reason: `http_${status}`, status };
        }
        const body = String(res.data || '').slice(0, 80000);
        const lower = body.toLowerCase();
        if (
            /no longer available|job has been filled|position has been filled|this job is closed|page not found|couldn't find that job|job posting is no longer/i.test(
                lower
            )
        ) {
            return { ok: false, reason: 'job_closed_copy', status, htmlSnippet: body.slice(0, 4000) };
        }
        return { ok: true, status, htmlSnippet: body.slice(0, 120000) };
    } catch (err) {
        return { ok: false, reason: err.code || err.message || 'fetch_failed' };
    }
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function callGeminiGenerate(apiKey, model, prompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await axios.post(
        url,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 4096,
                responseMimeType: 'application/json'
            }
        },
        { timeout: 60000, validateStatus: () => true }
    );
    return res;
}

/**
 * Extract job fields from page HTML/text using Gemini scrape keys (1–3 only).
 */
async function geminiExtractJob({ url, html, priorError } = {}) {
    const keys = getScrapeKeys();
    if (!keys.length) {
        lastError = 'no_gemini_scrape_keys';
        return { ok: false, error: 'Gemini scrape keys not set (GEMINI_API_KEY_1..3 in local.env)' };
    }

    const text = stripHtml(html).slice(0, 24000);
    if (text.length < 40) {
        return { ok: false, error: 'page_text_too_short_for_gemini' };
    }

    const prompt = `You extract job posting fields from page text. Return ONLY JSON:
{"title":"...","company":"...","location":"...","description":"..."}
Rules:
- description must be the full job description if present (aim 200+ characters when available).
- If this is not a real open job posting, return {"error":"not_a_job"}.
- Do not invent employers or duties not in the text.
URL: ${url || ''}
Prior scrape error: ${priorError || 'none'}
PAGE TEXT:
${text}`;

    const start = slotIndex % keys.length;
    const errors = [];

    for (let i = 0; i < keys.length; i++) {
        const { slot, key } = keys[(start + i) % keys.length];
        lastSlotUsed = slot;
        for (const model of MODEL_CANDIDATES) {
            try {
                const res = await callGeminiGenerate(key, model, prompt);
                if (res.status === 429 || res.status === 503) {
                    errors.push(`slot${slot}/${model}: HTTP ${res.status}`);
                    continue; // next key/model
                }
                if (res.status === 400 && /location is not supported/i.test(JSON.stringify(res.data || {}))) {
                    lastError = 'gemini_location_blocked';
                    return {
                        ok: false,
                        error: 'Gemini blocked for this server location — use VPN (US) or another region'
                    };
                }
                if (res.status >= 400) {
                    const msg = res.data?.error?.message || `HTTP ${res.status}`;
                    errors.push(`slot${slot}/${model}: ${msg}`);
                    if (/not found|no longer available/i.test(msg)) continue;
                    if (/API_KEY|invalid|permission/i.test(msg)) continue;
                    continue;
                }
                const raw =
                    res.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
                let parsed;
                try {
                    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
                    parsed = JSON.parse(cleaned);
                } catch {
                    errors.push(`slot${slot}/${model}: bad_json`);
                    continue;
                }
                if (parsed.error) {
                    return { ok: false, error: `gemini:${parsed.error}`, slot, model };
                }
                const description = String(parsed.description || '').trim();
                if (description.length < 80) {
                    errors.push(`slot${slot}/${model}: thin_description`);
                    continue;
                }
                slotIndex = (keys.findIndex((k) => k.slot === slot) + 1) % keys.length;
                lastError = null;
                return {
                    ok: true,
                    title: String(parsed.title || '').trim() || null,
                    company: String(parsed.company || '').trim() || null,
                    location: String(parsed.location || '').trim() || null,
                    description,
                    source: 'gemini',
                    slot,
                    model
                };
            } catch (err) {
                errors.push(`slot${slot}/${model}: ${err.message}`);
            }
        }
    }

    lastError = errors.slice(0, 6).join(' | ') || 'gemini_failed';
    return { ok: false, error: lastError };
}

/**
 * After ATS scrape fails: verify link still alive, then Gemini extract.
 * Skips Gemini when disabled via env or when this process already hit
 * a geo location block (avoids repeated failed rescue noise).
 */
async function rescueFailedScrape(url, priorError) {
    if (String(process.env.JOB_LINKS_SKIP_GEMINI || '').trim() === '1') {
        return {
            ok: false,
            error: priorError || 'gemini_disabled (JOB_LINKS_SKIP_GEMINI=1)',
            skippedGemini: true
        };
    }
    if (lastError === 'gemini_location_blocked') {
        return {
            ok: false,
            error: priorError
                ? `${priorError} | gemini skipped (location blocked — use VPN or JOB_LINKS_SKIP_GEMINI=1)`
                : 'Gemini blocked for this server location — use VPN (US) or JOB_LINKS_SKIP_GEMINI=1',
            skippedGemini: true
        };
    }

    const keys = getScrapeKeys();
    if (!keys.length) {
        return {
            ok: false,
            error: priorError || 'Gemini scrape keys not set (GEMINI_API_KEY_1..3)',
            skippedGemini: true
        };
    }

    const alive = await checkJobLinkAlive(url);
    if (!alive.ok) {
        return {
            ok: false,
            error: `link-check-failed:${alive.reason}`,
            linkCheck: alive,
            skippedGemini: true
        };
    }
    const extracted = await geminiExtractJob({
        url,
        html: alive.htmlSnippet,
        priorError
    });
    if (!extracted.ok && /location is not supported|gemini_location_blocked|blocked for this server location/i.test(String(extracted.error || ''))) {
        lastError = 'gemini_location_blocked';
        return {
            ok: false,
            error: extracted.error,
            skippedGemini: true,
            linkCheck: { ok: true, status: alive.status }
        };
    }
    return { ...extracted, linkCheck: { ok: true, status: alive.status } };
}

module.exports = {
    getStatus,
    getScrapeKeys,
    checkJobLinkAlive,
    geminiExtractJob,
    rescueFailedScrape,
    SCRAPE_SLOTS,
    RESERVED_SLOT
};
