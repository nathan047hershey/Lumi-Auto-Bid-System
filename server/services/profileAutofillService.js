/**
 * Shared autofill defaults across candidate profiles.
 */

const { getOne, runQuery, saveDatabase } = require('../config/database');

/** Keys copied when applying defaults to every profile. */
const SHARED_AUTOFILL_KEYS = Object.freeze([
    'gender',
    'work_authorization',
    'requires_sponsorship',
    'disability_status',
    'veteran_status',
    'hispanic_latino',
    'over_18',
    'willing_to_relocate',
    'willing_to_travel',
    'earliest_start_date',
    'notice_period',
    'how_heard',
    'years_of_experience',
    'security_clearance',
    'race_ethnicity'
]);

/**
 * @param {Record<string, unknown>} body
 * @returns {Record<string, string|null>}
 */
function pickSharedAutofillAnswers(body) {
    const src = body && typeof body === 'object' ? body : {};
    const out = {};
    for (const key of SHARED_AUTOFILL_KEYS) {
        if (!(key in src)) continue;
        const raw = src[key];
        if (raw == null) {
            out[key] = null;
            continue;
        }
        const s = String(raw).trim();
        out[key] = s || null;
    }
    // Hard lock: Disability Status is always No for every profile.
    if ('disability_status' in src || Object.keys(out).length) {
        out.disability_status = 'No, I do not have a disability';
    }
    return out;
}

/**
 * Apply shared autofill columns to many profiles in one UPDATE.
 * @param {object} opts
 * @param {Record<string, unknown>} opts.answers
 * @param {'admin'|'manager'} opts.scope
 * @param {number} [opts.managerId] required when scope is manager
 * @returns {{ updated: number, keys: string[] }}
 */
function applySharedAutofillToProfiles({ answers, scope, managerId }) {
    const patch = pickSharedAutofillAnswers(answers);
    const keys = Object.keys(patch);
    if (!keys.length) {
        const err = new Error('No shared autofill fields provided');
        err.status = 400;
        throw err;
    }

    const setSql = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => patch[k]);

    let result;
    if (scope === 'manager') {
        const mid = parseInt(managerId, 10);
        if (!Number.isFinite(mid)) {
            const err = new Error('managerId required');
            err.status = 400;
            throw err;
        }
        result = runQuery(
            `UPDATE candidate_profiles
                SET ${setSql}, updated_at = CURRENT_TIMESTAMP
              WHERE created_by = ?`,
            [...values, mid]
        );
    } else {
        result = runQuery(
            `UPDATE candidate_profiles
                SET ${setSql}, updated_at = CURRENT_TIMESTAMP`,
            values
        );
    }

    try {
        saveDatabase();
    } catch (_) { /* ignore if not sqlite-persist mode */ }

    return {
        updated: result?.changes ?? 0,
        keys
    };
}

/**
 * Count profiles that would be updated for a scope.
 */
function countProfilesForScope(scope, managerId) {
    if (scope === 'manager') {
        const row = getOne(
            'SELECT COUNT(*) AS n FROM candidate_profiles WHERE created_by = ?',
            [parseInt(managerId, 10)]
        );
        return row?.n || 0;
    }
    const row = getOne('SELECT COUNT(*) AS n FROM candidate_profiles');
    return row?.n || 0;
}

module.exports = {
    SHARED_AUTOFILL_KEYS,
    pickSharedAutofillAnswers,
    applySharedAutofillToProfiles,
    countProfilesForScope
};
