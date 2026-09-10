/**
 * Pre-submit application checkout via Groq.
 * Reviews filled form fields + drafted answers; blocks auto-submit when critical issues remain.
 */
const axios = require('axios');
const { getAnswersGroqRescueConfig } = require('./settingsService');

function checkoutEnabled() {
    const v = String(process.env.APPLICATION_CHECKOUT_GROQ || '1').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

function stripReasoning(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();
}

function compactFields(fields) {
    return (Array.isArray(fields) ? fields : [])
        .map((f) => {
            const label = String(f.label || f.name || f.id || '').trim().slice(0, 160);
            const value = String(f.value ?? f.answer ?? '').trim().slice(0, 400);
            const required = !!(f.required || f.ariaRequired);
            const empty = !value;
            if (!label && empty) return null;
            return {
                id: String(f.id || label).slice(0, 80),
                label: label || '(untitled)',
                value: value || '',
                required,
                empty
            };
        })
        .filter(Boolean)
        .slice(0, 80);
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped?: boolean,
 *   reason?: string,
 *   issues: Array<{ severity: string, field?: string, message: string }>,
 *   fix_answers: Array<{ id?: string, label: string, answer: string }>,
 *   summary?: string,
 *   provider?: string,
 *   model?: string
 * }>}
 */
async function checkApplicationCheckout({
    fields = [],
    missingRequired = [],
    answers = [],
    companyName = '',
    jobRole = '',
    ats = ''
} = {}) {
    if (!checkoutEnabled()) {
        return { ok: true, skipped: true, reason: 'checkout_disabled', issues: [], fix_answers: [] };
    }

    const groq = getAnswersGroqRescueConfig();
    if (!groq?.apiKey) {
        return { ok: true, skipped: true, reason: 'no_groq_keys', issues: [], fix_answers: [] };
    }

    const snapshot = compactFields(fields);
    const missing = (Array.isArray(missingRequired) ? missingRequired : [])
        .map((m) => String(m || '').trim())
        .filter(Boolean)
        .slice(0, 20);
    const answerRows = (Array.isArray(answers) ? answers : [])
        .map((a) => ({
            id: a.id || undefined,
            label: String(a.label || '').slice(0, 160),
            answer: String(a.answer || a.value || '').slice(0, 400)
        }))
        .filter((a) => a.label || a.answer)
        .slice(0, 40);

    // Fast path: required missing → fail without burning Groq if list is clear.
    const emptyRequired = snapshot.filter((f) => f.required && f.empty);
    if (missing.length >= 3 || emptyRequired.length >= 3) {
        return {
            ok: false,
            skipped: false,
            reason: 'required_incomplete',
            issues: [
                ...missing.slice(0, 8).map((m) => ({
                    severity: 'critical',
                    field: m,
                    message: `Required field still empty: ${m}`
                })),
                ...emptyRequired.slice(0, 8).map((f) => ({
                    severity: 'critical',
                    field: f.label,
                    message: `Required field empty: ${f.label}`
                }))
            ].slice(0, 12),
            fix_answers: [],
            summary: 'Required fields incomplete — do not submit yet.',
            provider: 'local',
            model: null
        };
    }

    const system = `You QA a filled job application form right before Submit.
Decide if it is safe to auto-submit.
Critical issues (must block submit): empty required fields, wrong Yes/No on sponsorship/work-auth when clearly inconsistent, option answers that do not match listed choices, blank screening questions that look required.
Warnings (ok to submit but note): minor wording, optional empties.
If a written/choice answer is wrong, include a fix in fix_answers with the field label and corrected answer.
Return JSON only:
{"ok":true|false,"summary":"...","issues":[{"severity":"critical|warning","field":"...","message":"..."}],"fix_answers":[{"id":"...","label":"...","answer":"..."}]}`;

    const user = {
        ats: ats || '',
        company: companyName || '',
        role: jobRole || '',
        missing_required_hints: missing,
        fields: snapshot,
        drafted_answers: answerRows
    };

    try {
        const response = await axios.post(groq.apiUrl, {
            model: groq.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: JSON.stringify(user, null, 2) }
            ],
            max_tokens: 1200,
            temperature: 0.1
        }, {
            headers: {
                Authorization: `Bearer ${groq.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        });

        try {
            const { recordAiResponse } = require('./aiUsageService');
            recordAiResponse(response, {
                provider: 'groq',
                model: groq.model,
                kind: 'checkout',
                keySlot: groq.groq_key_slot
            });
        } catch (_) { /* ignore */ }

        const raw = stripReasoning(String(response.data?.choices?.[0]?.message?.content || ''));
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                ok: missing.length === 0 && emptyRequired.length === 0,
                skipped: false,
                reason: 'groq_parse_empty',
                issues: [],
                fix_answers: [],
                summary: 'Checkout parse failed — relying on required-field heuristics.',
                provider: groq.provider,
                model: groq.model
            };
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch (_) {
            parsed = {};
        }

        const issues = Array.isArray(parsed.issues)
            ? parsed.issues.map((i) => ({
                severity: /critical/i.test(String(i.severity || '')) ? 'critical' : 'warning',
                field: String(i.field || '').slice(0, 160),
                message: String(i.message || '').slice(0, 300)
            })).slice(0, 20)
            : [];
        const fix_answers = Array.isArray(parsed.fix_answers)
            ? parsed.fix_answers.map((a) => ({
                id: a.id || undefined,
                label: String(a.label || '').slice(0, 160),
                answer: String(a.answer || '').slice(0, 800)
            })).filter((a) => a.answer && (a.label || a.id)).slice(0, 15)
            : [];

        const hasCritical = issues.some((i) => i.severity === 'critical')
            || missing.length > 0
            || emptyRequired.length > 0;
        const ok = parsed.ok === true && !hasCritical;

        return {
            ok,
            skipped: false,
            reason: ok ? 'checkout_ok' : 'checkout_blocked',
            issues,
            fix_answers,
            summary: String(parsed.summary || (ok ? 'Looks ready to submit.' : 'Not ready to submit.')).slice(0, 400),
            provider: groq.provider,
            model: groq.model
        };
    } catch (err) {
        console.warn('[checkout] Groq checkout failed:', err.message);
        return {
            ok: missing.length === 0 && emptyRequired.length === 0,
            skipped: true,
            reason: 'groq_error',
            issues: [{ severity: 'warning', message: err.message || 'checkout failed' }],
            fix_answers: [],
            summary: 'Checkout unavailable — continuing with required-field heuristics.',
            provider: groq.provider,
            model: groq.model
        };
    }
}

module.exports = {
    checkApplicationCheckout,
    checkoutEnabled,
    compactFields
};
