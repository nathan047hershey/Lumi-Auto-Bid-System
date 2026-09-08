/**
 * Turn a user instruction (stuck at FILLED) into structured fill actions via Groq.
 */
const axios = require('axios');
const { getAnswersGroqRescueConfig } = require('./settingsService');

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
            if (!label && !value) return null;
            return {
                id: String(f.id || label).slice(0, 80),
                label: label || '(untitled)',
                value: value || '',
                required: !!(f.required || f.ariaRequired),
                empty: !value
            };
        })
        .filter(Boolean)
        .slice(0, 60);
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   fills: Array<{id?: string, label: string, answer: string}>,
 *   clickSubmit: boolean,
 *   issueKey?: string,
 *   fieldKey?: string,
 *   summary?: string,
 *   skipped?: boolean,
 *   provider?: string,
 *   model?: string
 * }>}
 */
async function interpretFillInstruction({
    instruction = '',
    fields = [],
    missingRequired = [],
    profile = null,
    lessons = [],
    assistantContext = null,
    companyName = '',
    jobRole = '',
    ats = '',
    host = ''
} = {}) {
    const text = String(instruction || '').trim();
    if (!text) {
        return {
            ok: false,
            fills: [],
            clickSubmit: false,
            summary: 'Empty instruction',
            skipped: true
        };
    }

    const snapshot = compactFields(fields);
    const city = String(profile?.city || '').trim();
    const state = String(profile?.state || '').trim();
    const zip = String(profile?.postal_code || profile?.zip || '').trim();
    const st = /^[A-Z]{2}$/i.test(state) ? state.toUpperCase() : state;
    const locationLine = [city, st].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '');
    const locationLineTrim = locationLine.trim();

    // Fast path — location free-text without burning Groq.
    if (/location|city|zip|postal/i.test(text) && /type|enter|fill|add|manual|free.?text|city.?state/i.test(text)) {
        const answer = locationLineTrim
            || (city && st ? `${city}, ${st}${zip ? ` ${zip}` : ''}` : city);
        if (answer) {
            const locField = snapshot.find((f) => /location|city/i.test(f.label)) || null;
            return {
                ok: true,
                fills: [{
                    id: locField?.id,
                    label: locField?.label || 'Location (city)',
                    answer
                }],
                clickSubmit: /submit/i.test(text),
                issueKey: 'location|no_dropdown_match',
                fieldKey: 'location',
                summary: 'Location free-text from profile',
                provider: 'local',
                model: null
            };
        }
    }

    // Fast path — Greenhouse / email security code pasted into Instruct Lumi.
    // Digits: "123456", "code 123456". Alphanumeric: "this is code wFY53Ht3", "code: Ab12Cd34"
    const otpMatch = text.match(
        /(?:(?:this\s+is\s+(?:the\s+)?)?(?:security|verification|email|one[-\s]?time|otp|pin)\s*(?:code)?\s*(?:is|:|=)?\s*|code\s*(?:is|:|=)?\s*|fill\s+(?:the\s+)?(?:code|otp)\s+)([A-Za-z0-9]{4,12})\b/i
    ) || (/^\s*([A-Za-z0-9]{4,12})\s*$/.test(text) ? text.match(/^\s*([A-Za-z0-9]{4,12})\s*$/) : null);
    if (otpMatch?.[1]) {
        const code = String(otpMatch[1]).trim();
        // Ignore common non-code words accidentally captured
        if (!/^(submit|continue|confirm|verify|apply|code|security|please|thanks)$/i.test(code)) {
            const codeField = snapshot.find((f) =>
                /security|verif|otp|one[-\s]?time|email\s*code|confirmation\s*code|pin\b/i.test(f.label)
            ) || snapshot.find((f) => f.empty && /code/i.test(f.label)) || null;
            const wantSubmit = /submit|continue|confirm|verify|apply/i.test(text)
                || /^(?:\s*[A-Za-z0-9]{4,12}\s*)$/.test(text); // bare code → fill then submit
            return {
                ok: true,
                fills: [{
                    id: codeField?.id,
                    label: codeField?.label || 'Security code',
                    answer: code,
                    answer_type: 'email_otp'
                }],
                clickSubmit: wantSubmit,
                issueKey: 'email_otp|manual_code',
                fieldKey: 'email_otp',
                summary: `Fill security code ${code}${wantSubmit ? ' + submit' : ''}`,
                provider: 'local',
                model: null,
                emailOtp: code
            };
        }
    }

    if (/^submit(\s+anyway)?$/i.test(text)
        || /^just submit$/i.test(text)
        || /submit\s+right\s+now/i.test(text)
        || /better\s+to\s+submit/i.test(text)
        || /go\s+ahead\s+and\s+submit/i.test(text)) {
        // If the snapshot still has an empty security-code field, don't click Submit blindly.
        const needsCode = snapshot.some((f) =>
            f.empty && /security|verif|otp|one[-\s]?time|email\s*code|confirmation\s*code/i.test(f.label)
        );
        if (needsCode) {
            return {
                ok: false,
                fills: [],
                clickSubmit: false,
                issueKey: 'email_otp|need_code',
                fieldKey: 'email_otp',
                summary: 'Form needs the email security code first — paste it here (e.g. wFY53Ht3) then I will submit',
                skipped: true,
                provider: 'local',
                model: null
            };
        }
        return {
            ok: true,
            fills: [],
            clickSubmit: true,
            issueKey: 'submit|manual',
            fieldKey: 'submit',
            summary: 'Submit only',
            provider: 'local',
            model: null
        };
    }

    const groq = getAnswersGroqRescueConfig();
    if (!groq?.apiKey) {
        return {
            ok: false,
            fills: [],
            clickSubmit: false,
            summary: 'No Groq key — use a concrete instruction like “Type city, state and zip into Location”',
            skipped: true
        };
    }

    const system = `You help Auto Bidder fix a stuck job application form after fill.
The user gives a short instruction. Return JSON actions only — no chat.
Rules:
- Prefer filling empty/wrong fields from profile location (city, state, zip).
- clickSubmit true only if instruction says submit OR form looks ready after fills.
- fieldKey: short key like location, salary, sponsorship.
- issueKey: host-agnostic like location|no_dropdown_match.
Return JSON:
{"fills":[{"id":"...","label":"...","answer":"..."}],"clickSubmit":true|false,"fieldKey":"...","issueKey":"...","summary":"..."}`;

    const user = {
        instruction: text.slice(0, 500),
        host: host || '',
        ats: ats || '',
        company: companyName || '',
        role: jobRole || '',
        profile_location: { city, state: st, zip, line: locationLineTrim },
        missing_required: (missingRequired || []).slice(0, 12),
        fields: snapshot,
        prior_lessons: (Array.isArray(lessons) ? lessons : []).slice(0, 8).map((l) => ({
            fieldKey: l.fieldKey || l.field_key,
            issueKey: l.issueKey || l.issue_key,
            instruction: String(l.instruction || '').slice(0, 160),
            actions: l.actions || l.actions_json || null
        })),
        analytics: assistantContext
            ? {
                by_host: (assistantContext.by_host || []).slice(0, 8),
                top_failures: (assistantContext.top_failures || []).slice(0, 8),
                winning_fixes: (assistantContext.winning_fixes || []).slice(0, 6)
            }
            : null
    };

    try {
        const response = await axios.post(groq.apiUrl, {
            model: groq.model,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: JSON.stringify(user, null, 2) }
            ],
            max_tokens: 900,
            temperature: 0.1
        }, {
            headers: { Authorization: `Bearer ${groq.apiKey}` },
            timeout: 40000
        });

        const raw = stripReasoning(String(response.data?.choices?.[0]?.message?.content || ''));
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                ok: false,
                fills: [],
                clickSubmit: false,
                summary: 'Could not parse instruction',
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
        const fills = (Array.isArray(parsed.fills) ? parsed.fills : [])
            .map((a) => ({
                id: a.id || undefined,
                label: String(a.label || '').slice(0, 160),
                answer: String(a.answer || '').slice(0, 800)
            }))
            .filter((a) => a.answer && (a.label || a.id))
            .slice(0, 12);

        return {
            ok: fills.length > 0 || parsed.clickSubmit === true,
            fills,
            clickSubmit: parsed.clickSubmit === true,
            fieldKey: String(parsed.fieldKey || 'form').slice(0, 80),
            issueKey: String(parsed.issueKey || 'user_instruct').slice(0, 120),
            summary: String(parsed.summary || 'Instruction applied').slice(0, 200),
            provider: groq.provider,
            model: groq.model
        };
    } catch (err) {
        console.warn('[fillInstruction] Groq failed:', err.message);
        return {
            ok: false,
            fills: [],
            clickSubmit: false,
            summary: err.message || 'Instruction interpret failed',
            skipped: true,
            provider: groq.provider,
            model: groq.model
        };
    }
}

module.exports = {
    interpretFillInstruction,
    compactFields
};
