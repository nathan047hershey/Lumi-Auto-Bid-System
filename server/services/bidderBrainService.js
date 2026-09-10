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

function normalizeAnswerLabel(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/\*\s*$/g, '')
        .trim();
}

/** Load saved answers from artifact file and/or bid_courses.answers_json. */
function loadSavedAnswersForApplication(applicationId) {
    const appId = parseInt(applicationId, 10);
    if (!Number.isInteger(appId) || appId <= 0) return [];
    const out = [];
    const seen = new Set();
    const pushAll = (list) => {
        for (const a of list || []) {
            if (!a) continue;
            const ans = String(a.answer || a.value || '').trim();
            if (!ans) continue;
            const key = `${a.id || ''}::${normalizeAnswerLabel(a.label)}::${ans.slice(0, 80)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(a);
        }
    };
    try {
        const artifacts = require('./bidderArtifactService');
        pushAll(artifacts.readAnswers(appId));
    } catch (_) { /* ignore */ }
    try {
        const { getCourseByApplicationId } = require('./bidCourseService');
        const course = getCourseByApplicationId(appId);
        pushAll(course?.answers);
    } catch (_) { /* ignore */ }
    return out;
}

/**
 * Match saved answers onto the current form questions (by id, then label).
 * Returns { reused, missing }.
 */
function mapSavedAnswersToQuestions(savedList, questions) {
    const byId = new Map();
    const byLabel = new Map();
    for (const a of savedList || []) {
        if (!a) continue;
        const ans = String(a.answer || a.value || '').trim();
        if (!ans) continue;
        if (a.id != null && a.id !== '') byId.set(String(a.id), a);
        const lab = normalizeAnswerLabel(a.label);
        if (lab) byLabel.set(lab, a);
    }
    const reused = [];
    const missing = [];
    for (const q of questions || []) {
        const hit = (q?.id != null && byId.get(String(q.id)))
            || byLabel.get(normalizeAnswerLabel(q?.label));
        const text = hit ? String(hit.answer || hit.value || '').trim() : '';
        if (text) {
            reused.push({
                id: q.id,
                label: q.label,
                answer: text,
                answer_type: hit.answer_type || q.answer_type || 'written',
                source: 'cached',
                match_source: 'saved_answers_reuse',
                kind: q.kind || hit.kind,
                lane: hit.lane,
                knockout: hit.knockout,
                options: q.options?.length ? q.options : hit.options
            });
        } else {
            missing.push(q);
        }
    }
    return { reused, missing };
}

function persistBidderAnswers(applicationId, answers, {
    profileId,
    userId,
    companyName,
    jobRole,
    answersProvider,
    answersModel
} = {}) {
    const appId = parseInt(applicationId, 10);
    if (!Number.isInteger(appId) || appId <= 0 || !Array.isArray(answers) || !answers.length) {
        return false;
    }
    try {
        const artifacts = require('./bidderArtifactService');
        artifacts.saveCoursePackage(appId, {
            answers,
            meta: {
                saved_at: new Date().toISOString(),
                reason: 'bidder_answers_ready',
                count: answers.length,
                provider: answersProvider || null,
                model: answersModel || null
            }
        });
    } catch (err) {
        console.warn('[bidder] artifact answers save failed:', err?.message || err);
    }
    try {
        const { upsertCourse, getCourseByApplicationId } = require('./bidCourseService');
        const existing = getCourseByApplicationId(appId);
        upsertCourse({
            applicationId: appId,
            profileId: profileId || existing?.profile_id,
            userId: userId || existing?.user_id,
            companyName: companyName || existing?.company_name,
            jobRole: jobRole || existing?.job_role,
            answers,
            answersProvider: answersProvider || existing?.answers_provider || null,
            answersModel: answersModel || existing?.answers_model || null,
            skipEvent: true
        });
    } catch (err) {
        console.warn('[bidder] course answers save failed:', err?.message || err);
    }
    return true;
}

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
        '- Write the SHORTEST clear answers (1 sentence preferred; 2 max / ~18–40 words for "why" questions). Hard cap 50 words. Not essays.',
        '- Sound like a person filling a form, not an AI cover letter.',
        '- Plain text only: no markdown, bold, italics, bullets, or long dashes (— –).',
        '- Unique to THIS profile + THIS CV + THIS JD. Never reuse another profile\'s wording.',
        '- Base every claim on the generated resume / work history; aim wording at the JD.',
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
        userId,
        applicationId = null,
        forceRegenerate = false
    } = opts;

    const questionList = Array.isArray(questions) ? questions : [];
    const appId = applicationId != null ? parseInt(applicationId, 10) : 0;

    // Reuse saved answers on rebid after skip — avoid another LLM bill.
    let reused = [];
    let missingQs = questionList;
    if (!forceRegenerate && Number.isInteger(appId) && appId > 0 && questionList.length) {
        const mapped = mapSavedAnswersToQuestions(loadSavedAnswersForApplication(appId), questionList);
        reused = mapped.reused;
        missingQs = mapped.missing;
        // Full hit → return immediately (no API).
        if (reused.length && missingQs.length === 0) {
            return {
                answers: reused,
                skipped: [],
                provider: 'cache',
                model: 'saved_answers',
                written_count: questionList.length,
                written_filled: reused.length,
                studying: false,
                memory_hits: 0,
                reused: true,
                reused_count: reused.length,
                generated_count: 0,
                engine_version: ENGINE_VERSION,
                bidder_meta: {
                    keywords: [],
                    few_shot_count: 0,
                    allowed_employers: [],
                    answers_reused: true
                }
            };
        }
    }

    const extras = buildBidderPromptExtras({
        userId,
        profileId: profile?.id,
        jobRole,
        companyName,
        jobDescription,
        resumeHtml,
        workExperience: profile?.work_experience
    });

    const toGenerate = missingQs.length ? missingQs : questionList;
    const result = await generateApplicationAnswers({
        profile,
        jobDescription,
        resumeHtml,
        questions: toGenerate,
        companyName,
        jobRole,
        userId,
        bidderMode: true,
        promptExtras: extras.extrasBlock
    });

    const hardenedNew = hardenAnswers(result.answers, extras.allowedEmployers);
    const byKey = new Map();
    for (const a of reused) {
        const k = a?.id != null && a.id !== ''
            ? `id:${a.id}`
            : `lab:${normalizeAnswerLabel(a.label)}`;
        byKey.set(k, a);
    }
    for (const a of hardenedNew) {
        const k = a?.id != null && a.id !== ''
            ? `id:${a.id}`
            : `lab:${normalizeAnswerLabel(a.label)}`;
        byKey.set(k, a); // fresh LLM wins over cache for that question
    }
    const merged = [];
    const used = new Set();
    for (const q of questionList) {
        const k = q?.id != null && q.id !== ''
            ? `id:${q.id}`
            : `lab:${normalizeAnswerLabel(q.label)}`;
        const hit = byKey.get(k);
        if (hit) {
            merged.push(hit);
            used.add(k);
        }
    }
    for (const [k, a] of byKey) {
        if (!used.has(k)) merged.push(a);
    }

    const out = {
        ...result,
        answers: merged,
        reused: reused.length > 0,
        reused_count: reused.length,
        generated_count: hardenedNew.length,
        engine_version: ENGINE_VERSION,
        bidder_meta: {
            keywords: extras.keywords,
            few_shot_count: extras.fewShotCount,
            allowed_employers: extras.allowedEmployers,
            answers_reused: reused.length > 0,
            reused_count: reused.length,
            generated_count: hardenedNew.length
        }
    };

    // Persist as soon as answers exist so skip/rebid can reuse without regenerating.
    if (Number.isInteger(appId) && appId > 0 && merged.length) {
        persistBidderAnswers(appId, merged, {
            profileId: profile?.id,
            userId,
            companyName,
            jobRole,
            answersProvider: out.provider,
            answersModel: out.model
        });
    }

    return out;
}

/**
 * CV quality gate for Bidder — file presence, clean upload name, content quality.
 * Returns { ok, reasons, shouldRegenerate, quality, critical_count, ... }.
 */
function assessCvQuality({
    draftHtml,
    jobDescription,
    resumeFilename,
    uploadFilename,
    profile
} = {}) {
    const reasons = [];
    const html = String(draftHtml || '');
    const jd = String(jobDescription || '');
    const archiveName = String(resumeFilename || '').trim();
    const uploadName = String(uploadFilename || '').trim();

    if (!archiveName) reasons.push('missing_resume_file');

    // Messy archive names must not be what ATS sees; upload name must be First_Last.ext
    const nameToJudge = uploadName || archiveName;
    if (nameToJudge) {
        if (/^resume_/i.test(nameToJudge) || /_\d{10,}\./.test(nameToJudge)) {
            reasons.push('dirty_resume_filename');
        } else if (!/^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z][A-Za-z0-9]*){0,2}\.(docx?|pdf)$/i.test(nameToJudge)
            && /^resume_/i.test(archiveName)) {
            // Archive is messy and no clean upload name provided
            reasons.push('dirty_resume_filename');
        }
    }

    if (html.trim().length < 400) reasons.push('draft_too_short');

    let quality = null;
    try {
        const { buildResumeQualityReport } = require('./resumeQualityReportService');
        quality = buildResumeQualityReport(html, {
            profile: profile || {},
            jobDescription: jd
        });
        if (quality && quality.pass === false && (quality.critical_count || 0) > 0) {
            reasons.push('quality_critical');
        }
        if (quality && Number(quality.score || 0) < 70) {
            reasons.push('quality_score_low');
        }
    } catch (err) {
        console.warn('[bidder] quality report skipped:', err.message);
    }

    const kws = jdKeywords(jd, 8);
    const hit = kws.filter((k) => html.toLowerCase().includes(k)).length;
    if (kws.length >= 4 && hit < Math.ceil(kws.length * 0.25)) {
        reasons.push('low_jd_keyword_overlap');
    }

    // Hard blockers for submit (soft keyword overlap alone does not block).
    const hardReasons = reasons.filter((r) => (
        r === 'missing_resume_file'
        || r === 'dirty_resume_filename'
        || r === 'draft_too_short'
        || r === 'quality_critical'
        || r === 'quality_score_low'
    ));
    const ok = hardReasons.length === 0;
    return {
        ok,
        shouldRegenerate: reasons.includes('missing_resume_file')
            || reasons.includes('draft_too_short')
            || reasons.includes('quality_critical')
            || reasons.includes('quality_score_low')
            || reasons.includes('low_jd_keyword_overlap'),
        blockSubmit: !ok,
        reasons,
        hard_reasons: hardReasons,
        keyword_hits: hit,
        keyword_total: kws.length,
        quality: quality
            ? {
                pass: quality.pass,
                score: quality.score,
                grade: quality.grade,
                critical_count: quality.critical_count,
                warn_count: quality.warn_count,
                summary: quality.summary,
                issues: (quality.issues || []).slice(0, 8).map((i) => ({
                    id: i.id,
                    severity: i.severity,
                    message: i.message
                }))
            }
            : null,
        resume_filename: archiveName || null,
        upload_filename: uploadName || null,
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
    loadSavedAnswersForApplication,
    mapSavedAnswersToQuestions,
    persistBidderAnswers,
    assessCvQuality,
    logFieldAttempt,
    listFieldAttempts,
    upsertFillLesson,
    listFillLessons,
    clearFillLessonsForHost,
    buildBidderPromptExtras
};
