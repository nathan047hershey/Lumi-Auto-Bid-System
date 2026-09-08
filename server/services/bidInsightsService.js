/**
 * Aggregate bid courses vs interview outcomes into insights + a compact
 * playbook used by applicationAnswersService when drafting autofill answers.
 */
const { getAll } = require('../config/database');

function hourFromSql(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.getHours();
}

function dayFromSql(ts) {
    if (!ts) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return d.getDay(); // 0 Sun .. 6 Sat
}

function normalizeQuestionLabel(label) {
    const s = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!s) return 'other';
    if (/\b(salary|compensation|pay|ctc|wage|remuneration|expected\s*comp)\b/.test(s)) return 'salary';
    if (/\b(authoriz|work\s*auth|eligible\s*to\s*work|visa|sponsorship|legally\s*work)\b/.test(s)) {
        return 'work_auth';
    }
    if (/\b(why\s*(do\s*you\s*)?(want|apply|interested)|why\s*us|why\s*this\s*(role|company|position))\b/.test(s)) {
        return 'why_us';
    }
    if (/\b(years?\s*(of\s*)?experience|how\s*many\s*years|yo\.?e)\b/.test(s)) return 'years_experience';
    if (/\b(notice|start\s*date|when\s*can\s*you\s*start|availability)\b/.test(s)) return 'availability';
    if (/\b(relocat|remote|hybrid|onsite|on-site|location)\b/.test(s)) return 'location';
    return 'other';
}

