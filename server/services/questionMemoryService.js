/**
 * Studying Engine — question → Policy/Profile answer memory (vector + Jaccard).
 * Unique / essay answers are never stored here.
 */
const crypto = require('crypto');
const axios = require('axios');
const { getAll, getOne, runQuery, saveDatabase } = require('../config/database');
const { getLocalLlmConfig } = require('./settingsService');

const STUDYING_ENGINE = () => String(process.env.STUDYING_ENGINE || '1').trim() !== '0';
const QUESTION_MEMORY = () => String(process.env.QUESTION_MEMORY || '1').trim() !== '0';

const TAU = {
    knockout: 0.86,
    default: 0.82
};
const GAP = {
    knockout: 0.15,
    default: 0.12
};

const KNOCKOUT_KINDS = new Set([
    'disability_status',
    'requires_sponsorship',
    'work_authorization',
    'previous_employer_no',
    'sanctioned_countries_no',
    'background_check_yes',
    'non_compete_no'
]);

const POLICY_KINDS = new Set([
    ...KNOCKOUT_KINDS,
    'salary_comfort_yes',
    'onsite_hub_yes',
    'us_person_yes',
    'export_control_us_citizen',
    'immigration_na_if_citizen',
    'over_18',
    'veteran_status',
    'gender',
    'race_ethnicity',
    'hispanic_latino'
]);

/** In-process embed cache: model|hash → Float32Array|number[] */
const embedCache = new Map();
const MAX_USER_ROWS = 500;

function studyingEnabled() {
    return STUDYING_ENGINE() && QUESTION_MEMORY();
}

