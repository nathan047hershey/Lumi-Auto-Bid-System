/**
 * Bidder Brain (v1) — server-side engine for Auto Bidder only.
 * Autofill continues to use applicationAnswersService unchanged.
 *
 * Features locked by product:
 * - Stronger answers (no invented employers, longer essays, JD keywords)
 * - Playbook: style rules + few-shot from interview-winning courses
 * - CV quality gate (regenerate signal)
 * - Field-attempt logging for Bid Courses
 */
const { getAll, getOne, runQuery } = require('../config/database');
const { generateApplicationAnswers } = require('./applicationAnswersService');
const { getPlaybookForAnswers } = require('./bidInsightsService');

const ENGINE_VERSION = 'bidder-engine-v1.1';
const FAMOUS = [
    'Google', 'Alphabet', 'YouTube', 'Meta', 'Facebook', 'Amazon', 'AWS', 'Apple',
    'Microsoft', 'Netflix', 'Uber', 'Airbnb', 'Twitter', 'LinkedIn', 'Stripe',
    'Shopify', 'Salesforce', 'Oracle', 'IBM', 'Intel', 'NVIDIA', 'OpenAI', 'Anthropic'
];

function ensureFieldAttemptTable() {
    try {
        runQuery(`
      CREATE TABLE IF NOT EXISTS bidder_field_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL,
        course_id INTEGER,
        engine_version TEXT,
        page_index INTEGER DEFAULT 0,
        field_id TEXT,
        field_label TEXT,
        field_kind TEXT,
        wanted TEXT,
        chosen TEXT,
        ok INTEGER DEFAULT 0,
        strategy TEXT,
        attempt_n INTEGER DEFAULT 1,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    } catch (_) { /* ignore */ }
}

function extractEmployersFromText(text) {
    const hay = String(text || '');
    const found = new Set();
    for (const name of FAMOUS) {
        const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(hay)) found.add(name);
    }
    // Also pull "at Company" patterns
    const at = hay.match(/\bat\s+([A-Z][A-Za-z0-9&.\- ]{2,40})/g) || [];
    for (const m of at) {
        const name = m.replace(/^at\s+/i, '').trim();
        if (name.length > 2) found.add(name);
    }
    return [...found];
}

function jdKeywords(jobDescription, limit = 12) {
    const stop = new Set(('the a an and or for to of in on with as is are be by from at this that we you our their').split(' '));
    const words = String(jobDescription || '')
        .toLowerCase()
        .replace(/[^a-z0-9+#.\s-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stop.has(w));
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([w]) => w);
}

function fewShotFromInterviews({ userId, profileId, jobRole, limit = 6 } = {}) {
    const params = [];
    let where = `c.outcome = 'interview' AND c.answers_json IS NOT NULL AND TRIM(c.answers_json) <> ''`;
    if (userId) {
        where += ' AND c.user_id = ?';
        params.push(parseInt(userId, 10));
    }
    if (profileId) {
        where += ' AND c.profile_id = ?';
        params.push(parseInt(profileId, 10));
    }
    params.push(Math.min(Math.max(limit, 1), 12));
    const rows = getAll(
        `SELECT c.company_name, c.job_role, c.answers_json
         FROM bid_courses c
         WHERE ${where}
         ORDER BY COALESCE(c.applied_at, c.filled_at, c.updated_at) DESC
         LIMIT ?`,
        params
    );
    const shots = [];
    for (const row of rows) {
        let answers = [];
        try {
            answers = JSON.parse(row.answers_json);
        } catch {
            continue;
        }
        if (!Array.isArray(answers)) continue;
        for (const a of answers.slice(0, 3)) {
            const label = String(a.label || a.id || '').trim();
            const answer = String(a.answer || a.value || '').trim();
            if (!label || answer.length < 40) continue;
            if (jobRole && row.job_role) {
                // soft prefer similar roles — still include others
            }
            shots.push({
                company: row.company_name,
                role: row.job_role,
                label,
                answer: answer.slice(0, 600)
            });
            if (shots.length >= limit) return shots;
        }
    }
    return shots;
}

function buildBidderPromptExtras({
    userId,
    profileId,
    jobRole,
    companyName,
    jobDescription,
    resumeHtml,
    workExperience
} = {}) {
    let promptBlock = '';
    try {
        const play = getPlaybookForAnswers({
            userId,
            profileId,
            jobRole,
            companyName
        });
        promptBlock = play?.promptBlock || '';
    } catch (_) {
        promptBlock = '';
    }
    const allowed = new Set([
        ...extractEmployersFromText(resumeHtml),
        ...extractEmployersFromText(workExperience)
    ]);
    const keywords = jdKeywords(jobDescription);
    let fewShot = [];
    try {
        fewShot = fewShotFromInterviews({ userId, profileId, jobRole, limit: 6 });
    } catch (_) {
        fewShot = [];
    }

    const lines = [
        '=== BIDDER ENGINE RULES (human form answers) ===',
        '- Write SHORT answers (1–3 sentences / ~35–70 words for "why" questions). Not essays.',
        '- Sound like a person filling a form, not an AI cover letter.',
        '- Mirror JD keywords naturally when true for the candidate.',
        `- JD keyword hints: ${keywords.join(', ') || '(none)'}`,
        '- NEVER invent employers, schools, or metrics not supported by the resume/profile.',
        `- Allowed employer names only if present in resume/WE: ${[...allowed].join(', ') || '(none from resume — do not name famous companies)'}`,
        '- If a famous company is not in the allow-list, do not mention it.',
        '- For rationale/evidence questions: use real grades/scores only — never a lone state name.',
        '- Tailor every answer to THIS company and role; do not reuse another company\'s pitch.',
        promptBlock || ''
    ];

    // Few-shot examples often make the model sound like ChatGPT — skip by default.
    if (fewShot.length && process.env.BIDDER_FEW_SHOT === '1') {
        lines.push('=== FEW-SHOT STYLE EXAMPLES from past INTERVIEW wins (STYLE + structure only — write NEW content for this job) ===');
        fewShot.forEach((s, i) => {
            lines.push(`Example ${i + 1} [${s.company} / ${s.role}] Q: ${s.label}`);
            lines.push(`A (do not copy): ${s.answer}`);
        });
    }

    return {
        engine_version: ENGINE_VERSION,
        extrasBlock: lines.filter(Boolean).join('\n'),
        allowedEmployers: [...allowed],
        keywords,
        fewShotCount: fewShot.length
    };
}

/**
 * Patch written answers after LLM: strip famous employers not in allow-list.
 */
function hardenAnswers(answers, allowedEmployers) {
    const allow = new Set((allowedEmployers || []).map((a) => a.toLowerCase()));
    const loneState = /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i;
    return (answers || []).map((a) => {
        let text = String(a.answer || a.value || '');
        const label = String(a.label || a.question || '').toLowerCase();
        // Never leave a lone US state as the answer to rationale / evidence / grades.
        if (loneState.test(text.trim())
            && /rationale|evidence|high school|degree result|grading|performance|score|gpa|grade/.test(label)) {
            text = '';
        } else if (loneState.test(text.trim()) && text.trim().length < 20) {
            // Label missing — still drop bare state names as standalone answers.
            text = '';
        }
        for (const name of FAMOUS) {
            if (allow.has(name.toLowerCase())) continue;
            const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
            if (!re.test(text)) continue;
            text = text
                .replace(new RegExp(`\\bat\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'in a prior role')
                .replace(re, 'a prior company');
        }
        text = text.replace(/\s{2,}/g, ' ').trim();
        return { ...a, answer: text };
    });
}