function parseAnswers(raw) {
    if (!raw) return [];
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

function roleKey(role) {
    return String(role || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, 80);
}

/** Infer answer *style* from past texts — never used as copy-paste content. */
function analyzeAnswerStyle(texts) {
    const samples = (texts || []).map((t) => String(t || '').trim()).filter(Boolean);
    if (!samples.length) {
        return {
            sample_count: 0,
            length_band: 'short',
            avg_words: null,
            avg_sentences: null,
            human_like: true,
            uses_first_person: true,
            uses_contractions: true,
            style_labels: ['short', 'human']
        };
    }

    let wordsTotal = 0;
    let sentencesTotal = 0;
    let firstPerson = 0;
    let contractions = 0;
    let corporateSpeak = 0;

    for (const text of samples) {
        const words = text.split(/\s+/).filter(Boolean);
        wordsTotal += words.length;
        sentencesTotal += Math.max(1, (text.match(/[.!?]+/g) || []).length);
        if (/\b(i|i'm|i’ve|i've|my|me)\b/i.test(text)) firstPerson += 1;
        if (/\b(i'm|i’ve|i've|don't|doesn't|can't|won't|it's|that's|we're)\b/i.test(text)) {
            contractions += 1;
        }
        if (/\b(synerg|leverage|passionate about|excited to|cutting-edge|utilize|robust)\b/i.test(text)) {
            corporateSpeak += 1;
        }
    }

    const n = samples.length;
    const avgWords = Math.round(wordsTotal / n);
    const avgSentences = Math.round((sentencesTotal / n) * 10) / 10;
    let lengthBand = 'short';
    if (avgWords >= 55) lengthBand = 'long';
    else if (avgWords >= 28) lengthBand = 'medium';

    const humanLike = (contractions / n) >= 0.25 || (corporateSpeak / n) < 0.4;
    const styleLabels = [lengthBand];
    if (humanLike) styleLabels.push('human');
    if ((firstPerson / n) >= 0.5) styleLabels.push('first_person');
    if ((contractions / n) >= 0.25) styleLabels.push('contractions');
    if (avgSentences <= 2) styleLabels.push('tight');

    return {
        sample_count: n,
        length_band: lengthBand,
        avg_words: avgWords,
        avg_sentences: avgSentences,
        human_like: humanLike,
        uses_first_person: (firstPerson / n) >= 0.5,
        uses_contractions: (contractions / n) >= 0.25,
        style_labels: styleLabels
    };
}

function describeStyle(style) {
    if (!style || !style.sample_count) return 'short, natural, human-sounding';
    const bits = [];
    if (style.length_band === 'short') bits.push('keep it short (about 1–2 sentences)');
    else if (style.length_band === 'medium') bits.push('medium length (a short paragraph)');
    else bits.push('a bit longer when the question needs depth');
    if (style.human_like) bits.push('sound like a real person wrote it (natural phrasing)');
    if (style.uses_first_person) bits.push('use first person (“I …”)');
    if (style.uses_contractions) bits.push('light contractions OK (I’m, I’ve)');
    if (style.avg_words) bits.push(`target ~${style.avg_words} words when it fits`);
    return bits.join('; ');
}

function rolesSimilar(a, b) {
    const ka = roleKey(a);
    const kb = roleKey(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    return ka.includes(kb) || kb.includes(ka);
}

/**
 * @param {object} opts
 * @param {number} [opts.userId]
 * @param {number} [opts.profileId]
 * @param {string} [opts.jobRole] — bias playbook toward similar roles
 * @param {boolean} [opts.allUsers] — admin: all bid courses
 */
function buildBidInsights({ userId, profileId, jobRole, allUsers = false } = {}) {
    let courses;
    if (allUsers) {
        courses = getAll(
            `SELECT c.*
             FROM bid_courses c
             ORDER BY COALESCE(c.filled_at, c.started_at, c.created_at) DESC
             LIMIT 500`
        );
    } else {
        const params = [parseInt(userId, 10)];
        let profileClause = '';
        if (profileId) {
            profileClause = ' AND c.profile_id = ? ';
            params.push(parseInt(profileId, 10));
        }
        courses = getAll(
            `SELECT c.*
             FROM bid_courses c
             WHERE c.user_id = ?
             ${profileClause}
             ORDER BY COALESCE(c.filled_at, c.started_at, c.created_at) DESC
             LIMIT 500`,
            params
        );
    }

    const total = courses.length;
    const interviews = courses.filter((c) => c.outcome === 'interview');
    const applied = courses.filter((c) => c.outcome === 'applied' || c.outcome === 'interview');
    const rejected = courses.filter((c) => c.outcome === 'rejected');
    const unknown = courses.filter((c) => !c.outcome || c.outcome === 'unknown');

    const byHour = {};
    const byDay = {};
    const byTemplate = {};
    const byFont = {};
    const byCompany = {};
    const byAnswersProvider = {};
    const byCvProvider = {};
    const byRole = {};
    const labelExamples = {}; // cluster -> { interview: [], other: [] }
    const salaryInterview = [];
    const salaryOther = [];

    for (const c of courses) {
        const win = c.outcome === 'interview';
        const hour = hourFromSql(c.filled_at || c.started_at);
        const day = dayFromSql(c.filled_at || c.started_at);
        if (hour != null) {
            byHour[hour] = byHour[hour] || { total: 0, interview: 0 };
            byHour[hour].total += 1;
            if (win) byHour[hour].interview += 1;
        }
        if (day != null) {
            byDay[day] = byDay[day] || { total: 0, interview: 0 };
            byDay[day].total += 1;
            if (win) byDay[day].interview += 1;
        }
        const tid = c.template_id != null ? String(c.template_id) : 'none';
        byTemplate[tid] = byTemplate[tid] || {
            total: 0,
            interview: 0,
            template_id: c.template_id,
            font_family: c.font_family || null
        };
        byTemplate[tid].total += 1;
        if (win) byTemplate[tid].interview += 1;
        if (c.font_family) {
            byTemplate[tid].font_family = byTemplate[tid].font_family || c.font_family;
        }

        const font = String(c.font_family || 'unknown').trim() || 'unknown';
        byFont[font] = byFont[font] || { total: 0, interview: 0, font_family: font };
        byFont[font].total += 1;
        if (win) byFont[font].interview += 1;

        const company = String(c.company_name || 'Unknown').trim() || 'Unknown';
        const companyKey = company.slice(0, 80);
        byCompany[companyKey] = byCompany[companyKey] || {
            total: 0,
            interview: 0,
            company_name: companyKey
        };
        byCompany[companyKey].total += 1;
        if (win) byCompany[companyKey].interview += 1;

        const role = String(c.job_role || 'Unknown').trim() || 'Unknown';
        const roleLabel = role.slice(0, 80);
        byRole[roleLabel] = byRole[roleLabel] || { total: 0, interview: 0, job_role: roleLabel };
        byRole[roleLabel].total += 1;
        if (win) byRole[roleLabel].interview += 1;

        const prov = c.answers_provider || 'unknown';
        byAnswersProvider[prov] = byAnswersProvider[prov] || { total: 0, interview: 0 };
        byAnswersProvider[prov].total += 1;
        if (win) byAnswersProvider[prov].interview += 1;

        const cvProv = c.cv_provider || 'unknown';
        byCvProvider[cvProv] = byCvProvider[cvProv] || { total: 0, interview: 0 };
        byCvProvider[cvProv].total += 1;
        if (win) byCvProvider[cvProv].interview += 1;

        if (c.salary_value != null && Number.isFinite(Number(c.salary_value))) {
            (win ? salaryInterview : salaryOther).push(Number(c.salary_value));
        }

        const answers = parseAnswers(c.answers_json);
        for (const a of answers) {
            const cluster = normalizeQuestionLabel(a.label || a.id);
            if (cluster === 'salary') continue;
            labelExamples[cluster] = labelExamples[cluster] || { interview: [], other: [] };
            const bucket = win ? labelExamples[cluster].interview : labelExamples[cluster].other;
            const text = String(a.answer || '').trim();
            if (text && bucket.length < 12) {
                bucket.push({
                    label: a.label || a.id,
                    answer: text.slice(0, 400),
                    company: c.company_name,
                    job_role: c.job_role,
                    application_id: c.application_id
                });
            }
        }
    }

    const rate = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

    const hourRates = Object.entries(byHour)
        .map(([h, v]) => ({
            hour: Number(h),
            total: v.total,
            interview: v.interview,
            interview_rate: rate(v.interview, v.total)
        }))
        .filter((x) => x.total >= 1)
        .sort((a, b) => b.interview_rate - a.interview_rate || b.interview - a.interview);

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayRates = Object.entries(byDay)
        .map(([d, v]) => ({
            day: Number(d),
            day_name: dayNames[Number(d)] || String(d),
            total: v.total,
            interview: v.interview,
            interview_rate: rate(v.interview, v.total)
        }))
        .sort((a, b) => a.day - b.day);

    const templateRates = Object.values(byTemplate)
        .map((v) => ({
            ...v,
            interview_rate: rate(v.interview, v.total)
        }))
        .sort((a, b) => b.interview_rate - a.interview_rate || b.interview - a.interview);

    const fontRates = Object.values(byFont)
        .map((v) => ({
            ...v,
            interview_rate: rate(v.interview, v.total)
        }))
        .sort((a, b) => b.interview_rate - a.interview_rate || b.interview - a.interview);

    const companyRates = Object.values(byCompany)
        .map((v) => ({
            ...v,
            interview_rate: rate(v.interview, v.total)
        }))
        .sort((a, b) => b.interview - a.interview || b.interview_rate - a.interview_rate || b.total - a.total);

    const roleRates = Object.values(byRole)
        .map((v) => ({
            ...v,
            interview_rate: rate(v.interview, v.total)
        }))
        .sort((a, b) => b.interview - a.interview || b.interview_rate - a.interview_rate || b.total - a.total);

    const providerRates = Object.entries(byAnswersProvider).map(([provider, v]) => ({
        provider,
        total: v.total,
        interview: v.interview,
        interview_rate: rate(v.interview, v.total)
    }));

    const cvProviderRates = Object.entries(byCvProvider).map(([provider, v]) => ({
        provider,
        total: v.total,
        interview: v.interview,
        interview_rate: rate(v.interview, v.total)
    }));

    const avg = (arr) => (arr.length
        ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length)
        : null);

    // Playbook: style from interview wins (not answer text to copy).
    const roleScopedWins = jobRole
        ? interviews.filter((c) => rolesSimilar(c.job_role, jobRole))
        : interviews;
    const winPool = roleScopedWins.length >= 2 ? roleScopedWins : interviews;

    const winTextsAll = [];
    const winTextsByCluster = {};
    for (const c of winPool) {
        for (const a of parseAnswers(c.answers_json)) {
            const cluster = normalizeQuestionLabel(a.label || a.id);
            if (cluster === 'salary') continue;
            const text = String(a.answer || '').trim();
            if (!text) continue;
            winTextsAll.push(text);
            if (cluster === 'other') continue;
            winTextsByCluster[cluster] = winTextsByCluster[cluster] || [];
            if (winTextsByCluster[cluster].length < 20) {
                winTextsByCluster[cluster].push(text);
            }
        }
    }

    const overallStyle = analyzeAnswerStyle(winTextsAll);
    const stylesByCluster = Object.entries(winTextsByCluster).map(([cluster, texts]) => ({
        cluster,
        ...analyzeAnswerStyle(texts),
        description: describeStyle(analyzeAnswerStyle(texts))
    }));

    const bestHours = hourRates.filter((h) => h.total >= 2).slice(0, 3);
    const bestTemplate = templateRates.find((t) => t.total >= 2 && t.template_id != null)
        || templateRates.find((t) => t.template_id != null)
        || null;
    const bestFont = fontRates.find((f) => f.total >= 2 && f.font_family !== 'unknown')
        || fontRates.find((f) => f.font_family !== 'unknown')
        || null;
    const bestCompanies = companyRates.filter((c) => c.interview > 0).slice(0, 8);

    const playbook = {
        interview_count: interviews.length,
        sample_size: total,
        preferred_fill_hours: bestHours.map((h) => h.hour),
        preferred_template_id: bestTemplate?.template_id ?? null,
        preferred_font_family: bestFont?.font_family || bestTemplate?.font_family || null,
        preferred_companies: bestCompanies.map((c) => c.company_name),
        answer_style: overallStyle,
        answer_style_description: describeStyle(overallStyle),
        styles_by_cluster: stylesByCluster,
        winning_answers: [],
        salary_note:
            'Salary is computed per job from that posting’s range ∩ your profile range '
            + '(~45th percentile of the overlap). Do not reuse a past dollar amount.',
        avg_interview_salary: avg(salaryInterview),
        role_focus: jobRole || null
    };

    // Chart-ready: hours 0–23 ordered for bar chart
    const hourChart = Array.from({ length: 24 }, (_, hour) => {
        const row = byHour[hour] || { total: 0, interview: 0 };
        return {
            label: `${hour}`,
            values: { bids: row.total, interviews: row.interview }
        };
    }).filter((d) => d.values.bids > 0);

    const dayChart = dayNames.map((name, day) => {
        const row = byDay[day] || { total: 0, interview: 0 };
        return {
            label: name,
            values: { bids: row.total, interviews: row.interview }
        };
    });

    return {
        summary: {
            courses: total,
            bids: total,
            applied: applied.length,
            interview: interviews.length,
            rejected: rejected.length,
            unknown: unknown.length,
            interview_rate: rate(interviews.length, Math.max(applied.length, 1)),
            interview_rate_of_all: rate(interviews.length, Math.max(total, 1))
        },
        by_fill_hour: hourRates,
        by_fill_day: dayRates,
        by_template: templateRates,
        by_font: fontRates,
        by_company: companyRates.slice(0, 25),
        by_role: roleRates.slice(0, 20),
        by_answers_provider: providerRates,
        by_cv_provider: cvProviderRates,
        charts: {
            outcomes: [
                { label: 'Unknown', value: unknown.length, color: '#a1a1aa' },
                { label: 'Applied', value: applied.length - interviews.length, color: '#67e8f9' },
                { label: 'Interview', value: interviews.length, color: '#5eead4' },
                { label: 'Rejected', value: rejected.length, color: '#f87171' }
            ].map((s) => ({ ...s, value: Math.max(0, s.value) })),
            by_hour: hourChart,
            by_day: dayChart
        },
        salary: {
            avg_interview: avg(salaryInterview),
            avg_other: avg(salaryOther),
            interview_samples: salaryInterview.length,
            other_samples: salaryOther.length
        },
        answer_clusters: Object.entries(labelExamples).map(([cluster, buckets]) => ({
            cluster,
            interview_examples: buckets.interview.slice(0, 5),
            other_examples: buckets.other.slice(0, 3)
        })),
        playbook,
        bidder_ops: buildBidderOps(courses),
        recent_courses: courses.slice(0, 30).map((c) => ({
            id: c.id,
            application_id: c.application_id,
            company_name: c.company_name,
            job_role: c.job_role,
            outcome: c.outcome,
            started_at: c.started_at,
            filled_at: c.filled_at,
            applied_at: c.applied_at,
            template_id: c.template_id,
            font_family: c.font_family,
            cv_provider: c.cv_provider,
            answers_provider: c.answers_provider,
            answers_model: c.answers_model,
            salary_formatted: c.salary_formatted,
            salary_value: c.salary_value
        }))
    };
}

/**
 * Bidder Ops analytics — Studying Engine + funnel/captcha/incomplete from courses.
 */
function buildBidderOps(courses = []) {
    const laneMix = { profile: 0, policy: 0, salary: 0, unique: 0, written: 0, other: 0 };
    let memoryHits = 0;
    let memoryScoreSum = 0;
    let uniqueSimSum = 0;
    let uniqueSimN = 0;
    let uniqueRegen = 0;
    const uniqueSubtypes = { why: 0, behavioral: 0, cover: 0 };
    const knockoutAudit = [];
    const incompleteCounts = {};
    const failureCodes = {};
    let salarySentinels = 0;
    let truncated = 0;

    let opened = 0;
    let formReady = 0;
    let filled = 0;
    let submitClicked = 0;
    let applied = 0;
    let stuck = 0;
    const captcha = {
        clear: 0,
        abandon: 0,
        passive: 0,
        helper_missing: 0,
        none: 0
    };
    const byAts = {};
    const byHost = {};

    const stuckEvents = new Set([
        'fill_incomplete', 'submit_blocked_incomplete', 'captcha_abandoned',
        'needs_captcha', 'login_wall', 'no_form', 'bid_budget_exceeded',
        'fill_failed', 'needs_manual', 'open_failed'
    ]);

    for (const c of courses.slice(0, 50)) {
        if (c.started_at || c.filled_at || c.applied_at) opened += 1;
        if (c.filled_at) {
            formReady += 1;
            filled += 1;
        }
        if (c.applied_at || c.outcome === 'applied' || c.outcome === 'interview') {
            submitClicked += 1;
            applied += 1;
        }

        let host = '';
        try {
            host = new URL(String(c.job_url || '')).hostname.replace(/^www\./i, '');
        } catch {
            host = '';
        }
        if (host) {
            byHost[host] = byHost[host] || { total: 0, applied: 0, incomplete: 0 };
            byHost[host].total += 1;
            if (c.outcome === 'applied' || c.outcome === 'interview') byHost[host].applied += 1;
        }

        const answers = parseAnswers(c.answers_json);
        for (const a of answers) {
            const lane = String(a.lane || '').toLowerCase() || 'other';
            if (laneMix[lane] != null) laneMix[lane] += 1;
            else laneMix.other += 1;
            if (a.match_source === 'question_memory') {
                memoryHits += 1;
                if (Number(a.memory_score) > 0) memoryScoreSum += Number(a.memory_score);
            }
            if (lane === 'unique') {
                if (Number(a.unique_similarity) > 0) {
                    uniqueSimSum += Number(a.unique_similarity);
                    uniqueSimN += 1;
                }
                if (a.unique_regenerated) uniqueRegen += 1;
                const sub = String(a.unique_subtype || '').toLowerCase();
                if (uniqueSubtypes[sub] != null) uniqueSubtypes[sub] += 1;
            }
            if (a.knockout || a.kind === 'disability_status' || a.kind === 'requires_sponsorship') {
                if (knockoutAudit.length < 20) {
                    knockoutAudit.push({
                        label: String(a.label || '').slice(0, 120),
                        answer: String(a.answer || '').slice(0, 80),
                        kind: a.kind,
                        company: c.company_name
                    });
                }
            }
            if (a.failure_code) {
                failureCodes[a.failure_code] = (failureCodes[a.failure_code] || 0) + 1;
            }
            if (a.truncated) truncated += 1;
            const sal = Number(a.salary_meta?.value);
            if (sal === 0 || sal === 99999) salarySentinels += 1;
        }

        // Pull events for funnel / captcha / incomplete (best-effort)
        try {
            const events = getAll(
                `SELECT event_type, meta_json FROM bid_course_events WHERE course_id = ? ORDER BY at DESC LIMIT 40`,
                [c.id]
            );
            let sawCaptcha = false;
            for (const ev of events) {
                const t = String(ev.event_type || '');
                if (t === 'form_ready' || t === 'form_detected') formReady += 1;
                if (t === 'submit_clicked') submitClicked += 1;
                if (t === 'captcha_cleared' || t === 'captcha_helper_clear') {
                    captcha.clear += 1;
                    sawCaptcha = true;
                }
                if (t === 'captcha_abandoned') {
                    captcha.abandon += 1;
                    sawCaptcha = true;
                }
                if (t === 'captcha_passive_continue') {
                    captcha.passive += 1;
                    sawCaptcha = true;
                }
                if (t === 'captcha_helper_missing') {
                    captcha.helper_missing += 1;
                    sawCaptcha = true;
                }
                if (stuckEvents.has(t)) stuck += 1;
                if (t === 'fill_incomplete' || t === 'submit_blocked_incomplete') {
                    if (host && byHost[host]) byHost[host].incomplete += 1;
                    let meta = {};
                    try {
                        meta = ev.meta_json ? JSON.parse(ev.meta_json) : {};
                    } catch {
                        meta = {};
                    }
                    const missing = meta.missing || meta.missingRequired || meta.labels || [];
                    const list = Array.isArray(missing) ? missing : [];
                    for (const m of list) {
                        const label = String(typeof m === 'string' ? m : (m?.label || m?.name || '')).trim().slice(0, 80);
                        if (!label) continue;
                        incompleteCounts[label] = (incompleteCounts[label] || 0) + 1;
                    }
                }
                const ats = (() => {
                    try {
                        const m = ev.meta_json ? JSON.parse(ev.meta_json) : {};
                        return String(m.ats || '').toLowerCase();
                    } catch {
                        return '';
                    }
                })();
                if (ats) {
                    byAts[ats] = byAts[ats] || { total: 0, applied: 0 };
                    byAts[ats].total += 1;
                    if (c.outcome === 'applied' || c.outcome === 'interview') byAts[ats].applied += 1;
                }
            }
            if (!sawCaptcha) captcha.none += 1;
        } catch (_) { /* ignore */ }
    }

    const incomplete_top = Object.entries(incompleteCounts)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);

    return {
        window: { courses: Math.min(courses.length, 50) },
        funnel: {
            opened: Math.max(opened, filled, applied),
            form_ready: formReady,
            filled,
            submit_clicked: Math.max(submitClicked, applied),
            applied
        },
        stuck,
        lane_mix: laneMix,
        memory_hits: memoryHits,
        memory_avg_score: memoryHits ? Math.round((memoryScoreSum / memoryHits) * 1000) / 1000 : null,
        unique_health: {
            avg_similarity: uniqueSimN ? Math.round((uniqueSimSum / uniqueSimN) * 1000) / 1000 : null,
            regenerated: uniqueRegen,
            subtypes: uniqueSubtypes
        },
        knockout_audit: knockoutAudit,
        captcha_rollup: captcha,
        incomplete_top,
        salary_sentinels: salarySentinels,
        truncation_rate: truncated,
        failure_code_counts: failureCodes,
        by_ats: Object.entries(byAts).map(([ats, v]) => ({ ats, ...v })).slice(0, 20),
        by_host: Object.entries(byHost)
            .map(([host, v]) => ({ host, ...v }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 20)
    };
}

/**
 * Compact playbook string for LLM prompts: STYLE only.
 * Never includes past answer text to copy.
 */
function formatPlaybookForPrompt(playbook, { companyName, jobRole } = {}) {
    if (!playbook || !playbook.interview_count) {
        return '';
    }
    const company = companyName || 'this company';
    const role = jobRole || 'this role';
    const lines = [
        'ANSWER STYLE learned from past interview wins (apply the STYLE only — write NEW text for THIS job):',
        `- Overall style: ${playbook.answer_style_description || describeStyle(playbook.answer_style)}`,
        `- CRITICAL: Answers must be unique to ${company} / ${role}. Mention this company’s products, mission, or stack from the JD when relevant.`,
        `- CRITICAL: Do NOT reuse or lightly paraphrase answers written for another company (e.g. Google vs Amazon must read differently).`,
        '- Salary: filled separately per job from THAT JD’s range — never invent or copy a past dollar amount.'
    ];
    for (const s of playbook.styles_by_cluster || []) {
        if (!s.sample_count) continue;
        lines.push(`- For [${s.cluster}] questions: ${s.description}`);
    }
    return lines.join('\n');
}

function getPlaybookForAnswers({ userId, profileId, jobRole, companyName } = {}) {
    const insights = buildBidInsights({ userId, profileId, jobRole });
    return {
        playbook: insights.playbook,
        promptBlock: formatPlaybookForPrompt(insights.playbook, { companyName, jobRole })
    };
}

/**
 * Compact pack for Instruct Lumi / auto-fix — all course outcomes, not only interviews.
 */
function buildAssistantContext({ userId, profileId, host = '', limit = 200 } = {}) {
    const params = [parseInt(userId, 10)];
    let profileClause = '';
    if (profileId) {
        profileClause = ' AND c.profile_id = ? ';
        params.push(parseInt(profileId, 10));
    }
    params.push(Math.min(Math.max(limit, 20), 400));
    const courses = getAll(
        `SELECT c.id, c.application_id, c.company_name, c.job_role, c.outcome,
                c.job_url, c.filled_at, c.applied_at, c.started_at,
                (SELECT e.event_type FROM bid_course_events e
                 WHERE e.course_id = c.id
                 ORDER BY e.at DESC, e.id DESC LIMIT 1) AS last_event_type,
                (SELECT e.meta_json FROM bid_course_events e
                 WHERE e.course_id = c.id
                 ORDER BY e.at DESC, e.id DESC LIMIT 1) AS last_event_meta
         FROM bid_courses c
         WHERE c.user_id = ?
         ${profileClause}
         ORDER BY COALESCE(c.applied_at, c.filled_at, c.updated_at, c.created_at) DESC
         LIMIT ?`,
        params
    );

    const counts = { total: courses.length, success: 0, failed: 0, filled: 0, unknown: 0 };
    const byHost = new Map();
    const failureCounts = new Map();
    const winningFixes = [];

    const hostOf = (url) => {
        try {
            return new URL(String(url || '')).hostname.replace(/^www\./i, '').toLowerCase();
        } catch {
            return '';
        }
    };

    for (const c of courses) {
        const h = hostOf(c.job_url) || 'unknown';
        if (!byHost.has(h)) byHost.set(h, { host: h, success: 0, failed: 0, filled: 0, total: 0 });
        const row = byHost.get(h);
        row.total += 1;
        const outcome = String(c.outcome || '');
        const last = String(c.last_event_type || '');
        if (outcome === 'applied' || outcome === 'interview' || /marked_applied|submit_success/i.test(last)) {
            counts.success += 1;
            row.success += 1;
        } else if (/fill_incomplete|submit_blocked|fill_failed|open_failed|blocked_ats|item_aborted/i.test(last)
            || outcome === 'rejected') {
            counts.failed += 1;
            row.failed += 1;
            failureCounts.set(last || 'failed', (failureCounts.get(last || 'failed') || 0) + 1);
            let meta = {};
            try {
                meta = c.last_event_meta ? JSON.parse(c.last_event_meta) : {};
            } catch (_) { /* ignore */ }
            const miss = Array.isArray(meta.missing) ? meta.missing[0] : '';
            if (miss) {
                const key = String(miss).toLowerCase().includes('location')
                    ? 'location|no_dropdown_match'
                    : `missing|${String(miss).slice(0, 40)}`;
                failureCounts.set(key, (failureCounts.get(key) || 0) + 1);
            }
        } else if (c.filled_at || /awaiting_manual_submit|package_saved|reautofill_done|fill_done/i.test(last)) {
            counts.filled += 1;
            row.filled += 1;
        } else {
            counts.unknown += 1;
        }
        if (/instruction_applied|fill_lesson_applied|location_free_text/i.test(last)
            && (outcome === 'applied' || /marked_applied/i.test(last))) {
            winningFixes.push({
                host: h,
                event: last,
                company: c.company_name || ''
            });
        }
    }

    const hostFilter = String(host || '').replace(/^www\./i, '').toLowerCase();
    let byHostList = [...byHost.values()].sort((a, b) => b.total - a.total).slice(0, 15);
    if (hostFilter) {
        const match = byHostList.filter((r) => r.host === hostFilter || r.host.endsWith(`.${hostFilter}`));
        if (match.length) byHostList = [...match, ...byHostList.filter((r) => r !== match[0])].slice(0, 15);
    }

    const topFailures = [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([signature, n]) => ({ signature, n }));

    return {
        counts,
        by_host: byHostList,
        top_failures: topFailures,
        winning_fixes: winningFixes.slice(0, 10),
        generated_at: new Date().toISOString()
    };
}

module.exports = {
    buildBidInsights,
    buildBidderOps,
    buildAssistantContext,
    formatPlaybookForPrompt,
    getPlaybookForAnswers,
    normalizeQuestionLabel,
    analyzeAnswerStyle,
    describeStyle
};