function ensureQuestionMemoryTable() {
    runQuery(`
      CREATE TABLE IF NOT EXISTS bidder_question_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        kind TEXT NOT NULL,
        question_text TEXT NOT NULL,
        question_norm TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        embedding_json TEXT,
        embed_model TEXT,
        source TEXT DEFAULT 'seed',
        knockout INTEGER DEFAULT 0,
        disabled INTEGER DEFAULT 0,
        hit_count INTEGER DEFAULT 0,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    try {
        runQuery(`CREATE INDEX IF NOT EXISTS idx_bqm_kind ON bidder_question_memory(kind)`);
        runQuery(`CREATE INDEX IF NOT EXISTS idx_bqm_user ON bidder_question_memory(user_id)`);
        runQuery(`CREATE INDEX IF NOT EXISTS idx_bqm_norm ON bidder_question_memory(question_norm)`);
    } catch (_) { /* ignore */ }
}

function normalizeQuestion(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s?']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
}

function hashText(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);
}

function tokenize(text) {
    return new Set(
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 1)
    );
}

function jaccard(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter += 1;
    return inter / (A.size + B.size - inter);
}

function cosine(a, b) {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        const x = Number(a[i]) || 0;
        const y = Number(b[i]) || 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (!na || !nb) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function withDocPrefix(text) {
    return `search_document: ${String(text || '').trim()}`;
}

function withQueryPrefix(text) {
    return `search_query: ${String(text || '').trim()}`;
}

async function embedOllama(text, { task = 'document' } = {}) {
    const local = getLocalLlmConfig();
    const base = String(local?.baseUrl || process.env.OLLAMA_BASE || 'http://127.0.0.1:11434')
        .replace(/\/v1\/?$/, '')
        .replace(/\/$/, '');
    const model = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
    const prefixed = task === 'query' ? withQueryPrefix(text) : withDocPrefix(text);
    const cacheKey = `${model}|${task}|${hashText(prefixed)}`;
    if (embedCache.has(cacheKey)) return { vector: embedCache.get(cacheKey), model, source: 'cache' };

    try {
        const res = await axios.post(
            `${base}/api/embeddings`,
            { model, prompt: prefixed },
            { timeout: 8000 }
        );
        const vector = res.data?.embedding;
        if (!Array.isArray(vector) || !vector.length) {
            return { vector: null, model, source: 'miss' };
        }
        embedCache.set(cacheKey, vector);
        return { vector, model, source: 'ollama' };
    } catch {
        return { vector: null, model, source: 'fallback' };
    }
}

async function embedText(text, { task = 'document' } = {}) {
    if (String(process.env.QUESTION_MEMORY_EMBED || '1').trim() === '0') {
        return { vector: null, model: 'jaccard', source: 'disabled' };
    }
    return embedOllama(text, { task });
}

const SEED_ROWS = [
    // Policy positives
    { kind: 'disability_status', q: 'Please indicate if you have a disability under the ADA', a: 'No, I do not have a disability', knockout: 1 },
    { kind: 'disability_status', q: 'Do you have a disability?', a: 'No, I do not have a disability', knockout: 1 },
    { kind: 'disability_status', q: 'Disability status / ADA self-identification', a: 'No, I do not have a disability', knockout: 1 },
    { kind: 'disability_status', q: 'Please indicate if you have a disability or have had one in the past', a: 'No, I do not have a disability', knockout: 1 },
    { kind: 'disability_status', q: 'I do not want to answer disability questions', a: 'No, I do not have a disability', knockout: 1 },
    { kind: 'requires_sponsorship', q: 'Will you now or in the future require visa sponsorship?', a: 'No', knockout: 1 },
    { kind: 'requires_sponsorship', q: 'Do you require sponsorship to work in the United States?', a: 'No', knockout: 1 },
    { kind: 'requires_sponsorship', q: 'Will you need an employer to sponsor a work visa?', a: 'No', knockout: 1 },
    { kind: 'work_authorization', q: 'Are you legally authorized to work in the United States?', a: 'Yes', knockout: 1 },
    { kind: 'work_authorization', q: 'Are you authorized to work in this country without sponsorship?', a: 'Yes', knockout: 1 },
    { kind: 'previous_employer_no', q: 'Have you ever worked for this company?', a: 'No', knockout: 1 },
    { kind: 'previous_employer_no', q: 'Are you a former employee or contractor?', a: 'No', knockout: 1 },
    { kind: 'previous_employer_no', q: 'Have you previously been employed by us?', a: 'No', knockout: 1 },
    { kind: 'salary_comfort_yes', q: 'Are you comfortable with the salary outlined in the job description?', a: 'Yes', knockout: 0 },
    { kind: 'salary_comfort_yes', q: 'Is the posted compensation range acceptable?', a: 'Yes', knockout: 0 },
    { kind: 'sanctioned_countries_no', q: 'Do you permanently reside in Cuba, Iran, North Korea, or Syria?', a: 'No', knockout: 1 },
    { kind: 'background_check_yes', q: 'Are you willing to undergo a background check?', a: 'Yes', knockout: 1 },
    { kind: 'background_check_yes', q: 'I consent to a background investigation', a: 'Yes', knockout: 1 },
    { kind: 'non_compete_no', q: 'Are you subject to a non-compete agreement?', a: 'No', knockout: 1 },
    { kind: 'non_compete_no', q: 'Do you have a non-compete that would restrict this role?', a: 'No', knockout: 1 },
    { kind: 'onsite_hub_yes', q: 'Are you open to working from an office hub a few days a week?', a: 'Yes', knockout: 0 },
    { kind: 'over_18', q: 'Are you 18 years of age or older?', a: 'Yes', knockout: 0 },
    // Hard negatives — must never win as Policy
    { kind: '_hard_negative', q: 'Disability insurance coverage preference', a: '', knockout: 0, disabled: 1, note: 'hard_neg' },
    { kind: '_hard_negative', q: 'Tell us about a time you overcame a disability in your career narrative', a: '', knockout: 0, disabled: 1, note: 'hard_neg' },
    { kind: '_hard_negative', q: 'Company sponsorship programs you have managed as a people leader', a: '', knockout: 0, disabled: 1, note: 'hard_neg' },
    { kind: '_hard_negative', q: 'Years of experience with React', a: '', knockout: 0, disabled: 1, note: 'hard_neg' },
    { kind: '_hard_negative', q: 'Why are you interested in this role?', a: '', knockout: 0, disabled: 1, note: 'hard_neg' },
    { kind: '_hard_negative', q: 'Expected salary or compensation amount', a: '', knockout: 0, disabled: 1, note: 'hard_neg' },
    { kind: '_hard_negative', q: 'Describe your experience sponsoring junior engineers', a: '', knockout: 0, disabled: 1, note: 'hard_neg' }
];

function seedIfEmpty() {
    ensureQuestionMemoryTable();
    const n = getOne(`SELECT COUNT(*) AS c FROM bidder_question_memory WHERE source = 'seed'`);
    let seeded = 0;
    const existed = Number(n?.c || 0) > 0;
    for (const row of SEED_ROWS) {
        const norm = normalizeQuestion(row.q);
        const found = getOne(
            `SELECT id FROM bidder_question_memory WHERE source = 'seed' AND question_norm = ? LIMIT 1`,
            [norm]
        );
        if (found?.id) continue;
        runQuery(
            `INSERT INTO bidder_question_memory
              (user_id, kind, question_text, question_norm, answer_text, source, knockout, disabled, note)
             VALUES (NULL, ?, ?, ?, ?, 'seed', ?, ?, ?)`,
            [
                row.kind,
                row.q,
                norm,
                row.a || '',
                row.knockout ? 1 : 0,
                row.disabled ? 1 : 0,
                row.note || null
            ]
        );
        seeded += 1;
    }
    if (seeded) {
        try { saveDatabase(); } catch (_) { /* ignore */ }
    }
    return { seeded, existed };
}

async function backfillEmbeddings(limit = 80) {
    ensureQuestionMemoryTable();
    const rows = getAll(
        `SELECT id, question_text FROM bidder_question_memory
         WHERE (embedding_json IS NULL OR TRIM(embedding_json) = '')
           AND kind <> '_hard_negative'
         LIMIT ?`,
        [limit]
    );
    let filled = 0;
    for (const row of rows) {
        const emb = await embedText(row.question_text, { task: 'document' });
        if (!emb.vector) continue;
        runQuery(
            `UPDATE bidder_question_memory SET embedding_json = ?, embed_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [JSON.stringify(emb.vector), emb.model, row.id]
        );
        filled += 1;
    }
    if (filled) {
        try { saveDatabase(); } catch (_) { /* ignore */ }
    }
    return { filled };
}

