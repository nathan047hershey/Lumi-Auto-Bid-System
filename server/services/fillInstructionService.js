/**
 * Excellent Auto Bidder control assistant — turns short user instructions into
 * fills, submit, queue control, and re-autofill actions.
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

function profileFacts(profile) {
    const p = profile || {};
    const city = String(p.city || '').trim();
    const state = String(p.state || '').trim();
    const zip = String(p.postal_code || p.zip || '').trim();
    const st = /^[A-Z]{2}$/i.test(state) ? state.toUpperCase() : state;
    const locationLine = [city, st].filter(Boolean).join(', ') + (zip ? ` ${zip}` : '');
    return {
        first_name: p.first_name || '',
        last_name: p.last_name || '',
        email: p.email || '',
        phone: p.phone || p.mobile || '',
        city,
        state: st,
        zip,
        location_line: locationLine.trim(),
        years_of_experience: p.years_of_experience || '',
        skills: String(p.skills || p.technical_skills || '').slice(0, 400),
        current_title: p.current_title || p.title || '',
        education: String(p.education || p.school || p.degree || '').slice(0, 300),
        work_auth: 'Yes',
        sponsorship: 'No',
        disability: 'No, I do not have a disability',
        over_18: 'Yes',
        gender: p.gender || 'Male',
        race_ethnicity: p.race_ethnicity || '',
        hispanic_latino: 'No',
        veteran: p.veteran_status || 'I am not a protected veteran',
        linkedin: p.linkedin_url || '',
        work_history: String(p.work_experience || p.experience || '').slice(0, 900)
    };
}

function emptyResult(summary, extra = {}) {
    return {
        ok: false,
        fills: [],
        clickSubmit: false,
        queueControl: null,
        reAutofill: false,
        summary,
        skipped: true,
        ...extra
    };
}

function okResult(partial) {
    return {
        ok: true,
        fills: [],
        clickSubmit: false,
        queueControl: null,
        reAutofill: false,
        fieldKey: 'form',
        issueKey: 'user_instruct',
        provider: 'local',
        model: null,
        ...partial
    };
}

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   fills: Array<{id?: string, label: string, answer: string}>,
 *   clickSubmit: boolean,
 *   queueControl?: 'pause'|'resume'|'stop'|'next'|'skip'|null,
 *   reAutofill?: boolean,
 *   issueKey?: string,
 *   fieldKey?: string,
 *   summary?: string,
 *   skipped?: boolean,
 *   provider?: string,
 *   model?: string,
 *   emailOtp?: string
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
    host = '',
    jobDescription = ''
} = {}) {
    const text = String(instruction || '').trim();
    if (!text) {
        return emptyResult('Empty instruction');
    }

    const snapshot = compactFields(fields);
    const facts = profileFacts(profile);
    const t = text.toLowerCase();

    // --- Queue control (local, instant) ---
    if (/^(pause|hold|wait|stop\s+for\s+(a\s+)?(sec|moment|minute)|freeze)(\s+queue)?[!?.]*$/i.test(text)
        || /\bpause\b/.test(t) && !/\bunpause\b|\bresume\b/.test(t) && t.length < 40) {
        return okResult({
            queueControl: 'pause',
            fieldKey: 'queue',
            issueKey: 'queue|pause',
            summary: 'Pause queue — fix the form, then say Resume'
        });
    }
    if (/^(resume|continue|unpause|keep\s+going)(\s+(queue|bidding))?[!?.]*$/i.test(text)
        || /\bresume\s+(queue|bidding|auto)\b/.test(t)) {
        return okResult({
            queueControl: 'resume',
            fieldKey: 'queue',
            issueKey: 'queue|resume',
            summary: 'Resume queue'
        });
    }
    if (/^(stop|abort|cancel)(\s+(queue|bidder|all))?[!?.]*$/i.test(text)
        && !/submit|fill|answer/.test(t)) {
        return okResult({
            queueControl: 'stop',
            fieldKey: 'queue',
            issueKey: 'queue|stop',
            summary: 'Stop auto-bidder'
        });
    }
    if (/^(next|skip\s+(this\s+)?job|go\s+to\s+next)[!?.]*$/i.test(text)
        || /\b(next\s+job|skip\s+(this|job))\b/.test(t) && t.length < 48) {
        return okResult({
            queueControl: 'next',
            fieldKey: 'queue',
            issueKey: 'queue|next',
            summary: 'Skip to next job'
        });
    }
    if (/^(skip\s+captcha|skip\s+this\s+captcha)[!?.]*$/i.test(text)
        || /\bskip\s+captcha\b/.test(t)) {
        return okResult({
            queueControl: 'skip',
            fieldKey: 'captcha',
            issueKey: 'captcha|skip',
            summary: 'Skip CAPTCHA / blocked job'
        });
    }
    if (/\b(re-?autofill|refill|fill\s+again|re-?fill\s+(the\s+)?form|run\s+autofill\s+again)\b/i.test(text)
        && t.length < 80) {
        return okResult({
            reAutofill: true,
            fieldKey: 'form',
            issueKey: 'form|reautofill',
            summary: 'Re-run autofill on this apply tab'
        });
    }

    // --- Hard policy fills (local) ---
    if (/\bdisabilit/.test(t) && /\b(no|false|don'?t|do not)\b/.test(t)) {
        const f = snapshot.find((x) => /disabilit/i.test(x.label));
        return okResult({
            fills: [{
                id: f?.id,
                label: f?.label || 'Disability Status',
                answer: 'No, I do not have a disability'
            }],
            clickSubmit: /\bsubmit\b/.test(t),
            fieldKey: 'disability_status',
            issueKey: 'disability|force_no',
            summary: 'Disability = No'
        });
    }
    if (/\b(sponsor|visa|h-?1b)\b/.test(t) && /\b(no|false|don'?t|do not|not\s+need)\b/.test(t)) {
        const f = snapshot.find((x) => /sponsor|visa|h-?1b/i.test(x.label));
        return okResult({
            fills: [{
                id: f?.id,
                label: f?.label || 'Visa sponsorship',
                answer: 'No'
            }],
            clickSubmit: /\bsubmit\b/.test(t),
            fieldKey: 'requires_sponsorship',
            issueKey: 'sponsorship|force_no',
            summary: 'Visa sponsorship = No'
        });
    }
    if (/\b(authoriz|eligible to work|legally authorized)\b/.test(t) && /\byes\b/.test(t)) {
        const f = snapshot.find((x) => /authoriz|eligible to work|legally/i.test(x.label));
        return okResult({
            fills: [{
                id: f?.id,
                label: f?.label || 'Work authorization',
                answer: 'Yes'
            }],
            clickSubmit: /\bsubmit\b/.test(t),
            fieldKey: 'work_authorization',
            issueKey: 'work_auth|force_yes',
            summary: 'Work authorization = Yes'
        });
    }
    if (/\bgender\b/.test(t) && /\bmale\b/.test(t) && !/\bfemale\b/.test(t)) {
        const f = snapshot.find((x) => /gender|think of yourself/i.test(x.label));
        return okResult({
            fills: [{
                id: f?.id,
                label: f?.label || 'Gender',
                answer: facts.gender || 'Male'
            }],
            fieldKey: 'gender',
            issueKey: 'gender|male',
            summary: `Gender = ${facts.gender || 'Male'}`
        });
    }

    // Fast path — location free-text
    if (/location|city|zip|postal/i.test(text) && /type|enter|fill|add|manual|free.?text|city.?state/i.test(text)) {
        const answer = facts.location_line
            || (facts.city && facts.state ? `${facts.city}, ${facts.state}${facts.zip ? ` ${facts.zip}` : ''}` : facts.city);
        if (answer) {
            const locField = snapshot.find((f) => /location|city/i.test(f.label)) || null;
            return okResult({
                fills: [{
                    id: locField?.id,
                    label: locField?.label || 'Location (city)',
                    answer
                }],
                clickSubmit: /submit/i.test(text),
                issueKey: 'location|no_dropdown_match',
                fieldKey: 'location',
                summary: 'Location free-text from profile'
            });
        }
    }

    // Fast path — email OTP
    const otpMatch = text.match(
        /(?:(?:this\s+is\s+(?:the\s+)?)?(?:security|verification|email|one[-\s]?time|otp|pin)\s*(?:code)?\s*(?:is|:|=)?\s*|code\s*(?:is|:|=)?\s*|fill\s+(?:the\s+)?(?:code|otp)\s+)([A-Za-z0-9]{4,12})\b/i
    ) || (/^\s*([A-Za-z0-9]{4,12})\s*$/.test(text) ? text.match(/^\s*([A-Za-z0-9]{4,12})\s*$/) : null);
    if (otpMatch?.[1]) {
        const code = String(otpMatch[1]).trim();
        if (!/^(submit|continue|confirm|verify|apply|code|security|please|thanks|pause|resume|stop|next)$/i.test(code)) {
            const codeField = snapshot.find((f) =>
                /security|verif|otp|one[-\s]?time|email\s*code|confirmation\s*code|pin\b/i.test(f.label)
            ) || snapshot.find((f) => f.empty && /code/i.test(f.label)) || null;
            const wantSubmit = /submit|continue|confirm|verify|apply/i.test(text)
                || /^(?:\s*[A-Za-z0-9]{4,12}\s*)$/.test(text);
            return okResult({
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
                emailOtp: code
            });
        }
    }

    if (/^submit(\s+anyway)?$/i.test(text)
        || /^just submit$/i.test(text)
        || /submit\s+right\s+now/i.test(text)
        || /better\s+to\s+submit/i.test(text)
        || /go\s+ahead\s+and\s+submit/i.test(text)) {
        const needsCode = snapshot.some((f) =>
            f.empty && /security|verif|otp|one[-\s]?time|email\s*code|confirmation\s*code/i.test(f.label)
        );
        if (needsCode) {
            return emptyResult(
                'Form needs the email security code first — paste it here (e.g. wFY53Ht3) then I will submit',
                { issueKey: 'email_otp|need_code', fieldKey: 'email_otp', provider: 'local', model: null }
            );
        }
        return okResult({
            clickSubmit: true,
            issueKey: 'submit|manual',
            fieldKey: 'submit',
            summary: 'Submit only'
        });
    }

    const groq = getAnswersGroqRescueConfig();
    if (!groq?.apiKey) {
        return emptyResult(
            'No Groq key — try: Pause, Resume, Disability = No, Type city into Location, Submit now'
        );
    }

    const system = `You are Lumi, an elite Auto Bidder control assistant for live job-application forms.

Your job: turn a short human instruction into precise JSON actions that fix the form or control the queue.

You know this candidate's PROFILE facts and the open form fields. Prefer PROFILE + resume facts. Never invent employers, degrees, or years.

VOICE FOR OPEN-TEXT ANSWERS:
- Short, clear, professional, human-typed.
- 1 sentence preferred (hard cap ~45 words). Unique to this profile + this JD.
- Plain text only: no markdown, no bold, no bullets, no long dashes (— –).

HARD DEFAULTS (unless instruction says otherwise):
- Disability → No, I do not have a disability
- Visa / sponsorship → No
- Work authorization / legally authorized → Yes
- Over 18 → Yes
- US citizen / U.S. person → Yes
- Former employee / worked here before / relative / non-compete → No
- Gender → profile gender (usually Male)
- Years / skill experience → never "0 experience" / "No experience"; pick production / mid-senior options matching years_of_experience

QUEUE / CONTROL (set queueControl OR reAutofill when asked):
- pause | resume | stop | next | skip (CAPTCHA)
- reAutofill true = re-run autofill on this tab

FILL RULES:
- Prefer empty/wrong required fields.
- When OPTIONS exist in the field value or label, copy an option EXACTLY.
- Multiple fields OK (up to 8).
- clickSubmit true only if user says submit OR form is clearly ready after your fills.
- fieldKey: short key (location, salary, sponsorship, why_company, skill_experience…).
- issueKey: host-agnostic like location|no_dropdown_match or why|rewrite.

Return JSON ONLY (no chat):
{"fills":[{"id":"...","label":"...","answer":"..."}],"clickSubmit":true|false,"queueControl":null|"pause"|"resume"|"stop"|"next"|"skip","reAutofill":false,"fieldKey":"...","issueKey":"...","summary":"one short human line"}`;

    const user = {
        instruction: text.slice(0, 600),
        host: host || '',
        ats: ats || '',
        company: companyName || '',
        role: jobRole || '',
        job_description_excerpt: String(jobDescription || '').slice(0, 1200),
        profile: facts,
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
            max_tokens: 1200,
            temperature: 0.15
        }, {
            headers: { Authorization: `Bearer ${groq.apiKey}` },
            timeout: 45000
        });

        const raw = stripReasoning(String(response.data?.choices?.[0]?.message?.content || ''));
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                ok: false,
                fills: [],
                clickSubmit: false,
                queueControl: null,
                reAutofill: false,
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
                answer: String(a.answer || '')
                    .replace(/\*\*([^*]+)\*\*/g, '$1')
                    .replace(/\s*[—–―]+\s*/g, ', ')
                    .slice(0, 800)
            }))
            .filter((a) => a.answer && (a.label || a.id))
            .slice(0, 12);

        const qcRaw = String(parsed.queueControl || '').toLowerCase().trim();
        const queueControl = ['pause', 'resume', 'stop', 'next', 'skip'].includes(qcRaw)
            ? qcRaw
            : null;
        const reAutofill = parsed.reAutofill === true;
        const clickSubmit = parsed.clickSubmit === true;

        return {
            ok: fills.length > 0 || clickSubmit || !!queueControl || reAutofill,
            fills,
            clickSubmit,
            queueControl,
            reAutofill,
            fieldKey: String(parsed.fieldKey || (queueControl ? 'queue' : 'form')).slice(0, 80),
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
            queueControl: null,
            reAutofill: false,
            summary: err.message || 'Instruction interpret failed',
            skipped: true,
            provider: groq.provider,
            model: groq.model
        };
    }
}

module.exports = {
    interpretFillInstruction,
    compactFields,
    profileFacts
};