async function generateBidderAnswers(opts = {}) {
    const {
        profile,
        jobDescription,
        resumeHtml,
        questions,
        companyName,
        jobRole,
        userId
    } = opts;

    const extras = buildBidderPromptExtras({
        userId,
        profileId: profile?.id,
        jobRole,
        companyName,
        jobDescription,
        resumeHtml,
        workExperience: profile?.work_experience
    });

    const result = await generateApplicationAnswers({
        profile,
        jobDescription,
        resumeHtml,
        questions,
        companyName,
        jobRole,
        userId,
        bidderMode: true,
        promptExtras: extras.extrasBlock
    });

    const hardened = hardenAnswers(result.answers, extras.allowedEmployers);
    return {
        ...result,
        answers: hardened,
        engine_version: ENGINE_VERSION,
        bidder_meta: {
            keywords: extras.keywords,
            few_shot_count: extras.fewShotCount,
            allowed_employers: extras.allowedEmployers
        }
    };
}

/**
 * Lightweight CV quality gate for Bidder. Returns { ok, reasons, shouldRegenerate }.
 */
function assessCvQuality({ draftHtml, jobDescription, resumeFilename } = {}) {
    const reasons = [];
    const html = String(draftHtml || '');
    const jd = String(jobDescription || '');
    if (!resumeFilename) reasons.push('missing_resume_file');
    if (html.trim().length < 400) reasons.push('draft_too_short');
    const kws = jdKeywords(jd, 8);
    const hit = kws.filter((k) => html.toLowerCase().includes(k)).length;
    if (kws.length >= 4 && hit < Math.ceil(kws.length * 0.25)) {
        reasons.push('low_jd_keyword_overlap');
    }
    // Hallucination sniff: famous employers in CV text — soft warn only
    const ok = reasons.length === 0;
    return {
        ok,
        shouldRegenerate: !ok,
        reasons,
        keyword_hits: hit,
        keyword_total: kws.length,
        engine_version: ENGINE_VERSION
    };
}

