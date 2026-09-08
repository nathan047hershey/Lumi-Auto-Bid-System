/**
 * Autofill Engineer v3 — multi-ATS apply fill orchestration helpers.
 * Chrome-free pieces live here for Node unit tests.
 *
 * v3 vs v2:
 * - Never skip profile fills on later pages (answersOnly only on final submit)
 * - ATS-aware settle / max pages
 * - Wait for a usable form fingerprint before filling
 * - Refill when coverage is too low
 */

export const AUTOFILL_ENGINE = 'autofill-engine-v3';
export const AUTOFILL_MAX_PAGES = 6;
export const AUTOFILL_PAGE_SETTLE_MS = 1800;
/** Was 3 — each full refill re-ran AI and stretched one bid past 10 minutes. */
export const AUTOFILL_RETRY_PER_PAGE = 2;
export const AUTOFILL_MIN_COVERAGE = 0.35;
/** Hard wall-clock budget for one bid (open → fill → submit attempt). */
export const BID_HARD_LIMIT_MS = 90000;

/** Slower SPAs (Oracle / Workday) need longer Next-page settles. */
export function settleMsForAts(ats) {
    const id = String(ats || '').toLowerCase();
    if (id === 'oracle' || id === 'workday') return 2800;
    if (id === 'icims' || id === 'smartrecruiters') return 2200;
    if (id === 'ashby' || id === 'lever') return 2000;
    return AUTOFILL_PAGE_SETTLE_MS;
}

export function maxPagesForAts(ats) {
    const id = String(ats || '').toLowerCase();
    if (id === 'oracle' || id === 'workday') return 8;
    if (id === 'icims') return 7;
    return AUTOFILL_MAX_PAGES;
}

export function formFingerprint(form) {
    if (!form || typeof form !== 'object') return '';
    const fields = Array.isArray(form.fields) ? form.fields : [];
    const files = Array.isArray(form.fileInputs) ? form.fileInputs : [];
    const body = fields
        .map((f) => `${f.id || ''}|${f.label || ''}|${f.type || ''}|${f.kind || ''}`)
        .join(';;')
        .slice(0, 2000);
    const url = String(form.url || '').split('?')[0];
    return `${url}|f${fields.length}|u${files.length}|${body}`;
}

export function formFieldCount(form) {
    if (!form || typeof form !== 'object') return 0;
    const fields = Array.isArray(form.fields) ? form.fields.length : 0;
    const files = Array.isArray(form.fileInputs) ? form.fileInputs.length : 0;
    return fields + files;
}

export function mergeAnswers(existing, incoming) {
    const byKey = new Map();
    const keyOf = (a) => {
        const id = String(a?.id || '').trim();
        if (id) return `id:${id}`;
        const label = String(a?.label || '').trim().toLowerCase();
        return label ? `label:${label}` : '';
    };
    const priorityOf = (a) => {
        const src = String(a?.match_source || a?.source || '').toLowerCase();
        if (/fill_lesson/.test(src)) return 100;
        if (src === 'hard_lock' || src === 'knockout_lock') return 95;
        if (src === 'question_memory') return 90;
        if (src === 'regex' || src === 'fixed') return 80;
        if (src === 'profile') return 70;
        if (src === 'salary') return 60;
        if (src === 'llm' || src === 'api') return 20;
        return 10;
    };
    for (const a of [...(existing || []), ...(incoming || [])]) {
        const k = keyOf(a);
        if (!k) continue;
        const prev = byKey.get(k);
        if (!prev || priorityOf(a) >= priorityOf(prev)) {
            byKey.set(k, a);
        }
    }
    return [...byKey.values()];
}

/** Normalize Instruct / lesson fill rows into answer objects. */
export function lessonFillsToAnswers(fills, source = 'fill_lesson') {
    return (Array.isArray(fills) ? fills : [])
        .map((f) => {
            const label = String(f?.label || f?.fieldLabel || f?.field_key || f?.id || '').trim();
            const answer = String(f?.answer ?? f?.value ?? '').trim();
            if (!label || !answer) return null;
            return {
                id: String(f.id || label).slice(0, 120),
                label,
                answer,
                answer_type: 'written',
                source,
                match_source: source,
                lane: f.lane || undefined
            };
        })
        .filter(Boolean);
}

export function pickNewQuestions(allQuestions, answered) {
    const answeredIds = new Set((answered || []).map((a) => String(a.id || '')));
    const answeredLabels = new Set(
        (answered || [])
            .map((a) => String(a.label || '').trim().toLowerCase())
            .filter(Boolean)
    );
    return (allQuestions || []).filter((q) => {
        const id = String(q.id || '');
        const label = String(q.label || '').trim().toLowerCase();
        if (id && answeredIds.has(id)) return false;
        if (label && answeredLabels.has(label)) return false;
        return true;
    });
}

export function shouldAdvancePage({ clickedNext, fingerprintBefore, fingerprintAfter, pages, maxPages }) {
    const limit = Number(maxPages) > 0 ? Number(maxPages) : AUTOFILL_MAX_PAGES;
    if (!clickedNext) return false;
    if (pages >= limit) return false;
    if (!fingerprintAfter) return true;
    return fingerprintAfter !== fingerprintBefore;
}

/**
 * During multi-page walk, always fill profile + answers.
 * answersOnly is only for a final submit polish pass.
 */
export function useAnswersOnlyOnPage(_pageIndex, { finalSubmitPass = false } = {}) {
    return !!finalSubmitPass;
}

/**
 * Decide whether another fill attempt is warranted on the same page.
 * fillStats.filled vs visible field count.
 */
export function shouldRefillPage({ form, fillStats, attempt, maxAttempts }) {
    const max = Number(maxAttempts) > 0 ? Number(maxAttempts) : AUTOFILL_RETRY_PER_PAGE;
    if (attempt >= max) return false;
    const total = formFieldCount(form);
    if (total <= 0) return false;
    const filled = Number(fillStats?.filled || 0) + Number(fillStats?.uploaded || 0);
    if (filled <= 0) return true;
    return filled / total < AUTOFILL_MIN_COVERAGE;
}

export function engineLabelForAts(ats) {
    const id = String(ats || 'generic').toLowerCase() || 'generic';
    return `${AUTOFILL_ENGINE}:${id}`;
}

export {
    normalizeFillStats,
    isFillIncomplete,
    canAutoSubmit,
    stableMissingLabels,
    bidLimitMsForAts,
    formWaitMsForAts,
    submitSuccessPollPlan,
    SUBMIT_SUCCESS_POLL_MS,
    FILL_VERIFY_BASE_LIMIT_MS
} from './fillVerify.js';

/**
 * Sort fields so required / select / file / consent fill first; optional essays last.
 * Pure helper for engines that walk a field list under a time budget.
 */
export function prioritizeFieldsForBudget(fields) {
    const list = Array.isArray(fields) ? [...fields] : [];
    const rank = (f) => {
        const kind = String(f?.kind || f?.type || '').toLowerCase();
        const label = String(f?.label || '').toLowerCase();
        if (f?.required) {
            if (/file|resume|cv|cover/.test(kind) || /resume|curriculum|cover\s*letter/.test(label)) return 0;
            if (/select|dropdown|combobox|radio|checkbox|consent|agree/.test(kind)) return 1;
            if (/email|phone|name|location|city|linkedin|url/.test(kind)) return 2;
            return 3;
        }
        if (/essay|textarea|long|why|cover/.test(kind) || /why (do )?you|tell us|cover letter/.test(label)) return 9;
        return 6;
    };
    return list.sort((a, b) => rank(a) - rank(b));
}