function parseEmbedding(raw) {
    if (!raw) return null;
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

function scoreRow(queryText, queryVec, row) {
    const emb = parseEmbedding(row.embedding_json);
    if (queryVec && emb && emb.length === queryVec.length) {
        return { score: cosine(queryVec, emb), method: 'cosine' };
    }
    return { score: jaccard(queryText, row.question_text || row.question_norm), method: 'jaccard' };
}

/**
 * Match a question against memory. Fail closed on ambiguity / hard-neg.
 */
async function matchQuestion(questionText, { userId = null, kinds = null } = {}) {
    if (!studyingEnabled()) return { hit: false, reason: 'disabled' };
    ensureQuestionMemoryTable();
    seedIfEmpty();

    const q = String(questionText || '').trim();
    if (!q) return { hit: false, reason: 'empty' };

    const emb = await embedText(q, { task: 'query' });
    const queryVec = emb.vector;

    let sql = `SELECT * FROM bidder_question_memory WHERE disabled = 0 AND kind <> '_hard_negative'`;
    const params = [];
    if (userId != null) {
        sql += ` AND (user_id IS NULL OR user_id = ?)`;
        params.push(parseInt(userId, 10));
    } else {
        sql += ` AND user_id IS NULL`;
    }
    if (Array.isArray(kinds) && kinds.length) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
    }
    sql += ` ORDER BY id DESC LIMIT 600`;

    const rows = getAll(sql, params);
    // Also score hard-negatives separately to reject if they win
    const hardNeg = getAll(
        `SELECT * FROM bidder_question_memory WHERE kind = '_hard_negative' OR (disabled = 1 AND note = 'hard_neg') LIMIT 100`
    );

    const scored = rows.map((row) => {
        const { score, method } = scoreRow(q, queryVec, row);
        return { row, score, method };
    }).filter((x) => x.score > 0.2);

    scored.sort((a, b) => b.score - a.score);

    for (const hn of hardNeg) {
        const { score } = scoreRow(q, queryVec, hn);
        if (scored[0] && score >= scored[0].score - 0.02 && score >= 0.55) {
            return {
                hit: false,
                reason: 'hard_negative',
                top_score: scored[0]?.score,
                hard_neg_score: score,
                failure_code: 'gap_reject'
            };
        }
    }

    if (!scored.length) {
        return { hit: false, reason: 'no_candidates', failure_code: 'policy_miss' };
    }

    const top = scored[0];
    const second = scored[1];
    const kind = top.row.kind;
    const knockout = !!top.row.knockout || KNOCKOUT_KINDS.has(kind);
    const useJaccard = top.method === 'jaccard';
    // Jaccard scores are lower than cosine — use softer τ when embeddings unavailable.
    const tau = useJaccard
        ? (knockout ? 0.42 : 0.38)
        : (knockout ? TAU.knockout : TAU.default);
    const gapNeed = useJaccard
        ? (knockout ? 0.08 : 0.06)
        : (knockout ? GAP.knockout : GAP.default);
    const gap = second ? (top.score - second.score) : 1;

    if (top.score < tau) {
        return {
            hit: false,
            reason: 'below_tau',
            top_score: top.score,
            tau,
            kind,
            failure_code: 'policy_miss'
        };
    }
    if (second && second.row.kind !== top.row.kind && gap < gapNeed) {
        return {
            hit: false,
            reason: 'ambiguous_gap',
            top_score: top.score,
            second_score: second.score,
            gap,
            gapNeed,
            failure_code: 'gap_reject'
        };
    }
    if (!POLICY_KINDS.has(kind) && !String(kind).startsWith('profile_')) {
        return { hit: false, reason: 'kind_not_allowlisted', kind, failure_code: 'policy_miss' };
    }
    if (!String(top.row.answer_text || '').trim()) {
        return { hit: false, reason: 'empty_answer', failure_code: 'policy_miss' };
    }

    try {
        runQuery(
            `UPDATE bidder_question_memory SET hit_count = COALESCE(hit_count,0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [top.row.id]
        );
    } catch (_) { /* ignore */ }

    return {
        hit: true,
        kind,
        answer: top.row.answer_text,
        score: top.score,
        gap,
        method: top.method,
        knockout,
        memory_id: top.row.id,
        match_source: 'question_memory',
        failure_code: knockout ? 'knockout_lock' : null
    };
}

function isEssayLike(answer) {
    const t = String(answer || '').trim();
    if (t.length > 160) return true;
    if ((t.match(/\./g) || []).length >= 2 && t.split(/\s+/).length > 40) return true;
    return false;
}

function upsertMemory({
    userId = null,
    kind,
    questionText,
    answerText,
    source = 'instruct',
    knockout = false
} = {}) {
    if (!studyingEnabled()) return { ok: false, reason: 'disabled' };
    ensureQuestionMemoryTable();

    let k = String(kind || '').trim();
    const q = String(questionText || '').trim();
    const a = String(answerText || '').trim();
    if (!k && q) k = inferPolicyKind(q) || '';
    if (!k || !q || !a) return { ok: false, reason: 'missing_fields' };
    if (k === '_hard_negative') return { ok: false, reason: 'hard_neg' };
    if (!POLICY_KINDS.has(k) && !k.startsWith('profile_')) {
        return { ok: false, reason: 'kind_not_allowed' };
    }
    if (isEssayLike(a)) return { ok: false, reason: 'essay_rejected' };
    if (/why (are you|do you)|interested in this|cover letter|tell me about a time/i.test(q)
        && a.split(/\s+/).length > 25) {
        return { ok: false, reason: 'unique_rejected' };
    }

    const norm = normalizeQuestion(q);
    const existing = getOne(
        `SELECT id, hit_count FROM bidder_question_memory
         WHERE question_norm = ? AND kind = ?
           AND ((? IS NULL AND user_id IS NULL) OR user_id = ?)
         LIMIT 1`,
        [norm, k, userId, userId]
    );

    if (existing?.id) {
        runQuery(
            `UPDATE bidder_question_memory
             SET answer_text = ?, source = ?, knockout = ?, updated_at = CURRENT_TIMESTAMP,
                 hit_count = COALESCE(hit_count,0) + 1, disabled = 0
             WHERE id = ?`,
            [a.slice(0, 500), source, knockout || KNOCKOUT_KINDS.has(k) ? 1 : 0, existing.id]
        );
        try { saveDatabase(); } catch (_) { /* ignore */ }
        // Async embed refresh — fire and forget
        embedText(q, { task: 'document' }).then((emb) => {
            if (!emb.vector) return;
            try {
                runQuery(
                    `UPDATE bidder_question_memory SET embedding_json = ?, embed_model = ? WHERE id = ?`,
                    [JSON.stringify(emb.vector), emb.model, existing.id]
                );
                saveDatabase();
            } catch (_) { /* ignore */ }
        }).catch(() => {});
        return { ok: true, id: existing.id, updated: true };
    }

    if (userId != null) {
        const cnt = getOne(
            `SELECT COUNT(*) AS c FROM bidder_question_memory WHERE user_id = ? AND source <> 'seed'`,
            [parseInt(userId, 10)]
        );
        if (Number(cnt?.c || 0) >= MAX_USER_ROWS) {
            return { ok: false, reason: 'cap' };
        }
    }

    runQuery(
        `INSERT INTO bidder_question_memory
          (user_id, kind, question_text, question_norm, answer_text, source, knockout, disabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [
            userId != null ? parseInt(userId, 10) : null,
            k,
            q.slice(0, 500),
            norm,
            a.slice(0, 500),
            source,
            knockout || KNOCKOUT_KINDS.has(k) ? 1 : 0
        ]
    );
    const row = getOne(
        `SELECT id FROM bidder_question_memory WHERE question_norm = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
        [norm, k]
    );
    try { saveDatabase(); } catch (_) { /* ignore */ }
    if (row?.id) {
        embedText(q, { task: 'document' }).then((emb) => {
            if (!emb.vector) return;
            try {
                runQuery(
                    `UPDATE bidder_question_memory SET embedding_json = ?, embed_model = ? WHERE id = ?`,
                    [JSON.stringify(emb.vector), emb.model, row.id]
                );
                saveDatabase();
            } catch (_) { /* ignore */ }
        }).catch(() => {});
    }
    return { ok: true, id: row?.id, updated: false };
}

function listMemory({ userId = null, includeDisabled = false, limit = 200 } = {}) {
    ensureQuestionMemoryTable();
    seedIfEmpty();
    const params = [];
    let sql = `SELECT id, user_id, kind, question_text, answer_text, source, knockout, disabled, hit_count, note, created_at, updated_at
               FROM bidder_question_memory WHERE kind <> '_hard_negative'`;
    if (!includeDisabled) sql += ` AND disabled = 0`;
    if (userId != null) {
        sql += ` AND (user_id IS NULL OR user_id = ?)`;
        params.push(parseInt(userId, 10));
    }
    sql += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(Math.min(Math.max(limit, 1), 500));
    return getAll(sql, params);
}

function setDisabled(id, disabled, userId = null) {
    ensureQuestionMemoryTable();
    const row = getOne(`SELECT * FROM bidder_question_memory WHERE id = ?`, [parseInt(id, 10)]);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.source === 'seed' && disabled) {
        // Allow disable of seeds (user override) but not delete
    }
    if (userId != null && row.user_id != null && Number(row.user_id) !== Number(userId)) {
        return { ok: false, reason: 'forbidden' };
    }
    runQuery(
        `UPDATE bidder_question_memory SET disabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [disabled ? 1 : 0, row.id]
    );
    try { saveDatabase(); } catch (_) { /* ignore */ }
    return { ok: true, id: row.id, disabled: !!disabled };
}

function clearUserMemory(userId) {
    ensureQuestionMemoryTable();
    if (userId == null) return { ok: false, reason: 'user_required' };
    runQuery(
        `DELETE FROM bidder_question_memory WHERE user_id = ? AND source <> 'seed'`,
        [parseInt(userId, 10)]
    );
    try { saveDatabase(); } catch (_) { /* ignore */ }
    return { ok: true };
}

/** Infer policy kind from question text for learn upserts. */
function inferPolicyKind(questionText) {
    const h = String(questionText || '');
    if (/\b(disabilit(?:y|ies)|disabled|\bada\b)\b/i.test(h)
        && !/\binsurance\b/i.test(h)
        && !/\btell (us|me) about\b/i.test(h)) {
        return 'disability_status';
    }
    if (/\b(sponsor|sponsorship|visa[\s_-]*support)\b/i.test(h)) return 'requires_sponsorship';
    if (/\b(work[\s_-]*auth|legally[\s_-]*authorized|eligible[\s_-]*to[\s_-]*work)\b/i.test(h)) {
        return 'work_authorization';
    }
    if (/\b(have you (ever )?worked|former\b.{0,40}\bemployee|previously\s+worked)\b/i.test(h)) {
        return 'previous_employer_no';
    }
    if (/\b(comfortable|willing)\b.{0,80}\b(salary|compensation)\b/i.test(h)) return 'salary_comfort_yes';
    if (/\bbackground\s*check\b/i.test(h)) return 'background_check_yes';
    if (/\bnon[\s_-]*compete\b/i.test(h)) return 'non_compete_no';
    if (/\b(cuba|iran|north\s*korea|syria).{0,40}(reside|residence)\b/i.test(h)) {
        return 'sanctioned_countries_no';
    }
    if (/\b(18[\s_-]*or[\s_-]*older|over[\s_-]*18)\b/i.test(h)) return 'over_18';
    return null;
}

module.exports = {
    studyingEnabled,
    ensureQuestionMemoryTable,
    seedIfEmpty,
    backfillEmbeddings,
    matchQuestion,
    upsertMemory,
    listMemory,
    setDisabled,
    clearUserMemory,
    inferPolicyKind,
    normalizeQuestion,
    jaccard,
    cosine,
    TAU,
    GAP,
    KNOCKOUT_KINDS,
    POLICY_KINDS,
    SEED_ROWS,
    embedText,
    withDocPrefix,
    withQueryPrefix
};
