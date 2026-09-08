const axios = require('axios');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const HTMLtoDOCX = require('html-to-docx');
const cheerio = require('cheerio');
const { getProviderConfig, getActiveProvider, getAlternateMinimaxConfig, isMinimaxQuotaError, promoteMinimaxSlot, getAlternateGroqConfig, isGroqQuotaError, promoteGroqSlot } = require('./settingsService');
const { buildContactHtml, buildContactPromptHint } = require('./resumeContactHeader');
const { polishResumeHtml, extractCareerFacts, buildCandidateBackground } = require('./resumePolishService');
const { buildCompactSystemPrompt, buildCompactUserPrompt } = require('./resumePromptBuilder');

const axiosInstance = axios.create({
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    decompress: true
});

// AI provider HTTP timeout, in milliseconds. The default is
// generous (180s) because the MiniMax-M2.7 reasoning model
// occasionally produces long-tail responses that exceed the
// previous 90s budget — every "timeout of 90000ms exceeded"
// in the resume queue was a forced-abort of an in-progress
// generation. Raise to 180s here. Admins can override via
// env: `RESUME_AI_TIMEOUT_MS=240000 node server/index.js`.
const AI_TIMEOUT_MS = Math.max(
    30_000,
    parseInt(process.env.RESUME_AI_TIMEOUT_MS || '300000', 10) || 300_000
);

// Helper: resolve the current AI provider (apiKey + apiUrl + model) per call.
// Accepts an optional `overrides` object so a call site can request a
// different model name (e.g. resume generation requests the MiniMax
// high-speed variant) without disturbing the provider's default that's used
// by chat, cover-letter, and company-name extraction.
// `overrides.provider` pins a different backend (used by Akamai fallback).
function resolveProvider(overrides) {
    const providerName = overrides && overrides.provider;
    return getProviderConfig(providerName || undefined, overrides);
}