function logFieldAttempt(row = {}) {
    ensureFieldAttemptTable();
    runQuery(
        `INSERT INTO bidder_field_attempts
          (application_id, course_id, engine_version, page_index, field_id, field_label,
           field_kind, wanted, chosen, ok, strategy, attempt_n, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            parseInt(row.application_id, 10),
            row.course_id != null ? parseInt(row.course_id, 10) : null,
            row.engine_version || ENGINE_VERSION,
            row.page_index || 0,
            String(row.field_id || '').slice(0, 140),
            String(row.field_label || '').slice(0, 240),
            String(row.field_kind || '').slice(0, 80),
            String(row.wanted || '').slice(0, 500),
            String(row.chosen || '').slice(0, 500),
            row.ok ? 1 : 0,
            String(row.strategy || '').slice(0, 80),
            row.attempt_n || 1,
            row.error ? String(row.error).slice(0, 400) : null
        ]
    );
}

function listFieldAttempts(applicationId, limit = 200) {
    ensureFieldAttemptTable();
    return getAll(
        `SELECT * FROM bidder_field_attempts
         WHERE application_id = ?
         ORDER BY id ASC
         LIMIT ?`,
        [parseInt(applicationId, 10), Math.min(limit, 500)]
    );
}

function ensureFillLessonTable() {
    try {
        runQuery(`
      CREATE TABLE IF NOT EXISTS bidder_fill_lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        profile_id INTEGER,
        host TEXT NOT NULL,
        field_key TEXT NOT NULL,
        issue_key TEXT NOT NULL,
        instruction TEXT,
        actions_json TEXT,
        ats TEXT,
        source TEXT,
        hit_count INTEGER DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, host, field_key, issue_key)
      )
    `);
    } catch (_) { /* ignore */ }
}

function upsertFillLesson(row = {}) {
    ensureFillLessonTable();
    const userId = parseInt(row.user_id, 10);
    const host = String(row.host || '').replace(/^www\./i, '').toLowerCase().slice(0, 160);
    const fieldKey = String(row.field_key || row.fieldKey || 'form').slice(0, 80);
    const issueKey = String(row.issue_key || row.issueKey || 'user_instruct').slice(0, 120);
    if (!userId || !host) return null;
    const instruction = String(row.instruction || '').slice(0, 500);
    const actionsJson = typeof row.actions_json === 'string'
        ? row.actions_json
        : JSON.stringify(row.actions || row.actions_json || {});
    const existing = getOne(
        `SELECT id, hit_count FROM bidder_fill_lessons
         WHERE user_id = ? AND host = ? AND field_key = ? AND issue_key = ?`,
        [userId, host, fieldKey, issueKey]
    );
    if (existing?.id) {
        runQuery(
            `UPDATE bidder_fill_lessons
             SET instruction = ?, actions_json = ?, ats = ?, source = ?,
                 profile_id = COALESCE(?, profile_id),
                 hit_count = COALESCE(hit_count, 0) + 1,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                instruction,
                actionsJson,
                String(row.ats || '').slice(0, 80),
                String(row.source || 'user_instruct').slice(0, 40),
                row.profile_id != null ? parseInt(row.profile_id, 10) : null,
                existing.id
            ]
        );
        return getOne(`SELECT * FROM bidder_fill_lessons WHERE id = ?`, [existing.id]);
    }
    runQuery(
        `INSERT INTO bidder_fill_lessons
          (user_id, profile_id, host, field_key, issue_key, instruction, actions_json, ats, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            row.profile_id != null ? parseInt(row.profile_id, 10) : null,
            host,
            fieldKey,
            issueKey,
            instruction,
            actionsJson,
            String(row.ats || '').slice(0, 80),
            String(row.source || 'user_instruct').slice(0, 40)
        ]
    );
    return getOne(
        `SELECT * FROM bidder_fill_lessons
         WHERE user_id = ? AND host = ? AND field_key = ? AND issue_key = ?`,
        [userId, host, fieldKey, issueKey]
    );
}

function listFillLessons({ userId, profileId, host = '', limit = 40 } = {}) {
    ensureFillLessonTable();
    const params = [parseInt(userId, 10)];
    let where = 'user_id = ?';
    if (profileId) {
        where += ' AND (profile_id IS NULL OR profile_id = ?)';
        params.push(parseInt(profileId, 10));
    }
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    if (h) {
        where += ' AND host = ?';
        params.push(h);
    }
    params.push(Math.min(Math.max(limit, 1), 100));
    return getAll(
        `SELECT * FROM bidder_fill_lessons
         WHERE ${where}
         ORDER BY updated_at DESC
         LIMIT ?`,
        params
    ).map((row) => {
        let actions = null;
        try {
            actions = row.actions_json ? JSON.parse(row.actions_json) : null;
        } catch (_) {
            actions = null;
        }
        return {
            id: row.id,
            host: row.host,
            fieldKey: row.field_key,
            issueKey: row.issue_key,
            instruction: row.instruction,
            actions,
            ats: row.ats,
            source: row.source,
            hitCount: row.hit_count,
            updatedAt: row.updated_at
        };
    });
}

function clearFillLessonsForHost({ userId, host } = {}) {
    ensureFillLessonTable();
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    if (!userId || !h) return { ok: false, reason: 'missing' };
    runQuery(
        `DELETE FROM bidder_fill_lessons WHERE user_id = ? AND host = ?`,
        [parseInt(userId, 10), h]
    );
    return { ok: true, host: h };
}

module.exports = {
    ENGINE_VERSION,
    ensureFieldAttemptTable,
    ensureFillLessonTable,
    generateBidderAnswers,
    assessCvQuality,
    logFieldAttempt,
    listFieldAttempts,
    upsertFillLesson,
    listFillLessons,
    clearFillLessonsForHost,
    buildBidderPromptExtras
};