// Detect the Akamai CDN block page (HTML body, references.edgesuite.net,
// Access Denied, Reference #...). Some providers — notably MiniMax via
// api.minimax.io — sit behind Akamai, and edge WAF rules occasionally
// reject large / long-tail request shapes with a 403 + HTML page rather
// than a JSON auth error. Returning a structured flag lets callers
// transparently retry on a fallback provider instead of bubbling a
// confusing HTML error to end users.
function isAkamaiBlock(status, body) {
    if (!body) return false;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    if (!text) return false;
    return /edgesuite\.net/i.test(text)
        || /<TITLE>\s*Access Denied\s*<\/TITLE>/i.test(text)
        || (/Reference\s*#/i.test(text) && /errors\.edgesuite\.net/i.test(text));
}

/** Strip chain-of-thought blocks from reasoning-model output. */
function stripReasoningBlocks(text) {
    let s = String(text || '');
    if (!s) return '';
    // Prefer text after a closed think block (MiniMax often puts the answer there).
    const afterClosed = s.match(
        /<\/(?:redacted_thinking|think|thinking)>\s*([\s\S]*)$/i
    );
    if (afterClosed && afterClosed[1].trim()) {
        s = afterClosed[1];
    } else {
        s = s
            .replace(/<redacted_thinking>[\s\S]*?<\/redacted_thinking>/gi, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    }
    // If think tags remain but HTML body exists, keep from first <h1>/<h2>.
    if (/<(?:think|thinking|redacted_thinking)\b/i.test(s)) {
        const htmlAt = s.search(/<h[12]\b/i);
        if (htmlAt >= 0) s = s.slice(htmlAt);
    }
    return s.trim();
}

/**
 * True only for real resume HTML — not MiniMax CoT that mentions tags while
 * debating bullet counts / system vs user priority.
 */
function looksLikeResumeHtml(html) {
    const s = String(html || '').trim();
    if (!s || s.length < 400) return false;
    if (!/<h1\b/i.test(s) || !/<h2\b/i.test(s)) return false;
    if (!/<h2[^>]*>[\s\S]{0,80}?(?:summary|skills|experience|education)/i.test(s)) return false;
    // Need real structure, not a few tags quoted in prose
    const tagCount = (s.match(/<\/?(?:h1|h2|p|ul|li|strong)\b/gi) || []).length;
    if (tagCount < 12) return false;
    // Reject chain-of-thought / meta dumps that previously leaked into CVs
    const looksLikeCot =
        /which one to follow|system instructions are higher|according to the hierarchy/i.test(s)
        || /\bthe (?:user|system) (?:says|also|originally asked|gave)\b/i.test(s)
        || /\bSo we need to (?:produce|decide|follow|craft|include)\b/i.test(s)
        || /\bKeep thinking short\b/i.test(s)
        || /\bOutput resume HTML only\b/i.test(s)
        || /\bBEGIN HTML\b/i.test(s)
        || (/\bwe (?:need to|must|should) (?:decide|produce|follow|craft|include)\b/i.test(s)
            && /MUST PASS|PRECOMPUTED|Not a chatbot brochure/i.test(s))
        || (/\blet'?s (?:aim|list|think|craft|stick to)\b/i.test(s)
            && /Core Skills|bullet/i.test(s)
            && tagCount < 40)
        || (/Tags:\s*h2,\s*p,\s*strong/i.test(s) && !/<ul\b/i.test(s))
        || (/No planning/i.test(s) && /Start with <h1>/i.test(s));
    if (looksLikeCot) return false;
    return true;
}

/** If CoT wraps a finished resume, slice from the first real <h1>. */
function extractEmbeddedResumeHtml(text) {
    const s = String(text || '');
    const idx = s.search(/<h1\b[^>]*>/i);
    if (idx < 0) return '';
    const sliced = s.slice(idx).trim();
    return looksLikeResumeHtml(sliced) ? sliced : '';
}

/** Pull resume HTML from MiniMax/OpenAI-style chat response (content or reasoning). */
function extractMessageHtml(response) {
    const choice = response?.data?.choices?.[0] || {};
    const msg = choice.message || {};
    const finish = choice.finish_reason || choice.native_finish_reason || '';
    let content = stripReasoningBlocks(msg.content || '');
    let reasoning = stripReasoningBlocks(msg.reasoning_content || '');

    if (looksLikeResumeHtml(content)) {
        return { html: content, source: 'content', finish, valid: true };
    }
    const contentEmbedded = extractEmbeddedResumeHtml(content);
    if (contentEmbedded) {
        return { html: contentEmbedded, source: 'content_embedded', finish, valid: true };
    }

    if (looksLikeResumeHtml(reasoning)) {
        console.warn('[resume] using reasoning_content (message.content had no resume HTML)');
        return { html: reasoning, source: 'reasoning_content', finish, valid: true };
    }
    const reasoningEmbedded = extractEmbeddedResumeHtml(reasoning);
    if (reasoningEmbedded) {
        console.warn('[resume] extracted HTML from reasoning_content');
        return { html: reasoningEmbedded, source: 'reasoning_embedded', finish, valid: true };
    }

    // Do NOT fall back to raw reasoning dumps — that previously saved CoT as the CV.
    console.warn(
        `[resume] no valid resume HTML (content=${content.length} reasoning=${reasoning.length} finish=${finish || '?'})`
    );
    return {
        html: content || '',
        source: content ? 'content_invalid' : 'empty',
        finish,
        valid: false
    };
}

async function makeApiCallWithRetry(requestConfig, maxRetries = 3) {
    // Allow callers to force a specific provider instead of using the
    // admin-selected active one. Used by the automatic Akamai-block
    // fallback in generateResume: when the primary provider returns an
    // Akamai block, we re-issue the request against a fallback provider
    // (typically DeepSeek) without touching the admin setting.
    const providerName = (requestConfig && requestConfig.providerOverride) || undefined;
    // Keep the model already placed on the wire (requestConfig.data.model)
    // when resolving credentials for a fallback provider.
    let provider = resolveProvider(providerName
        ? {
            provider: providerName,
            ...(requestConfig?.data?.model ? { model: requestConfig.data.model } : {})
        }
        : undefined);
    // Prefer the model the caller actually put on the wire
    // (requestConfig.data.model) — `provider.model` here is the
    // DEFAULT for the active provider, not necessarily what the caller
    // requested via the per-call override. Without this, the error
    // enrichment would log "model=MiniMax-M2.7" even when the call
    // used the MiniMax-M2.7-highspeed variant.
    const actualModel = requestConfig?.data?.model || provider.model;
    let lastError;
    let triedAltMinimaxKey = false;
    let triedAltGroqKey = false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axiosInstance.post(
                provider.apiUrl,
                requestConfig.data,
                {
                    ...requestConfig.config,
                    headers: {
                        ...(requestConfig.config?.headers || {}),
                        'Authorization': `Bearer ${provider.apiKey}`
                    }
                }
            );
            try {
                const { recordMinimaxResponse, currentUsageContext } = require('./aiUsageService');
                const ctx = currentUsageContext();
                recordMinimaxResponse(response, {
                    provider: provider.provider,
                    model: actualModel,
                    kind: requestConfig.usageKind || ctx.kind || 'other',
                    userId: requestConfig.usageUserId || ctx.userId,
                    profileId: requestConfig.usageProfileId || ctx.profileId
                });
            } catch (_) { /* usage tracking must never break AI calls */ }
            return response;
        } catch (error) {
            lastError = error;
            // Surface the upstream error body so the call-site error
            // isn't just "Request failed with status code 403" — we
            // want to see WHY (content policy, rate limit, bad model,
            // etc.) when something goes wrong.
            const upstreamBody = error.response?.data;
            if (upstreamBody) {
                error.upstreamBody = upstreamBody;
                const upstreamMsg = typeof upstreamBody === 'string'
                    ? upstreamBody
                    : (upstreamBody.error?.message
                        || upstreamBody.base_resp?.status_msg
                        || upstreamBody.message
                        || JSON.stringify(upstreamBody));
                error.upstreamMessage = upstreamMsg;
            }
            error.upstreamStatus = error.response?.status;
            error.providerName = provider.provider;
            error.modelName = actualModel;
            // Tag Akamai-style CDN blocks so callers can transparently
            // route to a fallback provider. The flag stays on the
            // thrown error when retries are exhausted.
            if (isAkamaiBlock(error.upstreamStatus, upstreamBody)) {
                error.isAkamaiBlock = true;
            }

            // MiniMax Key 1/2: if the active key is out of quota, swap to
            // the other key once instead of spinning retries on the same key.
            if (
                !triedAltMinimaxKey
                && provider.provider === 'minimax'
                && isMinimaxQuotaError(error)
            ) {
                const alt = getAlternateMinimaxConfig(provider.minimax_key_slot, {
                    model: actualModel
                });
                if (alt?.apiKey && alt.apiKey !== provider.apiKey) {
                    console.warn(
                        `[ai] MiniMax Key ${provider.minimax_key_slot} rate/quota limited; ` +
                        `retrying with Key ${alt.minimax_key_slot}`
                    );
                    try { promoteMinimaxSlot(alt.minimax_key_slot); } catch (_) { /* ignore */ }
                    provider = alt;
                    triedAltMinimaxKey = true;
                    // Re-use this attempt budget for the alternate key.
                    attempt -= 1;
                    continue;
                }
            }

            // Groq multi-key: rotate to the next key on rate/quota limits.
            if (
                !triedAltGroqKey
                && provider.provider === 'groq'
                && isGroqQuotaError(error)
            ) {
                const alt = getAlternateGroqConfig(provider.groq_key_slot, {
                    model: actualModel
                });
                if (alt?.apiKey && alt.apiKey !== provider.apiKey) {
                    console.warn(
                        `[ai] Groq Key ${provider.groq_key_slot} rate/quota limited; ` +
                        `retrying with Key ${alt.groq_key_slot}`
                    );
                    try { promoteGroqSlot(alt.groq_key_slot); } catch (_) { /* ignore */ }
                    provider = alt;
                    triedAltGroqKey = true;
                    attempt -= 1;
                    continue;
                }
            }

            const shouldRetry = error.code === 'ECONNRESET'
                || error.code === 'ETIMEDOUT'
                || error.message?.includes('timeout')
                // 429 (rate limit) and 403 (sometimes used by providers
                // as a content-policy / quota signal that succeeds on
                // the next request after a short wait) are worth retrying
                // once before bubbling the error up.
                || (error.response?.status === 429 || error.response?.status === 403);
            if (shouldRetry && attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

// Simple parser - parse bold text
function parseText(text, size = 22, font = 'Arial') {
    if (!text || typeof text !== 'string') return [new TextRun({ text: '', size, font })];

    let s = String(text).replace(/\*/g, '').trim();
    // Find **text** for bold
    const parts = s.split(/(\*\*[^*]+\*\*)/g);

    return parts.filter(p => p !== '').map(part => {
        if (part.startsWith('**') && part.endsWith('**')) {
            return new TextRun({ text: part.slice(2, -2), bold: true, size, font });
        }
        return new TextRun({ text: part, size, font });
    });
}

// ============================================================
// Section reordering
// ============================================================
// Canonical order for resume sections. Keys are matched case-insensitively
// against the inner text of each <h2> after collapsing whitespace. The AI is
// told to follow this order, but this pass guarantees consistency regardless.
const SECTION_ORDER = [
    { key: 'summary', aliases: ['summary', 'professional summary', 'profile'] },
    { key: 'skills', aliases: ['skills', 'core skills', 'technical skills', 'key skills', 'core competencies', 'technologies'] },
    { key: 'experience', aliases: ['work experience', 'experience', 'professional experience', 'employment', 'employment history', 'career history'] },
    { key: 'education', aliases: ['education', 'academic background', 'qualifications'] }
];

// Look up a heading's canonical key against SECTION_ORDER. Returns the
// key string ("summary" / "skills" / "experience" / "education") when
// the heading text matches one of the configured aliases; otherwise null
// so callers can distinguish "unknown heading" from "matched heading".
function classifySection(headingText) {
    const normalized = (headingText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) return null;
    for (const entry of SECTION_ORDER) {
        if (entry.aliases.includes(normalized)) return entry.key;
    }
    return null;
}

// Split the resume body (after <h1>+contact) into a header slice and a list
// of sections. Each section includes its opening <h2> and runs until the next
// <h2> or end of document. Sections are returned in the order they appear.
function splitResumeSections(resumeHtml) {
    // Find the first <h2> — everything before it is the "header slice" and
    // is preserved untouched (so name + contact stay first).
    const firstH2Idx = resumeHtml.search(/<h2\b/i);
    if (firstH2Idx === -1) {
        return { header: resumeHtml, sections: [] };
    }
    const header = resumeHtml.substring(0, firstH2Idx);

    // Walk through every <h2> start position. A section runs from that
    // position to the next <h2> start (or end of string).
    const h2Regex = /<h2\b[^>]*>[\s\S]*?<\/h2>/gi;
    const headings = [];
    let m;
    while ((m = h2Regex.exec(resumeHtml)) !== null) {
        headings.push({ start: m.index, end: m.index + m[0].length, html: m[0] });
    }

    const sections = [];
    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        const bodyStart = h.end;
        const bodyEnd = (i + 1 < headings.length) ? headings[i + 1].start : resumeHtml.length;
        const body = resumeHtml.substring(bodyStart, bodyEnd);
        // Extract just the visible heading text for classification.
        const innerText = h.html.replace(/<[^>]+>/g, '');
        sections.push({
            key: classifySection(innerText),
            block: h.html + body
        });
    }

    return { header, sections };
}

// Sort sections by SECTION_ORDER, with sections not mentioned in the
// preferred order still appearing in their canonical position. Sections
// whose heading didn't classify (key === null) are placed AFTER all
// known sections, preserving their original relative order so custom
// headings like "Projects" or "Certifications" still survive.
function reorderResumeSections(resumeHtml) {
    const { header, sections } = splitResumeSections(resumeHtml);
    if (sections.length === 0) return resumeHtml;

    const byKey = {};
    const unknown = [];
    for (const s of sections) {
        if (s.key) (byKey[s.key] ||= []).push(s);
        else unknown.push(s);
    }
    const CANONICAL = SECTION_ORDER.map(s => s.key);
    const ordered = [];
    for (const k of CANONICAL) {
        const arr = byKey[k];
        if (arr) ordered.push(...arr);
    }
    for (const s of sections) {
        if (!s.key) ordered.push(s);
    }
    return header + ordered.map(s => s.block).join('');
}

/** Collapse "e- commerce", then wrap letter-hyphen compounds so HTML
 *  preview / PDF cannot break mid-token. */
function protectHyphenCompoundsInHtml(html) {
    return String(html || '').replace(/(^|>)([^<]+)(?=<|$)/g, (m, lead, text) => {
        let t = text
            .replace(/([A-Za-z])[\u00AD\u2010\u2011\-]\s+([A-Za-z])/g, '$1-$2')
            .replace(/([A-Za-z])\s+[\u00AD\u2010\u2011\-]\s*([A-Za-z])/g, '$1-$2');
        // Multi-segment compounds: e-commerce, end-to-end, on-call, …
        t = t.replace(
            /\b([A-Za-z]+(?:-[A-Za-z]+)+)\b/g,
            (full) => `<span class="nbh">${full.replace(/-/g, '\u2011')}</span>`
        );
        return lead + t;
    });
}

/**
 * Remove long dashes from CV body text (em —, en –, figure ‒, bar ―).
 * Date / month ranges keep an ASCII " - ". Other long dashes become ", ".
 */
function stripLongDashesFromResumeHtml(html) {
    return String(html || '')
        .replace(/&mdash;|&#8212;|&#x2014;/gi, '\u2014')
        .replace(/&ndash;|&#8211;|&#x2013;/gi, '\u2013')
        // Year / month ranges: keep readable ASCII hyphen
        .replace(
            /((?:19|20)\d{2}|(?:0?[1-9]|1[0-2])\/(?:19|20)\d{2})\s*[-\u2013\u2014\u2012\u2015]\s*((?:19|20)\d{2}|Present|(?:0?[1-9]|1[0-2])\/(?:19|20)\d{2})/gi,
            '$1 - $2'
        )
        // Any remaining long dash used as punctuation → comma
        .replace(/\s*[\u2012\u2013\u2014\u2015]\s*/g, ', ');
}

/**
 * Force Education lines into: Degree | School | YYYY - YYYY
 * (whole line bold). Fixes common AI mistakes: school-first order,
 * bullets, missing years, city/state after school.
 */
function normalizeEducationSection(resumeHtml) {
    const { header, sections } = splitResumeSections(resumeHtml);
    if (!sections.length) return resumeHtml;

    const degreeRe = /\b(B\.?\s?S\.?|B\.?\s?A\.?|M\.?\s?S\.?|M\.?\s?A\.?|M\.?\s?Eng\.?|MBA|Ph\.?\s?D\.?|Bachelor(?:'s)?(?:\s+of\s+[A-Za-z ]+)?|Master(?:'s)?(?:\s+of\s+[A-Za-z ]+)?|Associate(?:'s)?|Doctor(?:ate)?|Diploma|BS|BA|MS|MA)\b/i;
    const uniRe = /\b(University|College|Institute|School|Academy|Polytechnic)\b/i;
    const yearRangeRe = /((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|Present)/i;

    const normalizeLine = (rawInner) => {
        const raw = String(rawInner || '');
        let text = raw
            .replace(/<\/?strong>/gi, '')
            .replace(/<\/?[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text) return null;

        const yearFrom = (s) => {
            const m = String(s || '').match(yearRangeRe);
            if (!m) return '';
            return `${m[1]} - ${/present/i.test(m[2]) ? 'Present' : m[2]}`;
        };

        // Already-normalized school | years meta line (no degree).
        const metaOnly = /\bedu-meta\b/i.test(raw)
            || (!degreeRe.test(text) && !!yearFrom(text) && uniRe.test(text))
            || (!degreeRe.test(text) && /^[^|]+\|\s*(?:19|20)\d{2}\b/.test(text));
        if (metaOnly) {
            const parts = text.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
            let school = parts[0] || text;
            let years = yearFrom(text);
            if (parts.length >= 2) {
                school = parts.slice(0, -1).join(' | ');
                years = yearFrom(parts[parts.length - 1]) || parts[parts.length - 1];
            }
            school = school.replace(yearRangeRe, '').replace(/\s+/g, ' ').trim() || school;
            if (school && years) return `<p class="edu-meta">${school} | ${years}</p>`;
            if (school) return `<p class="edu-meta">${school}</p>`;
            return null;
        }

        text = text.replace(/,\s*[A-Za-z .]+(?=\s*\||\s*$)/g, (chunk) => {
            if (uniRe.test(chunk)) return chunk;
            return '';
        }).replace(/\s+/g, ' ').trim();

        const parts = text.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
        let degree = '';
        let school = '';
        let years = '';

        if (parts.length >= 3) {
            const scored = parts.map((p) => ({
                p,
                isDegree: degreeRe.test(p),
                isSchool: uniRe.test(p),
                years: yearFrom(p)
            }));
            const yearPart = scored.find((x) => x.years) || null;
            const degreePart = scored.find((x) => x.isDegree && !x.years) || scored.find((x) => x.isDegree);
            const schoolPart = scored.find((x) => x.isSchool && x !== degreePart && x !== yearPart)
                || scored.find((x) => !x.years && x !== degreePart);
            degree = (degreePart && degreePart.p) || parts[0];
            school = (schoolPart && schoolPart.p) || parts[1];
            years = (yearPart && yearPart.years) || yearFrom(parts[parts.length - 1]) || parts[parts.length - 1];
        } else if (parts.length === 2) {
            const a = parts[0];
            const b = parts[1];
            const yB = yearFrom(b);
            if (degreeRe.test(b) && uniRe.test(a)) {
                school = a;
                degree = b;
                years = yearFrom(text);
            } else {
                degree = a;
                if (yB && uniRe.test(b)) {
                    school = b.replace(yearRangeRe, '').replace(/\s+/g, ' ').trim() || b;
                    years = yB;
                } else if (yB) {
                    school = b.replace(yearRangeRe, '').replace(/\s*[|,-]\s*$/, '').trim();
                    years = yB;
                } else {
                    school = b;
                    years = yearFrom(text);
                }
            }
        } else {
            years = yearFrom(text);
            const rest = text.replace(yearRangeRe, ' ').replace(/\s+/g, ' ').trim();
            const degIdx = rest.search(degreeRe);
            if (degIdx >= 0) {
                const afterDeg = rest.slice(degIdx);
                const uniIdx = afterDeg.search(uniRe);
                if (uniIdx > 0) {
                    degree = afterDeg.slice(0, uniIdx).replace(/\s*[|,]\s*$/, '').trim();
                    school = afterDeg.slice(uniIdx).replace(/\s*[|,]\s*$/, '').trim();
                } else {
                    degree = afterDeg.trim();
                    school = rest.slice(0, degIdx).replace(/\s*[|,]\s*$/, '').trim();
                }
            } else {
                degree = rest;
            }
        }

        degree = (degree || '').replace(/\s+/g, ' ').trim();
        school = (school || '').replace(/\s+/g, ' ').trim();
        years = (years || yearFrom(text) || '').replace(/\s+/g, ' ').trim();
        if (!degree) return null;

        // Two-line education form:
        //   Degree (bold)
        //   School                          Years
        const lines = [`<p><strong>${degree}</strong></p>`];
        if (school && years) {
            lines.push(`<p class="edu-meta">${school} | ${years}</p>`);
        } else if (school) {
            lines.push(`<p class="edu-meta">${school}</p>`);
        } else if (years) {
            lines.push(`<p class="edu-meta">${years}</p>`);
        }
        return lines.join('\n');
    };

    const fixed = sections.map((s) => {
        if (s.key !== 'education') return s.block;
        const h2Match = s.block.match(/^([\s\S]*?<h2\b[^>]*>[\s\S]*?<\/h2>)/i);
        const h2 = h2Match ? h2Match[1] : '<h2>Education</h2>';
        const body = h2Match ? s.block.slice(h2Match[1].length) : s.block;
        const lines = [];
        const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
        let m;
        while ((m = pRe.exec(body)) !== null) {
            const line = normalizeLine(m[1] != null ? m[1] : m[2]);
            if (line) lines.push(line);
        }
        if (!lines.length) return s.block;
        return `${h2}\n${lines.join('\n')}\n`;
    });

    return header + fixed.join('');
}

// ============================================================
// Company name extraction
// ============================================================
// Reject these regardless of where they came from.
const COMPANY_DENYLIST = new Set([
    'unknown', 'n/a', 'na', 'none', 'tbd', 'tba',
    'the company', 'this company', 'our client', 'your client',
    'our partner', 'this partner', 'a partner',
    'the job', 'this job', 'a company', 'an employer',
    'company', 'employer', 'client', 'confidential', 'hidden',
    'hiring manager', 'recruiter', 'various', 'multiple',
    'our team', 'this team', 'the team',
    'our client', 'our customer', 'this customer',
    // Generic single words that show up when a regex over-trims or under-trims.
    'dev', 'role', 'team', 'position', 'job', 'work', 'engineering',
    'engineer', 'developer', 'manager', 'lead', 'head', 'company'
]);

// Common English stop words. A captured name containing any of these is
// almost certainly a sentence fragment, not a company name.
const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall',
    'our', 'your', 'their', 'this', 'that', 'these', 'those', 'some',
    'any', 'all', 'no', 'not', 'only', 'own', 'same', 'so', 'than',
    'too', 'very', 'just', 'with', 'for', 'to', 'in', 'on', 'at', 'by',
    'of', 'as', 'from', 'into', 'onto', 'over', 'under', 'up', 'down',
    'out', 'off', 'about', 'above', 'below', 'across', 'through',
    'after', 'before', 'between', 'during', 'since', 'until', 'while',
    'where', 'when', 'why', 'how', 'what', 'which', 'who', 'whom',
    'whose', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
    'her', 'us', 'them', 'my', 'your', 'his', 'its', 'growing', 'looking',
    'hiring', 'seeking'
]);

const MAX_COMPANY_WORDS = 5;

// Deterministic patterns to try before paying for an LLM call.
// Inner character class deliberately OMITS '.' so sentence boundaries
// (e.g. "...System. 42Q is looking...") terminate the match cleanly.
const COMPANY_PATTERNS = [
    /\bCompany:\s*([A-Z][A-Za-z0-9&',\- ]{1,80}?)(?=[.,;\n]|$)/,
    /\bAbout\s+([A-Z][A-Za-z0-9&',\- ]{1,80}?)(?=[.,;\n]|$)/,
    /\bJoin\s+(?:us|the\s+team)\s+at\s+([A-Z][A-Za-z0-9&',\- ]{1,80}?)(?=[.,;\n]|\s+(?:as|is|for|to|with|in|where)\b|$)/,
    /\s+at\s+([A-Z][A-Za-z0-9&',\- ]{1,80}?)(?=[.,;\n]|\s+(?:is|are|was|has|seeks?|hires?|hiring|looking|now|for|to|with|in|on|as|where|and|or|if)\b|$)/,
    /\b([A-Z][A-Za-z0-9&',\- ]{1,80}?)\s+is\s+(?:looking|hiring|seeking|now\s+hiring)\b/
];

// Domains that show up in JDs (LinkedIn share links, job board URLs, ATS systems)
// but are NOT the hiring company. The DOMAIN_PATTERN skip-list is consulted first.
const GENERIC_DOMAINS = new Set([
    'linkedin', 'indeed', 'glassdoor', 'monster', 'ziprecruiter', 'dice',
    'careerbuilder', 'simplyhired', 'google', 'facebook', 'twitter', 'x',
    'youtube', 'github', 'gitlab', 'bitbucket', 'medium', 'substack',
    'lever', 'greenhouse', 'workday', 'icims', 'jobvite', 'smartrecruiters',
    'ashby', 'bamboohr', 'myworkdayjobs'
]);

const DOMAIN_PATTERN = /https?:\/\/(?:www\.)?([a-z0-9\-]+)\.(?:com|io|ai|co|org|net|health|care|tech|dev)\b/i;

/** boards.greenhouse.io/acme/jobs/123 → Acme; lever.co/acme → Acme */
function extractCompanyFromJobUrl(jobUrl) {
    if (!jobUrl || typeof jobUrl !== 'string') return '';
    try {
        const u = new URL(jobUrl.trim());
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const parts = u.pathname.split('/').filter(Boolean);
        let slug = '';
        if (host.includes('greenhouse.io') && parts.length >= 1) {
            slug = parts[0];
        } else if (host.includes('lever.co') && parts.length >= 1) {
            slug = parts[0];
        } else if (host.includes('ashbyhq.com') && parts.length >= 1) {
            slug = parts[0];
        } else if (/^([a-z0-9-]+)\.(?:applytojob|myworkdayjobs)\./i.test(host)) {
            slug = host.split('.')[0];
        }
        if (!slug || GENERIC_DOMAINS.has(slug.toLowerCase())) return '';
        if (/^(jobs?|careers?|job-boards?|boards?)$/i.test(slug)) {
            slug = parts[1] || '';
        }
        if (!slug || GENERIC_DOMAINS.has(slug.toLowerCase())) return '';
        const named = slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
        return isPlausibleCompany(named) ? named : '';
    } catch {
        return '';
    }
}

function isPlausibleCompany(raw) {
    if (!raw) return false;
    const cleaned = raw.trim();
    if (cleaned.length < 2 || cleaned.length > 60) return false;
    if (/^\d+$/.test(cleaned)) return false;
    if (!/[A-Za-z]/.test(cleaned)) return false;
    if (COMPANY_DENYLIST.has(cleaned.toLowerCase())) return false;
    // Reject bracketed placeholders like "[Company Name]" or "[Not specified]".
    if (/^\[.*\]$/.test(cleaned)) return false;
    // Reject if the name is just a single common English word (case-insensitive).
    const tokens = cleaned.split(/\s+/);
    if (tokens.length > MAX_COMPANY_WORDS) return false;
    for (const t of tokens) {
        const lower = t.toLowerCase().replace(/[^a-z]/g, '');
        if (STOPWORDS.has(lower)) return false;
    }
    return true;
}

function titleCasePreservingAcronyms(name) {
    return name
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase())
        // If a word is >= 2 consecutive uppercase letters, leave it alone.
        .replace(/\b([A-Z]{2,})\b/g, m => m); // no-op; placeholder for clarity
}

function sanitizeCompanyName(raw) {
    if (!raw) return '';
    let s = String(raw);
    // Strip code fences / tags / markdown.
    s = s.replace(/```[\s\S]*?```/g, ' ');
    s = s.replace(/<\/?[a-z][^>]*>/gi, ' ');
    s = s.replace(/[*_`~#]/g, ' ');
    // Drop leading conversational phrases the LLM likes to add.
    s = s.replace(/^\s*(?:the\s+company\s+is|company\s*[:\-]|it'?s|it\s+is|sure[,.]?|based\s+on[^,.]*,\s*|the\s+hiring\s+company\s+is)\s*/i, '');
    // Strip surrounding quotes / parens / brackets.
    s = s.replace(/^["'`(\[\{]+|["'`)\]\}]+$/g, '');
    // Keep only the first line.
    s = s.split(/\r?\n/)[0];
    // Collapse whitespace and trim.
    s = s.replace(/\s+/g, ' ').trim();
    // Strip trailing punctuation.
    s = s.replace(/[.,;:!?]+$/, '').trim();
    if (!isPlausibleCompany(s)) return '';
    // Title case unless the token contains an acronym (>=2 consecutive caps) or all-caps short word.
    const hasAcronym = /[A-Z]{2}/.test(s);
    if (!hasAcronym) s = titleCasePreservingAcronyms(s);
    return s;
}

function extractCompanyFromText(jobDescription) {
    if (!jobDescription) return '';
    // First try the labeled patterns.
    for (const re of COMPANY_PATTERNS) {
        const m = jobDescription.match(re);
        if (m && m[1]) {
            const cleaned = sanitizeCompanyName(m[1]);
            if (isPlausibleCompany(cleaned)) return cleaned;
        }
    }
    // Then a domain hint.
    const dm = jobDescription.match(DOMAIN_PATTERN);
    if (dm && dm[1] && dm[1].length >= 3) {
        const subdomain = dm[1].toLowerCase();
        if (GENERIC_DOMAINS.has(subdomain)) return '';
        // Capitalize first letter; "cohere" -> "Cohere" is what we want.
        const candidate = dm[1].charAt(0).toUpperCase() + dm[1].slice(1);
        if (isPlausibleCompany(candidate)) return candidate;
    }
    return '';
}

async function extractCompanyName(jobDescription, opts = {}) {
    const { useLlm = true } = opts;
    // 1) Deterministic pass.
    const fromText = extractCompanyFromText(jobDescription);
    if (fromText) return fromText;

    if (!useLlm) return 'Unknown';
    if (!jobDescription || !jobDescription.trim()) return 'Unknown';
    try {
        const prompt = 'Reply with ONLY the company name (1-5 words). ' +
            'No punctuation, no quotes, no explanation. ' +
            'If the company cannot be determined, reply with the single word NONE.';
        const provider = resolveProvider();
        const resp = await makeApiCallWithRetry({
            data: {
                model: provider.model,
                messages: [
                    { role: 'system', content: 'You extract company names from job descriptions. You reply with only the company name.' },
                    { role: 'user', content: prompt + '\n\nJOB DESCRIPTION:\n' + jobDescription }
                ],
                max_tokens: 30,
                temperature: 0
            },
            config: { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        });
        const raw = (resp.data.choices[0]?.message?.content || '').trim();
        if (/^none$/i.test(raw)) return 'Unknown';
        const cleaned = sanitizeCompanyName(raw);
        if (isPlausibleCompany(cleaned)) return cleaned;
    } catch (e) {
        // Fall through to Unknown below.
    }
    return 'Unknown';
}

// ============================================================
// Work mode override (Remote / Hybrid / On-site)
// ============================================================
// Rewrite the location segment of every job-title line in the generated
// resume. Job-title lines produced by the AI follow the format:
//   <p><strong>Title | Company | Location | Dates</strong></p>
// i.e. exactly three pipe separators with the location in segment #3. We
// match that shape so we never touch bullets, headings, or education lines
// (which use a slightly different pattern and are filtered by the <p><strong>
// wrapper + the date-range check).
//
// `workModes` is an array of allowed values (e.g. ['Remote','Hybrid']) and is
// applied in the order the job-title lines appear in the generated HTML —
// the AI orders jobs most-recent-first, so the first entry of `workModes`
// becomes the latest role's location. The caller is expected to put "Remote"
// first to satisfy the rule that the latest experience is always Remote.
// Any entries past the last job are unused; values outside the allowlist
// fall back to "Remote".
function pickAllowedWorkMode(value, allowed) {
    return allowed.includes(value) ? value : 'Remote';
}

function generateRandomWorkModeSchedule(jobCount, rng) {
    // Build a list of length `jobCount`. Index 0 (latest role) is forced to
    // "Remote" per the product rule. Each remaining role flips a weighted
    // coin biased toward Remote (≈70%), with Hybrid the remainder. On-site
    // is intentionally excluded — the AI almost never writes it and the
    // override would just cause noisy class breaks.
    const out = ['Remote'];
    for (let i = 1; i < jobCount; i++) {
        out.push(rng() < 0.7 ? 'Remote' : 'Hybrid');
    }
    return out;
}

function applyWorkModeOverride(resumeHtml, workModes) {
    if (!resumeHtml || typeof resumeHtml !== 'string') return resumeHtml;
    if (!Array.isArray(workModes) || workModes.length === 0) return resumeHtml;

    const allowed = ['Remote', 'Hybrid', 'On-site'];

    // First pass: count how many job-title lines exist in the document so
    // we can build a schedule of exactly the right length (and not bleed
    // extra entries into education/bullets which never match the regex).
    const jobLinePattern = /<p><strong>((?:[^<]|<(?!strong))*?)\s*\|\s*((?:[^<]|<(?!strong))*?)\s*\|\s*((?:[^<]|<(?!strong))*?)\s*\|\s*((?:[^<]|<(?!strong))*?)<\/strong><\/p>/gi;
    let jobCount = 0;
    while (jobLinePattern.exec(resumeHtml) !== null) jobCount++;

    if (jobCount === 0) return resumeHtml;

    // Build (or trim) the schedule. Caller provides intent: index 0 == most
    // recent role. We always force index 0 to "Remote" as a hard rule, even
    // if the caller hands us a different value, since "last experience
    // should be remote" is the product requirement.
    const rng = Math.random;
    let schedule = generateRandomWorkModeSchedule(jobCount, rng);
    // Honor caller overrides for indices 1..n only when they sit within the
    // allowlist and within jobCount; otherwise the generated schedule stands.
    for (let i = 1; i < Math.min(workModes.length, jobCount); i++) {
        if (allowed.includes(workModes[i])) {
            schedule[i] = workModes[i];
        }
    }
    schedule[0] = 'Remote';

    // Second pass: actually rewrite. We re-create the regex with `lastIndex`
    // resets so the closure capture works cleanly inside `replace`.
    const lineRe = /<p><strong>((?:[^<]|<(?!strong))*?)\s*\|\s*((?:[^<]|<(?!strong))*?)\s*\|\s*((?:[^<]|<(?!strong))*?)\s*\|\s*((?:[^<]|<(?!strong))*?)<\/strong><\/p>/gi;
    let idx = 0;
    return resumeHtml.replace(lineRe, (match, title, company, _location, dates) => {
        const cleanTitle = String(title).trim();
        const cleanCompany = String(company).trim();
        const cleanDates = String(dates).trim();
        if (!cleanTitle || !cleanCompany || !cleanDates) return match;
        // pickAllowedWorkMode is defensive: any unexpected value in the
        // schedule falls back to "Remote" instead of crashing the doc build.
        const mode = pickAllowedWorkMode(schedule[idx], allowed);
        idx++;
        return '<p><strong>' + cleanTitle + ' | ' + cleanCompany + ' | ' + mode + ' | ' + cleanDates + '</strong></p>';
    });
}

// Sanitize a company name for use as a filename token: letters/digits only,
// single underscores between words, no leading/trailing underscores, capped length.
function sanitizeForFilename(name, maxLen = 30) {
    if (!name) return 'Unknown';
    let s = String(name).replace(/[^A-Za-z0-9]+/g, '_');
    s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!s) return 'Unknown';
    if (s.length > maxLen) s = s.substring(0, maxLen).replace(/_+$/g, '');
    return s || 'Unknown';
}

async function generateResume(profile, jobDescription, providedCompanyName = null, options = {}) {
    try {
        // Step 1: Prefer user-provided company; avoid extra LLM call for speed.
        let companyName = (providedCompanyName && providedCompanyName.trim())
            ? providedCompanyName.trim()
            : '';
        if (!companyName || /^unknown$/i.test(companyName)) {
            // Heuristic / URL first — skip company-name LLM (saves several seconds).
            companyName = extractCompanyFromJobUrl(options.jobUrl || options.job_url || '') || '';
        }
        if (!companyName || /^unknown$/i.test(companyName)) {
            companyName = await extractCompanyName(jobDescription, { useLlm: false });
        }
        if (!companyName || /^unknown$/i.test(companyName)) {
            companyName = 'Unknown';
        }

        // Step 2: Compact prompts + precomputed career facts (speed + quality)
        const careerFacts = extractCareerFacts(profile);
        const contactHintLines = buildContactPromptHint(profile, options.styleSpec || null);
        const contactHint = contactHintLines.length
            ? contactHintLines.join('\n')
            : '(no contact fields on profile)';
        const systemPrompt = buildCompactSystemPrompt({ styleSpec: options.styleSpec || null });
        const userPrompt = buildCompactUserPrompt({
            profile,
            jobDescription,
            contactHint,
            coreSkills: options.coreSkills || '',
            facts: careerFacts,
            validationFeedback: options.validationFeedback || ''
        });
        const promptChars = systemPrompt.length + userPrompt.length;

        // Resume generation: MiniMax-M3 with thinking disabled (M2.x cannot
        // turn thinking off and often burns the whole max_tokens budget on
        // CoT → empty content + finish=length). Never invent a template CV.
        const activeProvider = getActiveProvider();
        const fastModelFor = (provider) => {
            if (provider === 'minimax') return { model: 'MiniMax-M3' };
            if (provider === 'deepseek') return { model: 'deepseek-chat' };
            return null;
        };
        const providerChain = [];
        providerChain.push({
            provider: activeProvider,
            overrides: fastModelFor(activeProvider),
            compactRetry: true,
            label: activeProvider === 'minimax' ? 'minimax-m3-compact' : `${activeProvider}-compact`
        });
        // One retry on the same model if the first pass returns CoT/empty.
        providerChain.push({
            provider: activeProvider,
            overrides: fastModelFor(activeProvider),
            compactRetry: true,
            label: activeProvider === 'minimax' ? 'minimax-m3-compact-2' : `${activeProvider}-compact-2`
        });
        const fallbackProvider = activeProvider === 'minimax' ? 'deepseek' : 'minimax';
        if (require('./settingsService').hasUsableProviderKey(fallbackProvider)) {
            providerChain.push({
                provider: fallbackProvider,
                overrides: fastModelFor(fallbackProvider),
                compactRetry: true,
                label: `${fallbackProvider}-compact`
            });
        }

        const requestPayload = (p, providerName, { disableThinking = true } = {}) => {
            const model = String(p.model || '');
            const isMinimax = providerName === 'minimax' || /minimax/i.test(model);
            const isM3 = /MiniMax-M3/i.test(model);
            const data = {
                model: p.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                // Room for HTML after any residual thinking tokens.
                max_tokens: 16000,
                max_completion_tokens: 16000,
                temperature: 0.35
            };
            if (isMinimax) {
                data.reasoning_split = true;
                // M3 supports disabling thinking; M2.x ignores this but accepts it.
                if (disableThinking && isM3) {
                    data.thinking = { type: 'disabled' };
                }
            }
            return {
                data,
                config: { headers: { 'Content-Type': 'application/json' }, timeout: AI_TIMEOUT_MS }
            };
        };

        /** When CoT fills max_tokens, continue the turn and demand HTML only. */
        async function continueForHtml(req, response, entry) {
            const choice = response?.data?.choices?.[0] || {};
            const finish = String(choice.finish_reason || choice.native_finish_reason || '');
            const msg = choice.message || {};
            const contentLen = String(msg.content || '').length;
            const reasoningLen = String(msg.reasoning_content || '').length;
            if (finish !== 'length' || contentLen > 50) return null;
            if (reasoningLen < 100 && contentLen === 0) return null;

            console.warn(
                `[resume] finish=length with empty content; continuing turn for HTML `
                + `(reasoning=${reasoningLen})`
            );
            const assistantMsg = { ...msg, role: 'assistant' };
            const contReq = {
                ...req,
                data: {
                    ...req.data,
                    messages: [
                        ...(req.data.messages || []),
                        assistantMsg,
                        {
                            role: 'user',
                            content: 'Stop thinking. Output the complete resume HTML now, starting with <h1>. No prose.'
                        }
                    ],
                    max_tokens: 12000,
                    max_completion_tokens: 12000
                }
            };
            // Keep thinking off on continuation when using M3.
            if (contReq.data.thinking) contReq.data.thinking = { type: 'disabled' };
            return makeApiCallWithRetry(contReq, 1);
        }

        let response = null;
        let usedProvider = null;
        let akamaiFallbackUsed = false;
        let extracted = null;
        const llmStartedAt = Date.now();

        for (let i = 0; i < providerChain.length; i++) {
            const entry = providerChain[i];
            const cfg = resolveProvider({
                provider: entry.provider,
                ...(entry.overrides || {})
            });

            let messages = null;
            if (entry.compactRetry) {
                const shortBg = buildCandidateBackground(profile, { maxLen: 5000 });
                const shortJd = String(jobDescription || '').slice(0, 1500);
                const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Candidate';
                const yoe = careerFacts.totalYears > 0 ? careerFacts.totalYears : null;
                const titleHint = careerFacts.currentTitle || 'Software Engineer';
                messages = [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: [
                            `Resume HTML for ${name}. Output ONLY HTML starting with <h1>.`,
                            `PRECOMPUTED: title=${titleHint}; years=${yoe != null ? yoe : 'from work history'} — copy years exactly in Summary opener.`,
                            `Contact:\n${contactHint}`,
                            `Background (use these employers/dates exactly):\n${shortBg}`,
                            `JD (tailor emphasis only):\n${shortJd}`,
                            options.coreSkills ? `Bold these stacks: ${options.coreSkills}` : '',
                            options.validationFeedback || '',
                            'Start with <h1> now. Do not explain. Do not plan.'
                        ].filter(Boolean).join('\n\n')
                    }
                ];
            }

            console.log(
                `[resume] attempt ${i + 1}/${providerChain.length} `
                + `${entry.label || entry.provider} model=${cfg.model} compact=${!!entry.compactRetry}`
            );

            const req = requestPayload(cfg, entry.provider, { disableThinking: true });
            if (messages) req.data.messages = messages;
            req.config = {
                ...(req.config || {}),
                timeout: Math.max(AI_TIMEOUT_MS, 240_000)
            };
            req.providerOverride = entry.provider;
            try {
                response = await makeApiCallWithRetry(req, 1);
                usedProvider = entry.provider;
                akamaiFallbackUsed = entry.provider !== activeProvider;
            } catch (err) {
                const isLast = i === providerChain.length - 1;
                const errBlob = String(err.code || '') + ' ' + String(err.message || '');
                const isTimeout = /timeout|ETIMEDOUT|ECONNABORTED|ECONNRESET|socket hang up|network/i.test(errBlob);
                if ((err.isAkamaiBlock || isTimeout) && !isLast) {
                    console.warn(
                        `Resume generation: '${entry.provider}' failed (${err.code || err.message}); trying next.`
                    );
                    continue;
                }
                throw err;
            }

            extracted = extractMessageHtml(response);
            if (extracted.valid === false) {
                try {
                    const cont = await continueForHtml(req, response, entry);
                    if (cont) {
                        response = cont;
                        extracted = extractMessageHtml(response);
                        console.log(
                            `[resume] after_continue source=${extracted.source} `
                            + `finish=${extracted.finish || '?'} chars=${(extracted.html || '').length} `
                            + `valid=${extracted.valid !== false}`
                        );
                    }
                } catch (contErr) {
                    console.warn('[resume] continue-for-html failed:', contErr.message || contErr);
                }
            }

            console.log(
                `[resume] raw_extract provider=${entry.provider} source=${extracted.source} `
                + `finish=${extracted.finish || '?'} chars=${(extracted.html || '').length} `
                + `valid=${extracted.valid !== false}`
            );

            if (extracted.valid !== false) break;

            if (i === providerChain.length - 1) {
                const err = new Error(
                    'Resume model returned reasoning instead of HTML. Please generate again.'
                );
                err.code = 'RESUME_REASONING_DUMP';
                throw err;
            }
            console.warn('[resume] invalid HTML; retrying');
        }
        const llmMs = Date.now() - llmStartedAt;

        let resumeHtml = (extracted && extracted.html) || '';
        if (!extracted || extracted.valid === false || !resumeHtml) {
            const err = new Error(
                'Resume model returned reasoning instead of HTML. Please generate again.'
            );
            err.code = 'RESUME_REASONING_DUMP';
            throw err;
        }

        // Strip reasoning blocks emitted by reasoning models (MiniMax-M2.7, deepseek-reasoner, etc.).
        resumeHtml = stripReasoningBlocks(resumeHtml);

        // Strip code fences if present (do this first, before parsing)
        if (resumeHtml.includes('```html')) {
            resumeHtml = resumeHtml.replace(/```html\n?/g, '').replace(/```\n?/g, '');
        }
        resumeHtml = resumeHtml.replace(/^```\w+\n?/, '').replace(/```$/, '').trim();

        // Remove any introductory text before the HTML (like "Here's a tailored...")
        // Look for the start of actual HTML content
        const htmlStartMatch = resumeHtml.match(/<!DOCTYPE html>|<html|<h1>/i);
        if (htmlStartMatch && htmlStartMatch.index > 0) {
            resumeHtml = resumeHtml.substring(htmlStartMatch.index);
        }

        // Extract body content only if it has html wrapper
        if (resumeHtml.includes('<html>') && resumeHtml.includes('</html>')) {
            const bodyMatch = resumeHtml.match(/<body>([\s\S]*)<\/body>/);
            if (bodyMatch) {
                resumeHtml = bodyMatch[1];
            }
        }

        // Convert any leftover Markdown bold syntax (**word**) to <strong>word</strong>.
        // The system prompt tells the AI to use <strong>, but models occasionally
        // emit Markdown asterisks instead (e.g. "Built **Python** microservices").
        // Convert before the document reaches either the HTML preview or the DOCX
        // builder, since both rely on <strong> for bold formatting. Multiple
        // occurrences in the same element are handled by the global flag.
        resumeHtml = resumeHtml.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');

        // -------------------------------------------------------------
        // DEDUPLICATE / UN-NEST <strong> TAGS
        // -------------------------------------------------------------
        // AI models occasionally emit nested or adjacent bold tags that
        // break the DOCX renderer and look broken in the HTML preview:
        //   - <strong><strong>Python</strong></strong>      (nested)
        //   - </strong><strong>...                          (adjacent)
        //   - <strong>Python</strong> applied twice in the
        //     same <li> for the same keyword.
        // We normalise all of these into a single <strong>...</strong>
        // per *unique word span* per <li>. The rule "bold each keyword
        // exactly once" lives in the system prompt (RULE B1/B2); this
        // pass is a safety net so even a sloppy model output still
        // produces a clean resume.
        //
        // Step 1: collapse any nested <strong>...</strong> chain so we
        // never end up with bolded-of-bolded text. Walk through the
        // document flattening <strong><strong>... into a single tag.
        // The pattern matches "<strong>...<strong>X</strong>...</strong>"
        // and unwraps the inner open/close so the outer is the only tag.
        // Repeat until no change so deeply-nested chains (3+ levels) all
        // collapse.
        let prev;
        do {
            prev = resumeHtml;
            // Match: <strong> [anything-not-strong] <strong> ... </strong> [anything-not-strong] </strong>
            // Replace with: <strong> ... </strong>
            resumeHtml = resumeHtml.replace(/<strong>([^<]*(?:<(?!(?:strong|\/strong>)[^>]*>)[^<]*)*)<strong>([\s\S]*?)<\/strong>([^<]*(?:<(?!(?:strong|\/strong>)[^>]*>)[^<]*)*)<\/strong>/gi, '<strong>$2</strong>');
        } while (resumeHtml !== prev);

        // Step 2: collapse adjacent </strong><strong>... into a single
        // <strong>...</strong>. Models sometimes emit two tags side
        // by side for the same run of text — merge them so the DOCX
        // builder doesn't see a duplicate bold span.
        do {
            prev = resumeHtml;
            resumeHtml = resumeHtml.replace(/<\/strong>(\s*)<strong>/gi, '$1');
        } while (resumeHtml !== prev);

        // Step 3: inside every <li>, find any <strong>word</strong>
        // that appears more than once and remove duplicates (keep the
        // first occurrence). This enforces "bold each keyword exactly
        // once per bullet" even if the model slipped up.
        resumeHtml = resumeHtml.replace(/<li>([\s\S]*?)<\/li>/gi, (match, inner) => {
            const seen = new Set();
            const cleaned = inner.replace(/<strong>([\s\S]*?)<\/strong>/gi, (m, text) => {
                const key = String(text).trim().toLowerCase();
                if (!key) return m;
                if (seen.has(key)) return text; // drop the duplicate <strong> wrapper
                seen.add(key);
                return m;
            });
            return '<li>' + cleaned + '</li>';
        });

        // Step 4: handle the same dedup for <p> blocks (Summary, Core
        // Skills, education lines, contact line) — same rule.
        resumeHtml = resumeHtml.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
            const seen = new Set();
            const cleaned = inner.replace(/<strong>([\s\S]*?)<\/strong>/gi, (m, text) => {
                const key = String(text).trim().toLowerCase();
                if (!key) return m;
                if (seen.has(key)) return text;
                seen.add(key);
                return m;
            });
            return '<p>' + cleaned + '</p>';
        });

        // Ensure every <li> bullet ends with a period. The AI is told to do this,
        // but models occasionally forget — this is a safety net so the resume
        // always reads as a complete sentence list. We only add a period; we
        // never strip other valid sentence-ending punctuation (! or ?).
        resumeHtml = resumeHtml.replace(/<li>([\s\S]*?)<\/li>/gi, (match, inner) => {
            const trimmed = inner.replace(/\s+$/g, '');
            const lastChar = trimmed.slice(-1);
            if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
                return '<li>' + inner + '</li>';
            }
            return '<li>' + trimmed + '.</li>';
        });

        // ----------------------------------------------------------------
        // Post-processing: normalise AI-tic punctuation; do NOT strip
        // the comma before "and" / "or".
        // ----------------------------------------------------------------
        // Earlier versions of this routine globally replaced
        // ", and" → " and" because we treated the serial comma as an
        // "AI tell". That was wrong: "X, Y, and Z" is grammatically
        // valid in American English (Chicago Manual of Style, MLA,
        // GPO, US press style, Grammarly all accept it). Stripping it
        // by force produced awkward text like "Server and worker"
        // where the original "Server, and worker" was a deliberate
        // emphasis construction the user wrote or accepted.
        //
        // What we DO still normalise:
        //   - Em-dashes / en-dashes / horizontal bars (AI tic — RULE 12b).
        //     Long dashes (—, –, ―, ‒) are stripped from CV body text.
        //     Date ranges keep an ASCII hyphen: "2010–2014" → "2010 - 2014".
        //     Other long dashes become ", ".
        //   - Unicode commas (smart-quote, fullwidth, small-form)
        //     emitted by some models — these break downstream CSS /
        //     PDF rendering.
        //   - NBSP (U+00A0) → space so words don't render stuck
        //     together.
        //
        //   "X — Y"     → "X, Y"   (em-dash → comma)
        //   "X – Y"     → "X, Y"   (en-dash aside → comma)
        //   "2010–2014" → "2010 - 2014"  (range → ASCII hyphen)
        //   "X\u201A Y" → "X, Y"   (single low-9 quote → ASCII)
        //   "X\uFF0C Y" → "X, Y"   (fullwidth comma → ASCII)
        //   "X\uFE50 Y" → "X, Y"   (small-form variant → ASCII)
        //   "X\u00A0Y"  → "X Y"    (NBSP → space)
        //
        // We deliberately DO NOT touch a normal ASCII comma before
        // "and" — that is grammatically correct in American English.

        // ----------------------------------------------------------------
        // PASS 1: Contact line integrity (RULE L1)
        // ----------------------------------------------------------------
        // Flatten accidental newlines *inside* a single contact <p>
        // (broken email/URL tokens). LinkedIn belongs on a separate <p>
        // (rebuilt from profile in PASS 4) — do not merge paragraphs.
        // Strip any <a href> / mailto the model may have added.
        const isContactLine = (text) =>
            /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)
            || /(\+?\d[\d\s().-]{7,}\d)/.test(text)
            || /(https?:\/\/|www\.|linkedin\.com|github\.com)/i.test(text)
            || /\b(?:Remote|Hybrid|On-?site)\b/i.test(text);
        resumeHtml = resumeHtml.replace(/<p>([\s\S]*?)<\/p>/gi, (m, inner) => {
            if (!isContactLine(inner)) return m;
            let flat = inner
                .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
                .replace(/mailto:/gi, '')
                .replace(/tel:/gi, '')
                .replace(/\s*\n\s*/g, ' ')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return '<p>' + flat + '</p>';
        });

        // ----------------------------------------------------------------
        // PASS 2: Compound-word line-break repair (RULE L2)
        // ----------------------------------------------------------------
        // Models occasionally emit "Spring\nBoot" or "Node\n.js"
        // when a token is too long for a perceived line width. The
        // result breaks ATS keyword parsing and looks ugly in the
        // DOCX output. Walk a known list of inseparable tokens and
        // JOIN any whitespace (including \n) between the halves.
        //
        // Two flavours of joiner:
        //   - "JOIN_WITH_SPACE" — keeps a single space between the halves
        //     (e.g. "Spring Boot", "Visual Studio Code")
        //   - "JOIN_TIGHT" — collapses all whitespace including the space
        //     around punctuation, so "Node\n.js" becomes "Node.js"
        //     (no gap between "Node" and ".js").
        const JOIN_WITH_SPACE = [
            // Spring ecosystem
            /\bSpring\s+Boot\b/g,
            /\bSpring\s+Cloud\b/g,
            // React ecosystem
            /\bReact\s+Native\b/g,
            /\bReact\s+Hooks?\b/g,
            /\bReact\s+Router\b/g,
            /\bReact\s+Redux\b/g,
            // Microsoft / tooling
            /\bVisual\s+Studio\b/g,
            /\bVisual\s+Studio\s+Code\b/g,
            // Domain terms
            /\bMachine\s+Learning\b/g,
            /\bDeep\s+Learning\b/g,
            /\bApache\s+Kafka\b/g,
            /\bFull[\s-]Stack\b/g,
            /\bBack[\s-]End\b/g,
            /\bFront[\s-]End\b/g,
            /\bOperating\s+System\b/g
        ];
        const JOIN_TIGHT = [
            // *.js / *.io / *.com / *.net — join the prefix and the dot
            // extension so "Node\n.js" becomes "Node.js" (no gap).
            /\bNode[\s\S]*?\.?\s?js\b/gi,
            /\bNext[\s\S]*?\.?\s?js\b/gi,
            /\bNuxt[\s\S]*?\.?\s?js\b/gi,
            /\bVue[\s\S]*?\.?\s?js\b/gi,
            /\bExpress[\s\S]*?\.?\s?js\b/gi,
            // Generic "<Word>.<ext>" catch-all so React.tsx, foo.com, etc.
            // also collapse any whitespace that snuck in.
            /\b([A-Z][A-Za-z0-9-]*)\s*\.\s*(js|io|com|net|ai|dev|cloud|app)\b/g
        ];
        for (const re of JOIN_WITH_SPACE) {
            resumeHtml = resumeHtml.replace(re, (match) => match.replace(/\s+/g, ' '));
        }
        for (const re of JOIN_TIGHT) {
            // Strip ALL whitespace inside the matched span — including
            // the gap between the prefix word and the dot/extension —
            // so "Node\n.js" → "Node.js" instead of "Node .js".
            resumeHtml = resumeHtml.replace(re, (match) => match.replace(/\s+/g, ''));
        }

        // ----------------------------------------------------------------
        // PASS 3: Spelled-out number -> digit (RULE L3)
        // ----------------------------------------------------------------
        // ATS keyword scanners index DIGITS, not words. The AI is
        // told to use digits but occasionally emits "six years" or
        // "forty engineers". Convert a closed list of number-words
        // back to digits so the saved resume has searchable numbers.
        const NUMBER_WORDS = {
            'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
            'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
            'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
            'fourteen': 14, 'fifteen': 15, 'sixteen': 16,
            'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
            'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
            'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90
        };
        // Match when followed by an ATS-relevant unit. Keep the unit
        // list conservative — only count tokens that the resume would
        // reasonably quantify.
        // Whitelist of units where a spelled-out number IS ATS-meaningful.
// Deliberately excludes: minutes, hours, days, weeks, months — those
// read fine as words ("six minutes") and ATS doesn't search them.
const UNIT_PATTERN = '(?:years?|yrs?|%+|percent|x|ms|s|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|projects?|bugs?|tests?|KB|MB|GB|TB|\\$|USD|uptime|core_skills?)';
        const numberWordRegex = new RegExp(
            '\\b(' + Object.keys(NUMBER_WORDS).join('|') + ')\\s+(' + UNIT_PATTERN + ')\\b',
            'gi'
        );
        const compoundRegex = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\s+(years?|months?|weeks?|days?|hours?|mins?|KB|MB|GB|projects?|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|x|times?|%|percent|ms|s)\b/gi;
        resumeHtml = resumeHtml.replace(compoundRegex, (match, tens, ones, unit) => {
            const t = NUMBER_WORDS[tens.toLowerCase()] || 0;
            const o = NUMBER_WORDS[ones.toLowerCase()] || 0;
            return (t + o) + ' ' + unit;
        });
        resumeHtml = resumeHtml.replace(numberWordRegex, (match, word, unit) => {
            const n = NUMBER_WORDS[word.toLowerCase()];
            if (n == null) return match;
            return n + ' ' + unit;
        });

        // ----------------------------------------------------------------
        // PASS 4: remove ALL long dashes from CV body (em/en/figure/bar)
        // ----------------------------------------------------------------
        resumeHtml = stripLongDashesFromResumeHtml(resumeHtml)
            .replace(/\s{2,}/g, ' ')
            .replace(/[\u201A\uFF0C\uFE50]/gi, ',')
            .replace(/\u00A0/gi, ' ');

        // FIX: Contact header — ALWAYS rebuild from PROFILE DATA
        // Line 1: address | email | phone (email is a mailto: <a>)
        // Line 2+: LinkedIn / GitHub each on their own <p> (https <a>)
        const fullName = ((profile.first_name || '') + ' ' + (profile.last_name || '')).trim();
        let h1Match = null;
        if (fullName) {
            const escapedName = fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const namePattern = new RegExp('<h1>\\s*' + escapedName + '\\s*<\\/h1>', 'i');
            h1Match = resumeHtml.match(namePattern);
        }
        if (!h1Match) {
            h1Match = resumeHtml.match(/<h1>([^<]*)<\/h1>/);
        }

        const tplSpec = options.styleSpec || null;
        const contactHtml = buildContactHtml(profile, tplSpec);
        const headerBlock = contactHtml
            ? ('<h1>' + fullName + '</h1>\n' + contactHtml)
            : (fullName ? ('<h1>' + fullName + '</h1>\n\n') : '');

        if (headerBlock) {
            if (h1Match) {
                const matchedText = h1Match[0];
                const idx = resumeHtml.indexOf(matchedText);
                if (idx >= 0) {
                    const from = idx + matchedText.length;
                    const rest = resumeHtml.substring(from);
                    // Prefer keep from first section heading (any case).
                    const h2Rel = rest.search(/<h2\b/i);
                    let after;
                    if (h2Rel >= 0) {
                        after = rest.substring(h2Rel);
                    } else {
                        // Model omitted <h2> or used another structure — NEVER
                        // drop the body. Strip only leading contact <p>s one
                        // at a time (stop at the first non-contact paragraph).
                        let cleaned = rest;
                        cleaned = cleaned.replace(/^\s+/, '');
                        while (true) {
                            const m = cleaned.match(/^<p\b[^>]*>[\s\S]*?<\/p>\s*/i);
                            if (!m) break;
                            const plain = m[0].replace(/<[^>]+>/g, ' ');
                            const isContact = /@|linkedin\.com|github\.com|https?:\/\/|\(\d{3}\)|\d{3}[-.\s]?\d{3}/i.test(plain);
                            if (!isContact) break;
                            cleaned = cleaned.slice(m[0].length);
                        }
                        after = cleaned;
                    }
                    resumeHtml = resumeHtml.substring(0, idx) + headerBlock + after;
                }
            } else if (fullName) {
                // AI didn't emit an <h1> — inject header at top.
                resumeHtml = headerBlock + resumeHtml;
            }
        }

        // Guard: if sections vanished, something went wrong — keep prior body
        // is already handled above; log when the draft is header-only.
        if (!/<h2\b/i.test(resumeHtml) && !/<ul\b/i.test(resumeHtml)) {
            console.warn(
                '[resume] draft looks header-only after contact rebuild '
                + `(html_chars=${resumeHtml.length}). Check model output / prompts.`
            );
        }

        // Reorder sections to a canonical order:
        //   Summary → Skills/Core Skills/Technical Skills → Work Experience → Education
        resumeHtml = reorderResumeSections(resumeHtml);
        resumeHtml = normalizeEducationSection(resumeHtml);

        // Override the location segment on each job-title line. The most
        // recent role is always set to "Remote"; older roles get a random
        // pick biased toward Remote (≈70%) with Hybrid the remainder. This
        // models how resumes typically read — current role remote, earlier
        // roles a mix — without any candidate-side configuration. Already-
        // generated resumes (stored in job_applications) are NOT re-processed;
        // only the resumeHtml produced by THIS call is touched.
        resumeHtml = applyWorkModeOverride(resumeHtml, ['Remote']);
        resumeHtml = protectHyphenCompoundsInHtml(resumeHtml);

        // Deterministic polish: summary opener, banned phrases, control chars, periods
        const polished = polishResumeHtml(resumeHtml, {
            profile,
            coreSkills: options.coreSkills || '',
            jobDescription: jobDescription || ''
        });
        resumeHtml = polished.html;
        const polishMs = polished.polish_ms || 0;
        const outputChars = resumeHtml.length;

        console.log(
            `[resume] llm_ms=${llmMs} polish_ms=${polishMs} prompt_chars=${promptChars} output_chars=${outputChars}`
        );

        const timing = {
            llm_ms: llmMs,
            polish_ms: polishMs,
            prompt_chars: promptChars,
            output_chars: outputChars
        };

        const bodyOk = looksLikeResumeHtml(resumeHtml)
            || ((/<h2\b/i.test(resumeHtml) || /<ul\b/i.test(resumeHtml))
                && !/which one to follow|Not a chatbot brochure/i.test(resumeHtml));
        if (!bodyOk) {
            if (!options._headerRetry) {
                console.warn('[resume] header-only or CoT draft; auto-retrying once with stronger instructions');
                return generateResume(profile, jobDescription, providedCompanyName, {
                    ...options,
                    _headerRetry: true,
                    validationFeedback: [
                        options.validationFeedback || '',
                        'CRITICAL FIX: Your previous output was HEADER ONLY or reasoning text (not a resume).',
                        'You MUST output a COMPLETE resume body with ALL of:',
                        '<h2>Summary</h2> (90+ words), <h2>Core Skills</h2>,',
                        '<h2>Work Experience</h2> with multiple <ul><li>…</li></ul> bullets per job,',
                        'and <h2>Education</h2>. Do not stop after the contact header. No planning commentary.'
                    ].filter(Boolean).join('\n')
                });
            }
            const err = new Error(
                'Resume generation returned header only (no Summary/Experience). Please regenerate.'
            );
            err.code = 'RESUME_HEADER_ONLY';
            throw err;
        }

        const styleSpec = options.styleSpec || null;
        const font = options.font || 'Arial';
        // Slot classes + header wrap so on-page preview / PDF CSS match DOCX.
        try {
            const { decorateResumeHtmlForPreview } = require('./templateRenderer');
            resumeHtml = decorateResumeHtmlForPreview(resumeHtml);
        } catch (_) { /* ignore */ }

        let previewCss = '';
        try {
            previewCss = require('./templateRenderer').buildPdfCss(styleSpec, font) || '';
        } catch (_) { /* ignore */ }

        if (options.skipDocx) {
            const filename = 'resume_' + profile.first_name + '_' + profile.last_name + '_' + sanitizeForFilename(companyName) + '_' + Date.now() + '.docx';
            return {
                resumeBuffer: null,
                resumeHtml,
                resumeText: '',
                companyName,
                filename,
                template_id: options.templateId || null,
                font_family: font,
                preview_css: previewCss,
                provider_used: usedProvider,
                fallback_used: akamaiFallbackUsed,
                ...timing
            };
        }

        // Convert HTML to DOCX. When a template style spec + font are
        // supplied, route through templateRenderer so headings, borders,
        // bullet characters, alignment, and section ordering all match
        // the template. Otherwise fall back to the legacy html-to-docx
        // path so existing callers keep working.
        const docBuffer = styleSpec
            ? await require('./templateRenderer').buildDocx({ resumeHtml, profile, styleSpec, font })
            : await htmlToDocx(resumeHtml);

        const filename = 'resume_' + profile.first_name + '_' + profile.last_name + '_' + sanitizeForFilename(companyName) + '_' + Date.now() + '.docx';
        return {
            resumeBuffer: docBuffer,
            resumeHtml: resumeHtml,
            resumeText: '',
            companyName: companyName,
            filename: filename,
            template_id: options.templateId || null,
            font_family: font,
            preview_css: previewCss,
            // Tag the response so the route handler / UI can show
            // "Generated via fallback provider" when Akamai blocked
            // the primary. Mostly diagnostic — does not change the
            // resume content.
            provider_used: usedProvider,
            fallback_used: akamaiFallbackUsed,
            ...timing
        };
    } catch (error) {
        // Build a richer error message that includes the upstream API's
        // status + body (when axios captured one) so the caller sees the
        // real cause rather than just "Request failed with status code 403".
        const parts = ['Resume failed'];
        if (error.upstreamStatus) parts.push(`(upstream ${error.upstreamStatus})`);
        if (error.providerName) parts.push(`[provider=${error.providerName}]`);
        if (error.modelName) parts.push(`[model=${error.modelName}]`);
        parts.push('-');
        if (error.upstreamMessage) parts.push(error.upstreamMessage);
        else parts.push(error.message);
        const enriched = new Error(parts.join(' '));
        enriched.upstreamStatus = error.upstreamStatus;
        enriched.upstreamBody = error.upstreamBody;
        enriched.providerName = error.providerName;
        enriched.modelName = error.modelName;
        throw enriched;
    }
}

// Convert HTML to DOCX using html-to-docx module.
// `options` (optional) accepts:
//   - font:        font family name (default 'Arial')
//   - fontSize:    half-point size for body text (default 20 = 10pt)
async function htmlToDocx(html, options = {}) {
    const font = options.font || 'Arial';
    const fontSize = options.fontSize || 20;
    // Clean special characters (ASCII control characters)
    let cleanHtml = html.replace(/[\x00-\x1F\x7F]/g, '');

    // Decode HTML entities
    cleanHtml = cleanHtml
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–');

    // Never ship long dashes into DOCX (AI tic / ATS noise)
    cleanHtml = stripLongDashesFromResumeHtml(cleanHtml);

    // Remove any class, style attributes
    cleanHtml = cleanHtml.replace(/\s+class="[^"]*"/g, '');
    cleanHtml = cleanHtml.replace(/\s+style="[^"]*"/g, '');
    cleanHtml = cleanHtml.replace(/<\/?span[^>]*>/g, '');
    cleanHtml = cleanHtml.replace(/<\/?div[^>]*>/g, '');

    // Extract name, contact, and process headings
    const nameMatch = cleanHtml.match(/<h1>([^<]+)<\/h1>/);
    const contactMatch = cleanHtml.match(/<p>([^<]+)<\/p>/);

    const name = nameMatch ? nameMatch[1] : '';
    const contact = contactMatch ? contactMatch[1] : '';

    // Make h2 headings 14pt
    cleanHtml = cleanHtml.replace(/<h2>/g, '<h2 style="font-size:14pt">');

    // Wrap in proper HTML structure - Name 16pt, Contact 10pt
    cleanHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:' + font + '">' +
      '<h1 style="text-align:center;font-size:16pt;font-family:' + font + '">' + name + '</h1>' +
      '<p style="text-align:center;font-size:10pt;font-family:' + font + '">' + contact + '</p>' +
      cleanHtml.replace(/<h1>[^<]+<\/h1>/, '').replace(/<p>[^<]+<\/p>/, '') +
      '</body></html>';

    // Convert using html-to-docx - set default font size to 10pt (20 in HIP)
    const buffer = await HTMLtoDOCX(
      cleanHtml,
      '', // headerHTMLString (empty)
      {
        margins: {
          top: 720,
          bottom: 720,
          left: 720,
          right: 720,
          header: 720,
          footer: 720,
          gutter: 0
        },
        font,
        fontSize,
        header: false,
        footer: false
      },
      ''  // footerHTMLString (empty)
    );

    return buffer;
}

// Generate HTML from resume text
function generateHtmlResume(resumeText, profile, highlightKeywords = []) {
    const lines = resumeText.split('\n');
    let html = `<html><head><style>
        body { font-family: Arial, sans-serif; margin: 1in; }
        .header { text-align: center; margin-bottom: 20px; }
        .name { font-size: 24pt; font-weight: bold; }
        .contact { font-size: 10pt; }
        h2 { border-bottom: 1px solid #000; padding-bottom: 5px; margin-top: 20px; font-size: 14pt; font-weight: bold; text-decoration: underline; }
        .job-title { font-weight: bold; font-size: 11pt; margin-top: 15px; }
        .company { font-style: italic; }
        ul { margin-left: 0; padding-left: 20px; }
        li { margin-bottom: 5px; }
        .bold { font-weight: bold; }
        .highlight { background-color: yellow; font-weight: bold; }
    </style></head><body>`;

    // Track sections
    let inHeader = false;
    let inExperience = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) continue;

        // Remove leading bullets
        line = line.replace(/^[•●\-*#]+\s*/, '').trim();

        // Check for headers
        const upperLine = line.toUpperCase().replace(/[:#]/g, '').trim();
        if (['SUMMARY', 'TECHNICAL SKILLS', 'EXPERIENCE', 'EDUCATION'].some(h => upperLine === h || upperLine === h + 'S')) {
            if (upperLine === 'EXPERIENCE') inExperience = true;
            html += `<h2>${line.replace(/[*#]/g, '')}</h2>`;
            continue;
        }

        // Header with name/contact
        if (i === 0 && !line.includes('|')) {
            html += `<div class="header"><div class="name">${profile.first_name} ${profile.last_name}</div>`;
            const { buildContactHtml: buildContact } = require('./resumeContactHeader');
            // buildContact returns <p>…</p> blocks — unwrap into the div.contact area
            const contactBlock = buildContact(profile, null)
                .replace(/<\/?p>/gi, (tag) => (tag.toLowerCase() === '<p>' ? '<div class="contact">' : '</div>'));
            html += contactBlock || '';
            html += `</div>`;
            continue;
        }

        // Skip duplicate contact
        if (profile.email && line.toLowerCase().includes(profile.email.toLowerCase())) continue;
        if (profile.linkedin_url && line.toLowerCase().includes(profile.linkedin_url.toLowerCase())) continue;
        if (line.toLowerCase() === [profile.first_name, profile.last_name].join(' ').toLowerCase()) continue;

        // Process content
        line = line.replace(/\*\*/g, ''); // Remove ** markers
        line = line.replace(/\. ([A-Z])/g, '.$1'); // Fix . NET -> .NET
        line = line.replace(/, and/g, ' and'); // Fix ", and" -> "and"

        if (line.includes('|') && line.match(/\d{4}/)) {
            // Job title line
            html += `<div class="job-title">${line}</div>`;
        } else if (inExperience && line.startsWith('-')) {
            // Bullet points
            html += `<li>${line.substring(1).trim()}</li>`;
        } else if (upperLine === 'EDUCATION' || line.match(/\d{4}.*\d{4}/)) {
            // Education
            html += `<p><strong>${line}</strong></p>`;
        } else {
            html += `<p>${line}</p>`;
        }
    }

    html += '</body></html>';
    return html;
}

function containsHighlight(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.some(kw => {
        if (kw.length < 3) return false;
        return lower.includes(kw.toLowerCase()) || kw.toLowerCase().split(/\s+/).some(word => word.length > 3 && lower.includes(word));
    });
}

function cleanSpacing(text) {
    text = text.replace(/\s+/g, ' ').trim();
    // Remove comma before "and"
    text = text.replace(/, and/g, ' and');
    // Fix patterns - but DON'T add space after . if followed by caps (like .NET)
    text = text.replace(/([a-z])([A-Z#])/g, '$1 $2');
    // Fix comma patterns
    text = text.replace(/([a-z]),([A-Z])/g, '$1, $2');
    // Handle period-space-caps: ". NET" -> ".NET" (don't space after period before capital)
    text = text.replace(/\. ([A-Z])/g, '.$1');
    return text;
}

async function convertToDocx(resumeText, profile, highlightKeywords = []) {
    const lines = resumeText.split('\n');
    const children = [];
    const headerList = ['SUMMARY', 'TECHNICAL SKILLS', 'EXPERIENCE', 'EDUCATION'];

    // Header with name/contact
    if (profile.first_name || profile.last_name) {
        const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
        children.push(new Paragraph({
            children: [new TextRun({ text: name, bold: true, size: 32, font: 'Arial' })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 }
        }));

        // Contact line - center aligned with all info
        const contact = [];
        if (profile.city || profile.state) contact.push([profile.city, profile.state].filter(Boolean).join(', '));
        if (profile.email) contact.push(profile.email);
        if (profile.phone) contact.push(profile.phone);
        if (profile.linkedin_url) contact.push(profile.linkedin_url);

        if (contact.length > 0) {
            children.push(new Paragraph({
                children: [new TextRun({ text: contact.join(' | '), size: 18, font: 'Arial' })],
                alignment: AlignmentType.CENTER,
                spacing: { after: 200 }
            }));
        }
    }

    // Track section context
    let currentSection = null;
    const seenHeaders = new Set();

    // Skip duplicate contact info from profile
    const profileEmail = profile.email?.toLowerCase() || '';
    const profilePhone = profile.phone || '';
    const profileName = [profile.first_name, profile.last_name].filter(Boolean).join(' ').toLowerCase();
    const profileLinkedIn = profile.linkedin_url?.toLowerCase() || '';

    // Parse each line
    for (let line of lines) {
        let s = line.trim();
        if (!s) continue;

        // Remove leading markers (* • ● - #)
        while (s.length > 0 && (s.startsWith('●') || s.startsWith('•') || s.startsWith('-') || s.startsWith('*') || s.startsWith('#'))) {
            s = s.substring(1).trim();
        }

        if (!s || s.length < 2) continue;

        // Skip if line is just the person's name (duplicate)
        if (s.toLowerCase() === profileName) {
            continue;
        }

        // Skip duplicate with profile LinkedIn URL
        if (profileLinkedIn && s.toLowerCase().includes(profileLinkedIn)) {
            continue;
        }
        // Also skip generic linkedin.com references not from profile
        if (!profileLinkedIn && s.toLowerCase().includes('linkedin.com')) {
            continue;
        }

        // Skip duplicate with profile contact info
        if (profileEmail && profilePhone && s.toLowerCase().includes(profileEmail) && s.toLowerCase().includes(profilePhone)) {
            continue;
        }

        // Check if header - compare after cleaning
        const cleaned = s.toUpperCase().replace(/[:#]/g, '').trim();
        let isHeader = false;
        let headerKey = null;

        for (const h of headerList) {
            if (cleaned === h || cleaned === h + 'S') {
                isHeader = true;
                headerKey = h;
                break;
            }
        }

        // Skip duplicate headers
        if (isHeader && seenHeaders.has(headerKey)) {
            continue;
        }
        if (isHeader) {
            seenHeaders.add(headerKey);
            currentSection = headerKey;
        }

        // Job title detection - line with | and date pattern
        const isJob = !isHeader && s.includes('|') && s.match(/\d{4}/);

        // Check for education with date range (YYYY - YYYY or YYYY – YYYY)
        const isEducation = currentSection === 'EDUCATION' && !isHeader && s.match(/\d{4}.*\d{4}/);

        // Render paragraph
        if (isHeader) {
            children.push(new Paragraph({
                children: [new TextRun({ text: cleaned, bold: true, underline: { color: '000000', type: 'single' }, size: 32, font: 'Arial', color: '000000' })],
                alignment: AlignmentType.LEFT,
                spacing: { before: 300, after: 100 },
                border: { bottom: { color: '000000', space: 2, size: 6, style: 'single' } }
            }));
        } else if (isJob) {
            // Job title - clean spacing, bold
            let text = cleanSpacing(s.replace(/\*\*/g, ''));

            children.push(new Paragraph({
                children: [new TextRun({ text: text, bold: true, size: 22, font: 'Arial' })],
                spacing: { before: 150, after: 50 }
            }));
        } else if (currentSection === 'EXPERIENCE' && !isHeader && !isJob) {
            // Experience details - replace all ** markers, restore proper spacing
            let cleanText = s.replace(/\*\*/g, '').trim();
            // Add spaces after punctuation
            cleanText = cleanText.replace(/([.,])([A-Za-z])/g, '$1 $2');
            // Fix common patterns like "stack,C#"
            cleanText = cleanText.replace(/([a-z])([A-Z])/g, '$1 $2');

            children.push(new Paragraph({
                children: [new TextRun({ text: cleanText, size: 20, font: 'Arial' })],
                bullet: { level: 0 },
                spacing: { after: 60 }
            }));
        } else if (isEducation) {
            // Education - bold degree name, normal dates
            const dateMatch = s.match(/(\d{4})\s*[-–]\s*(\d{4}|Present)/);
            if (dateMatch) {
                const degree = s.replace(/(\d{4})\s*[-–]\s*(\d{4}|Present)/, '').trim();
                const dates = `${dateMatch[1]} - ${dateMatch[2]}`;
                children.push(new Paragraph({
                    children: [
                        new TextRun({ text: degree, bold: true, size: 20, font: 'Arial' }),
                        new TextRun({ text: ' | ', size: 20, font: 'Arial' }),
                        new TextRun({ text: dates, size: 20, font: 'Arial' })
                    ],
                    spacing: { after: 60 }
                }));
            } else {
                children.push(new Paragraph({
                    children: [new TextRun({ text: s, size: 20, font: 'Arial' })],
                    spacing: { after: 60 }
                }));
            }
        } else if (currentSection === 'TECHNICAL SKILLS') {
            // Technical skills - use comma as separator, fix spacing
            let categoryName = null;
            let skillsPart = s;

            // Get category: try | first, then try :
            if (s.includes('|')) {
                const parts = s.split('|');
                categoryName = parts[0].replace(/\*\*/g, '').trim();
                skillsPart = parts.slice(1).join(' ').trim();
            } else if (s.includes(':')) {
                const idx = s.indexOf(':');
                categoryName = s.substring(0, idx).replace(/\*\*/g, '').trim();
                skillsPart = s.substring(idx + 1).trim();
            }

            // Clean trailing : from category
            if (categoryName && categoryName.endsWith(':')) {
                categoryName = categoryName.slice(0, -1).trim();
            }

            // Split skills by comma (and optionally ·) - use comma
            const skills = skillsPart.split(/[,·]/).map(s => s.replace(/\*\*/g, '').trim()).filter(s => s);

            let runs = [];
            if (categoryName) {
                runs.push(new TextRun({ text: categoryName + ': ', bold: true, size: 20, font: 'Arial' }));
            }

            if (skills.length > 0) {
                // Add spaces and remove comma before "and"
                skills.forEach((skill, i) => {
                    let cleanSkill = cleanSpacing(skill);

                    // Check if bold - contains keyword from job description
                    const isKeyword = containsHighlight(cleanSkill, highlightKeywords);
                    const startsBold = cleanSkill.startsWith('**');

                    runs.push(new TextRun({ text: cleanSkill.replace(/\*\*/g, ''), bold: isKeyword || startsBold, size: 20, font: 'Arial' }));
                    if (i < skills.length - 1) {
                        runs.push(new TextRun({ text: ', ', size: 20, font: 'Arial' }));
                    }
                });
            } else if (!categoryName) {
                runs.push(new TextRun({ text: s.replace(/\*\*/g, ''), size: 20, font: 'Arial' }));
            }

            if (runs.length === 0) {
                runs = [new TextRun({ text: s.replace(/\*\*/g, ''), size: 20, font: 'Arial' })];
            }

            children.push(new Paragraph({
                children: runs,
                spacing: { after: 60 }
            }));
        } else if (currentSection === 'SUMMARY' && !isHeader) {
            // Summary - clean ** markers, fix spacing, highlight keywords
            let cleanText = cleanSpacing(s.replace(/\*\*/g, ''));

            children.push(new Paragraph({
                children: [new TextRun({ text: cleanText, size: 20, font: 'Arial' })],
                spacing: { after: 100 }
            }));
        } else if (currentSection === 'EXPERIENCE' && !isHeader && !isJob) {
            // Experience - clean spacing, basic bold from job keywords
            let cleanText = cleanSpacing(s.replace(/\*\*/g, ''));

            children.push(new Paragraph({
                children: [new TextRun({ text: cleanText, size: 20, font: 'Arial' })],
                bullet: { level: 0 },
                spacing: { after: 60 }
            }));
        } else {
            // Other content - normal text
            children.push(new Paragraph({
                children: [new TextRun({ text: s, size: 20, font: 'Arial' })],
                spacing: { after: 100 }
            }));
        }
    }

    const doc = new Document({
        sections: [{
            properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
            children
        }]
    });

    return await Packer.toBuffer(doc);
}

// Generate cover letter based on profile, job description, and resume
async function generateCoverLetter(profile, jobDescription, resumeHtml, providedCompanyName = null) {
    try {
        // Company name: prefer user-supplied, otherwise try extracting from job description.
        let companyName = (providedCompanyName && providedCompanyName.trim())
            ? providedCompanyName.trim()
            : null;
        if (!companyName) {
            companyName = await extractCompanyName(jobDescription);
        }

        // Generate cover letter using AI - DO NOT include contact info in the letter
        const systemPrompt = `Generate a professional cover letter in plain text format (no HTML).

RULES:
1. Write in first person - "I am writing to express my interest..."
2. Keep it to 3-4 short paragraphs (300-400 words total)
3. Match the tone and requirements from the job description
4. Highlight relevant skills and experience from the resume
5. End with a call to action
6. Use professional business letter format

Do NOT include:
- Any HTML tags
- Contact info (address, email, phone, LinkedIn) - do NOT include this in the letter
- Placeholders like [Company Name] or [Hiring Manager]
- More than 400 words`;

        const userPrompt = `Generate a cover letter for:

JOB DESCRIPTION:
${jobDescription}

MY BACKGROUND/RESUME:
${profile.resume_prompt || 'See the resume content provided'}

Resume HTML (for reference):
${resumeHtml.substring(0, 3000)}

IMPORTANT:
- Do NOT include contact info (address, email, phone, LinkedIn) in the letter
- If company name is unknown, use a professional salutation like "Dear Hiring Manager"
- Personalize based on the job requirements
- Match keywords from the job description`;

        const provider = resolveProvider();
        const response = await makeApiCallWithRetry({
            data: { model: provider.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], max_tokens: 2000, temperature: 0.7 },
            config: { headers: { 'Content-Type': 'application/json' }, timeout: AI_TIMEOUT_MS }
        });

        let coverLetterText = response.data.choices[0]?.message?.content || '';

        // Strip reasoning blocks emitted by reasoning models (MiniMax-M2.7, deepseek-reasoner).
        coverLetterText = stripReasoningBlocks(coverLetterText);

        // Clean up any markdown or formatting artifacts
        coverLetterText = coverLetterText.replace(/```\w*/g, '').trim();

        // Convert plain text to DOCX
        const coverLetterDocx = await textToDocx(coverLetterText);

        const filename = 'cover_letter_' + profile.first_name + '_' + profile.last_name + '_' + sanitizeForFilename(companyName) + '_' + Date.now() + '.docx';

        return {
            coverLetterText,
            coverLetterDocx,
            companyName,
            filename
        };
    } catch (error) {
        throw new Error('Cover letter generation failed: ' + error.message);
    }
}

// Convert plain text to DOCX (for cover letters)
async function textToDocx(text) {
    const lines = text.split('\n');
    const children = [];

    // Parse paragraphs - groups of lines separated by blank lines
    let currentParagraph = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') {
            // Empty line - save current paragraph
            if (currentParagraph.length > 0) {
                const paragraphText = currentParagraph.join(' ');
                children.push(new Paragraph({
                    children: [new TextRun({ text: paragraphText, size: 22, font: 'Arial' })],
                    spacing: { after: 200 }
                }));
                currentParagraph = [];
            }
            continue;
        }

        // Check if this is a header line (short, uppercase-ish, or ends with colon)
        const isHeader = trimmed.length < 60 && (trimmed === trimmed.toUpperCase() || trimmed.endsWith(':'));

        if (isHeader) {
            // Save any pending paragraph first
            if (currentParagraph.length > 0) {
                const paragraphText = currentParagraph.join(' ');
                children.push(new Paragraph({
                    children: [new TextRun({ text: paragraphText, size: 22, font: 'Arial' })],
                    spacing: { after: 200 }
                }));
                currentParagraph = [];
            }

            // Add header
            children.push(new Paragraph({
                children: [new TextRun({ text: trimmed, bold: true, size: 24, font: 'Arial' })],
                spacing: { before: 300, after: 100 }
            }));
        } else {
            // Regular line - add to current paragraph
            currentParagraph.push(trimmed);
        }
    }

    // Don't forget the last paragraph
    if (currentParagraph.length > 0) {
        const paragraphText = currentParagraph.join(' ');
        children.push(new Paragraph({
            children: [new TextRun({ text: paragraphText, size: 22, font: 'Arial' })],
            spacing: { after: 200 }
        }));
    }

    const doc = new Document({
        sections: [{
            properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
            children: children
        }]
    });

    return await Packer.toBuffer(doc);
}

// ============================================================
// Fetch job details from a URL
// ============================================================

/**
 * Convert an absolute URL string into an origin (scheme + host + port).
 * Returns an empty string if the URL is malformed. Used for allowlisting.
 */
function getUrlOrigin(url) {
    try {
        const u = new URL(url);
        if (!['http:', 'https:'].includes(u.protocol)) return '';
        return `${u.protocol}//${u.host}`;
    } catch (_) {
        return '';
    }
}

/**
 * Extract readable text from a Job-board HTML payload.
 *
 * Strategy:
 *   1. Drop non-content tags (<script>, <style>, <noscript>, <iframe>, etc.)
 *   2. Prefer the most likely "job description" container if we can detect one
 *      by class/id hints (LinkedIn, Greenhouse, Lever, Indeed, Workday, …).
 *   3. Fall back to the rest of the body text.
 *   4. Whitespace-normalize and clamp to MAX_CHARS to avoid runaway content.
 *
 * Returns the cleaned text along with the <title> as a hint for AI naming.
 */
function htmlToReadableText(html) {
    if (!html || typeof html !== 'string') {
        return { title: '', description: '' };
    }
    let $;
    try {
        $ = cheerio.load(html);
    } catch (_) {
        return { title: '', description: '' };
    }

    const title =
        ($('title').first().text() || '').replace(/\s+/g, ' ').trim() ||
        ($('meta[property="og:title"]').attr('content') || '').trim() ||
        ($('meta[name="twitter:title"]').attr('content') || '').trim();

    // Remove noise
    $('script, style, noscript, iframe, svg, canvas, picture, header nav, aside, footer, form, button, input, select, textarea').remove();

    // Try to find the most likely job description container. The selectors
    // below are best-effort hints for popular boards; nothing fails if
    // none match because we fall back to <body>.
    const JD_SELECTORS = [
        // Class / id hints
        '#job-description',
        '.job-description',
        '#job-description-container',
        '.jobDescription',
        '.job_description',
        '.job-details',
        '.job-detail',
        '.job-body',
        '.job-posting',
        '.job-posting-content',
        '.job-content',
        '[itemprop="description"]',
        '[data-testid="job-description"]',
        '[data-automation="job-description"]',
        // Greenhouse
        '#content .content',
        '.opening',
        // Lever
        '.posting-page',
        // LinkedIn (job view)
        '.show-more-less-html__markup',
        '.description__text',
        '.jobs-description__content',
        // Workday
        '[data-automation-id="jobPostingDescription"]',
        // Indeed
        '#jobDescriptionText',
        '.jobsearch-JobComponent-description',
        // Generic article
        'article',
        'main'
    ];

    let description = '';
    for (const sel of JD_SELECTORS) {
        const node = $(sel).first();
        if (node.length && node.text().trim().length > 80) {
            description = node.text();
            break;
        }
    }
    if (!description) {
        description = $('body').text() || '';
    }

    // Whitespace-normalize
    description = description
        .replace(/[\u00A0\u200b\u202f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Clamp
    const MAX_CHARS = 8000;
    if (description.length > MAX_CHARS) {
        description = description.slice(0, MAX_CHARS);
    }

    return { title, description };
}

/**
 * Ask the active AI provider to derive `company_name`, `job_role`, and
 * `core_skills` from a (potentially noisy) raw job-description string. Falls
 * back to empty strings on any failure so the caller can still surface the
 * raw text.
 */
async function aiExtractJobMetadataFromText(jobDescription, hint = {}) {
    if (!jobDescription || !jobDescription.trim()) {
        return { company_name: '', job_role: '', core_skills: [] };
    }
    const { apiUrl, apiKey, model } = resolveProvider();

    const systemPrompt =
        'You extract structured job-posting metadata. Reply with strict JSON only. ' +
        'No prose, no markdown fences, no explanations.';

    const userPrompt = `From the JOB POSTING TEXT below, extract:
  - "company_name": a single best-guess company name string ("" if truly unknown)
  - "job_role": the single most likely job title / role string ("" if truly unknown)
  - "core_skills": a short array of 3-8 specific technical or professional skills required, lowercase tokens

Title hint (from HTML): ${JSON.stringify(hint.title || '')}

Rules:
  - Prefer explicit text over inference.
  - For company_name, ignore generic platforms ("LinkedIn", "Indeed", etc.).
  - For job_role, return the title a recruiter would post, not internal job codes.
  - For core_skills, keep tokens short and reusable: ["react", "typescript", "aws", ...]
  - Keep the array length between 3 and 8.

Return JSON with that exact shape.

JOB POSTING TEXT:
"""${jobDescription.slice(0, 6000)}"""`;

    try {
        const resp = await makeApiCallWithRetry({
            data: {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 300,
                temperature: 0
            },
            config: { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        });

        let raw = (resp.data.choices?.[0]?.message?.content || '').trim();
        // Tolerate occasional ```json … ``` wrappers
        raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? jsonMatch[0] : raw;
        const obj = JSON.parse(jsonText);

        const company_name = typeof obj.company_name === 'string'
            ? obj.company_name.trim().slice(0, 120)
            : '';
        const job_role = typeof obj.job_role === 'string'
            ? obj.job_role.trim().slice(0, 200)
            : '';
        let core_skills = Array.isArray(obj.core_skills) ? obj.core_skills : [];
        core_skills = core_skills
            .filter(s => typeof s === 'string')
            .map(s => s.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 8);
        return { company_name, job_role, core_skills };
    } catch (e) {
        console.error('[aiExtractJobMetadataFromText] failed:', e.message || e);
        return { company_name: '', job_role: '', core_skills: [] };
    }
}

// (No scrape/AI fetch helper here on purpose: looking up by URL is the
//  simplest, most reliable way to fill the resume-generation form from a
//  previously-pasted job link. The lookup route lives in routes/user.js.)

async function buildResumeDocx({ resumeHtml, profile, styleSpec, font = 'Arial' }) {
    if (styleSpec) {
        return require('./templateRenderer').buildDocx({ resumeHtml, profile, styleSpec, font });
    }
    return htmlToDocx(resumeHtml);
}

module.exports = {
    generateResume,
    buildResumeDocx,
    convertToDocx,
    generateCoverLetter,
    extractCompanyName,
    extractCompanyFromJobUrl,
    sanitizeForFilename,
    stripLongDashesFromResumeHtml,
    polishResumeHtml,
    extractCareerFacts,
    // test helpers
    _looksLikeResumeHtml: looksLikeResumeHtml,
    _extractMessageHtml: extractMessageHtml
};