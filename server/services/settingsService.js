// App-wide settings + AI provider dispatch.
// Settings are persisted in the `app_settings` SQLite table (singleton row, id=1).
// At runtime, AI call sites ask `getActiveProvider()` to learn which backend to use.
//
// MiniMax supports two pasted API keys (slot 1 / slot 2). Admins paste them
// in Settings; the active slot is stored as `minimax_key_slot`. Env vars
// MINIMAX_API_KEY / MINIMAX_API_KEY_2 remain as fallbacks when a slot has no
// pasted value.
//
// Groq supports many pasted keys (JSON array in `groq_api_keys`, up to MAX_GROQ_KEYS).
// Use separate Groq orgs/accounts so free-tier RPD stacks. Active index: `groq_key_slot`.

const { getOne, runQuery } = require('../config/database');
const { writeGroqKeysToLocalEnv } = require('../utils/localEnvFile');

const MAX_GROQ_KEYS = 20;

const PROVIDER_CONFIG = {
    deepseek: {
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiUrl: 'https://api.deepseek.com/v1/chat/completions',
        defaultModel: 'deepseek-reasoner'
    },
    minimax: {
        apiKeyEnv: 'MINIMAX_API_KEY',
        apiKeyEnv2: 'MINIMAX_API_KEY_2',
        apiUrl: 'https://api.minimax.io/v1/chat/completions',
        defaultModel: 'MiniMax-M2.7'
    },
    groq: {
        apiKeyEnv: 'GROQ_API_KEY',
        apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
        // llama-3.3-70b-versatile shut down for free/dev tiers (Aug 2026).
        defaultModel: 'openai/gpt-oss-120b'
    }
};

function isPlaceholderKey(key, providerName) {
    if (!key) return true;
    const trimmed = String(key).trim();
    if (trimmed === '') return true;
    const lower = trimmed.toLowerCase();
    // Example / template values from .env.example and local.env.example
    if (/^paste-your-/i.test(trimmed)) return true;
    if (/^your[-_]/i.test(trimmed) && /api[-_]?key/i.test(trimmed)) return true;
    const placeholders = [
        'your-' + providerName + '-api-key',
        'your-' + providerName + '-api-key-here',
        'your-api-key',
        'your-api-key-here',
        'sk-your-' + providerName + '-api-key',
        'change-me',
        'your-minimax-api-key',
        'your-second-minimax-api-key',
        'paste-your-minimax-key-2-here',
        'paste-your-minimax-api-key-here',
        'your-groq-api-key',
        'paste-your-groq-api-key-here'
    ];
    return placeholders.some((p) => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase()));
}

function envMinimaxKeyUsable(envName) {
    const envKey = process.env[envName];
    return !!(envKey && !isPlaceholderKey(envKey, 'minimax'));
}

function maskKey(key) {
    if (!key || isPlaceholderKey(key, 'minimax') || isPlaceholderKey(key, 'deepseek')
        || isPlaceholderKey(key, 'groq')) {
        return null;
    }
    const s = String(key).trim();
    if (s.length <= 8) return '••••' + s.slice(-2);
    return s.slice(0, 4) + '…' + s.slice(-4);
}

function parseGroqKeysJson(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map((k) => String(k || '').trim()).filter(Boolean).slice(0, MAX_GROQ_KEYS);
    }
    const s = String(raw).trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
            return parsed.map((k) => String(k || '').trim()).filter(Boolean).slice(0, MAX_GROQ_KEYS);
        }
    } catch (_) { /* fall through — treat as newline/comma list */ }
    return s.split(/[\r\n,]+/).map((k) => k.trim()).filter(Boolean).slice(0, MAX_GROQ_KEYS);
}

function listEnvGroqKeys() {
    const out = [];
    const seen = new Set();
    const push = (envName) => {
        const v = process.env[envName];
        if (!v || isPlaceholderKey(v, 'groq')) return;
        const key = String(v).trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ apiKey: key, source: envName });
    };
    push('GROQ_API_KEY');
    for (let i = 1; i <= MAX_GROQ_KEYS; i++) push(`GROQ_API_KEY_${i}`);
    return out;
}

/**
 * Ordered Groq keys: env (local.env) first, then any legacy pasted DB keys
 * that are not already in env.
 * Slot numbers are 1-based into this resolved list.
 */
function listResolvedGroqKeys(settings) {
    const s = settings || getSettings();
    const out = [];
    const seen = new Set();
    for (const env of listEnvGroqKeys()) {
        if (seen.has(env.apiKey)) continue;
        seen.add(env.apiKey);
        out.push({ apiKey: env.apiKey, source: env.source, from_env: true });
    }
    const pasted = parseGroqKeysJson(s.groq_api_keys);
    pasted.forEach((key) => {
        if (isPlaceholderKey(key, 'groq') || seen.has(key)) return;
        seen.add(key);
        out.push({ apiKey: key, source: `pasted_slot_${out.length + 1}`, from_env: false });
    });
    return out.slice(0, MAX_GROQ_KEYS);
}

/** Full Groq key list for rewrite to local.env (env + legacy pasted). */
function collectGroqKeysForPersist(settings, { removeSlot, appendKeys, replaceKeys, clear } = {}) {
    if (clear) return [];
    let keys;
    if (replaceKeys) {
        keys = parseGroqKeysJson(replaceKeys);
    } else {
        keys = listResolvedGroqKeys(settings).map((k) => k.apiKey);
        if (removeSlot != null) {
            const n = Number(removeSlot);
            if (Number.isFinite(n) && n >= 1 && n <= keys.length) {
                keys.splice(n - 1, 1);
            }
        }
        if (appendKeys) {
            const incoming = parseGroqKeysJson(appendKeys);
            const seen = new Set(keys);
            for (const k of incoming) {
                if (seen.has(k)) continue;
                seen.add(k);
                keys.push(k);
                if (keys.length >= MAX_GROQ_KEYS) break;
            }
        }
    }
    return keys.slice(0, MAX_GROQ_KEYS);
}

function persistGroqKeysToLocalEnv(keys) {
    const result = writeGroqKeysToLocalEnv(keys, { maxKeys: MAX_GROQ_KEYS });
    clearProviderCache();
    return result;
}

function getActiveGroqSlot(settings) {
    const s = settings || getSettings();
    const keys = listResolvedGroqKeys(s);
    const n = Number(s.groq_key_slot);
    if (Number.isFinite(n) && n >= 1 && n <= keys.length) return n;
    return keys.length ? 1 : 1;
}

function resolveGroqKey(settings, slot) {
    const keys = listResolvedGroqKeys(settings);
    if (!keys.length) return { apiKey: null, source: null, slot: null };
    let useSlot = Number(slot);
    if (!Number.isFinite(useSlot) || useSlot < 1 || useSlot > keys.length) {
        useSlot = getActiveGroqSlot(settings);
    }
    if (useSlot < 1 || useSlot > keys.length) useSlot = 1;
    const row = keys[useSlot - 1];
    return {
        apiKey: row?.apiKey || null,
        source: row?.source || null,
        slot: row ? useSlot : null,
        from_env: !!row?.from_env
    };
}

function getGroqKeysStatus(settings) {
    const s = settings || getSettings();
    const keys = listResolvedGroqKeys(s);
    const active = getActiveGroqSlot(s);
    return {
        active_slot: active,
        max_keys: MAX_GROQ_KEYS,
        count: keys.length,
        keys: keys.map((k, i) => ({
            slot: i + 1,
            is_set: true,
            source: k.source,
            masked: maskKey(k.apiKey),
            from_env: !!k.from_env,
            active: active === i + 1
        }))
    };
}

function getSettings() {
    const row = getOne('SELECT * FROM app_settings WHERE id = 1');
    return row || {
        id: 1,
        ai_provider: 'minimax',
        minimax_key_slot: 1,
        minimax_api_key_1: null,
        minimax_api_key_2: null,
        groq_api_keys: null,
        groq_key_slot: 1,
        deepseek_api_key: null,
        local_llm_enabled: 0,
        local_llm_base_url: 'http://127.0.0.1:11434/v1',
        local_llm_model: 'llama3.2',
        local_llm_api_key: null
    };
}

function preferEnvMinimaxKeys() {
    const v = String(process.env.MINIMAX_PREFER_ENV || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function getEnvMinimaxSlot() {
    const envSlot = Number(process.env.MINIMAX_KEY_SLOT);
    return (envSlot === 1 || envSlot === 2) ? envSlot : null;
}

/**
 * Active MiniMax key slot.
 * Settings (DB) wins so the admin can choose Key 1/2 on the page.
 * local.env MINIMAX_KEY_SLOT is the fallback / boot default only.
 */
function getActiveMinimaxSlot(settings) {
    const s = settings || getSettings();
    const dbSlot = Number(s.minimax_key_slot);
    if (dbSlot === 1 || dbSlot === 2) return dbSlot;
    return getEnvMinimaxSlot() || 1;
}

function resolveMinimaxKey(settings, slot) {
    const s = settings || getSettings();
    const useSlot = Number(slot) === 2 ? 2 : 1;
    const pasted = useSlot === 2 ? s.minimax_api_key_2 : s.minimax_api_key_1;
    // Key 1: MINIMAX_API_KEY or MINIMAX_API_KEY_1. Key 2: MINIMAX_API_KEY_2.
    const envNames = useSlot === 2
        ? ['MINIMAX_API_KEY_2']
        : ['MINIMAX_API_KEY', 'MINIMAX_API_KEY_1'];
    let envKey = null;
    let envName = envNames[0];
    for (const name of envNames) {
        if (envMinimaxKeyUsable(name)) {
            envKey = process.env[name];
            envName = name;
            break;
        }
    }
    const pastedOk = pasted && !isPlaceholderKey(pasted, 'minimax');
    const envOk = !!envKey;

    // local.env / MINIMAX_PREFER_ENV=1 → real env keys win over Admin paste.
    // Placeholder / missing env values do not block a pasted key for that slot.
    if (preferEnvMinimaxKeys()) {
        if (envOk) return { apiKey: String(envKey).trim(), source: envName };
        if (pastedOk) return { apiKey: String(pasted).trim(), source: `pasted_slot_${useSlot}` };
        return { apiKey: null, source: null };
    }

    if (pastedOk) return { apiKey: String(pasted).trim(), source: `pasted_slot_${useSlot}` };
    if (envOk) return { apiKey: String(envKey).trim(), source: envName };
    return { apiKey: null, source: null };
}

function getMinimaxKeysStatus(settings) {
    const s = settings || getSettings();
    const slot = getActiveMinimaxSlot(s);
    const k1 = resolveMinimaxKey(s, 1);
    const k2 = resolveMinimaxKey(s, 2);
    return {
        active_slot: slot,
        prefer_env: preferEnvMinimaxKeys(),
        // Keys come from local.env; slot is still choosable in Settings.
        keys_from_env: preferEnvMinimaxKeys(),
        env_default_slot: getEnvMinimaxSlot(),
        key_1: {
            is_set: !!k1.apiKey,
            source: k1.source,
            masked: maskKey(k1.apiKey),
            from_env: envMinimaxKeyUsable('MINIMAX_API_KEY') || envMinimaxKeyUsable('MINIMAX_API_KEY_1')
        },
        key_2: {
            is_set: !!k2.apiKey,
            source: k2.source,
            masked: maskKey(k2.apiKey),
            from_env: envMinimaxKeyUsable('MINIMAX_API_KEY_2')
        }
    };
}

/**
 * On boot: apply MINIMAX_KEY_SLOT from local.env into DB when useful.
 * Never force an env slot that has no usable key (that breaks CV + autofill).
 */
function syncMinimaxSlotFromEnv({ force = false } = {}) {
    const envSlot = getEnvMinimaxSlot();
    if (envSlot == null) return getSettings();

    const current = getSettings();
    // Usable = env var OR pasted Settings key for that slot.
    const slotHasKey = (slot) => !!resolveMinimaxKey(current, slot).apiKey;
    let targetSlot = envSlot;
    if (!slotHasKey(envSlot)) {
        const other = envSlot === 2 ? 1 : 2;
        if (slotHasKey(other)) {
            targetSlot = other;
        } else if (!force) {
            return current;
        }
    }

    const dbSlot = Number(current.minimax_key_slot);
    if (!force && (dbSlot === 1 || dbSlot === 2)) {
        // Keep admin's last explicit choice — but if that slot has no key and
        // the other does, switch so Generate/autofill keep working.
        if (slotHasKey(dbSlot)) return current;
        const alt = dbSlot === 2 ? 1 : 2;
        if (slotHasKey(alt)) {
            targetSlot = alt;
        } else {
            return current;
        }
    }

    if (Number(current.minimax_key_slot) === targetSlot) return current;

    runQuery(
        `UPDATE app_settings SET minimax_key_slot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
        [targetSlot]
    );
    clearProviderCache();
    return getSettings();
}

function updateSettings({
    ai_provider,
    updated_by,
    minimax_key_slot,
    minimax_api_key_1,
    minimax_api_key_2,
    groq_key_slot,
    groq_api_keys,
    groq_keys_replace,
    groq_remove_slot,
    deepseek_api_key,
    local_llm_enabled,
    local_llm_base_url,
    local_llm_model,
    local_llm_api_key
}) {
    const current = getSettings();
    const nextProvider = ai_provider || current.ai_provider;
    if (!PROVIDER_CONFIG[nextProvider]) {
        throw new Error(`Unknown ai_provider: ${nextProvider}`);
    }

    // Allow Settings to choose Key 1 / Key 2. If the request omits slot,
    // keep the existing DB value (so other setting updates don't flip it).
    let nextSlot = current.minimax_key_slot != null ? Number(current.minimax_key_slot) : (getEnvMinimaxSlot() || 1);
    if (minimax_key_slot != null && minimax_key_slot !== '') {
        const n = Number(minimax_key_slot);
        if (n !== 1 && n !== 2) {
            throw new Error('minimax_key_slot must be 1 or 2');
        }
        nextSlot = n;
    }

    const pickKey = (incoming, existing) => {
        if (incoming === undefined || incoming === null) return existing ?? null;
        const trimmed = String(incoming).trim();
        if (trimmed === '') return existing ?? null;
        if (trimmed === '__clear__') return null;
        return trimmed;
    };

    // Prefer real local.env keys. If an env slot is missing/placeholder,
    // allow Settings paste for that slot so Key 2 can be set in the UI.
    let nextKey1 = current.minimax_api_key_1 ?? null;
    let nextKey2 = current.minimax_api_key_2 ?? null;
    if (!preferEnvMinimaxKeys()) {
        nextKey1 = pickKey(minimax_api_key_1, current.minimax_api_key_1);
        nextKey2 = pickKey(minimax_api_key_2, current.minimax_api_key_2);
    } else {
        if (!envMinimaxKeyUsable('MINIMAX_API_KEY') && !envMinimaxKeyUsable('MINIMAX_API_KEY_1')) {
            nextKey1 = pickKey(minimax_api_key_1, current.minimax_api_key_1);
        }
        if (!envMinimaxKeyUsable('MINIMAX_API_KEY_2')) {
            nextKey2 = pickKey(minimax_api_key_2, current.minimax_api_key_2);
        }
    }

    let nextGroqKeysJson = current.groq_api_keys ?? null;
    let groqPersisted = null;
    if (groq_remove_slot != null && groq_remove_slot !== '') {
        const keys = collectGroqKeysForPersist(current, { removeSlot: groq_remove_slot });
        groqPersisted = persistGroqKeysToLocalEnv(keys);
        nextGroqKeysJson = null; // canonical store is local.env
    } else if (groq_api_keys !== undefined) {
        if (groq_api_keys === null || groq_api_keys === '__clear__') {
            groqPersisted = persistGroqKeysToLocalEnv([]);
            nextGroqKeysJson = null;
        } else {
            const replace = groq_keys_replace === true
                || groq_keys_replace === 1
                || groq_keys_replace === '1'
                || String(groq_keys_replace || '').toLowerCase() === 'true';
            const keys = collectGroqKeysForPersist(current, replace
                ? { replaceKeys: groq_api_keys }
                : { appendKeys: groq_api_keys });
            groqPersisted = persistGroqKeysToLocalEnv(keys);
            nextGroqKeysJson = null;
        }
    }

    let nextGroqSlot = current.groq_key_slot != null ? Number(current.groq_key_slot) : 1;
    if (groq_key_slot != null && groq_key_slot !== '') {
        const n = Number(groq_key_slot);
        if (!Number.isFinite(n) || n < 1 || n > MAX_GROQ_KEYS) {
            throw new Error(`groq_key_slot must be 1–${MAX_GROQ_KEYS}`);
        }
        nextGroqSlot = n;
    }
    // Clamp active slot to available resolved keys after update
    {
        const previewSettings = { ...current, groq_api_keys: nextGroqKeysJson };
        // listResolvedGroqKeys reads process.env (already updated if we persisted)
        const preview = listResolvedGroqKeys(previewSettings);
        if (preview.length && nextGroqSlot > preview.length) nextGroqSlot = 1;
        if (!preview.length) nextGroqSlot = 1;
        if (groqPersisted && groqPersisted.count && nextGroqSlot < 1) nextGroqSlot = 1;
    }

    let nextLocalEnabled = current.local_llm_enabled ? 1 : 0;
    if (local_llm_enabled !== undefined && local_llm_enabled !== null && local_llm_enabled !== '') {
        nextLocalEnabled = (local_llm_enabled === true || local_llm_enabled === 1 || local_llm_enabled === '1')
            ? 1
            : 0;
    }

    let nextLocalUrl = current.local_llm_base_url
        || process.env.LOCAL_LLM_BASE_URL
        || 'http://127.0.0.1:11434/v1';
    if (local_llm_base_url !== undefined && local_llm_base_url !== null) {
        const trimmed = String(local_llm_base_url).trim().replace(/\/+$/, '');
        if (trimmed) nextLocalUrl = trimmed;
    }

    let nextLocalModel = current.local_llm_model || process.env.LOCAL_LLM_MODEL || 'llama3.2';
    if (local_llm_model !== undefined && local_llm_model !== null) {
        const trimmed = String(local_llm_model).trim();
        if (trimmed) nextLocalModel = trimmed;
    }

    const nextLocalKey = pickKey(local_llm_api_key, current.local_llm_api_key);
    const nextDeepseekKey = pickKey(deepseek_api_key, current.deepseek_api_key);

    runQuery(
        `UPDATE app_settings
         SET ai_provider = ?,
             minimax_key_slot = ?,
             minimax_api_key_1 = ?,
             minimax_api_key_2 = ?,
             groq_api_keys = ?,
             groq_key_slot = ?,
             deepseek_api_key = ?,
             local_llm_enabled = ?,
             local_llm_base_url = ?,
             local_llm_model = ?,
             local_llm_api_key = ?,
             updated_at = CURRENT_TIMESTAMP,
             updated_by = ?
         WHERE id = 1`,
        [
            nextProvider,
            nextSlot,
            nextKey1,
            nextKey2,
            nextGroqKeysJson,
            nextGroqSlot,
            nextDeepseekKey,
            nextLocalEnabled,
            nextLocalUrl,
            nextLocalModel,
            nextLocalKey,
            updated_by || null
        ]
    );
    clearProviderCache();
    return getSettings();
}

let cachedProvider = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5000;

function getActiveProvider() {
    const now = Date.now();
    if (cachedProvider && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedProvider;
    }
    const settings = getSettings();
    cachedProvider = settings.ai_provider;
    cachedAt = now;
    return cachedProvider;
}

function clearProviderCache() {
    cachedProvider = null;
    cachedAt = 0;
}

function hasUsableProviderKey(providerName) {
    try {
        getProviderConfig(providerName);
        return true;
    } catch (_) {
        return false;
    }
}

function getProviderConfig(provider, overrides) {
    const p = provider || getActiveProvider();
    const cfg = PROVIDER_CONFIG[p];
    if (!cfg) throw new Error(`Unknown provider: ${p}`);

    let apiKey = null;
    let keySource = cfg.apiKeyEnv;
    let usedSlot = null;
    let usedGroqSlot = null;

    if (p === 'minimax') {
        const settings = getSettings();
        const preferred = overrides && (overrides.minimaxKeySlot === 1 || overrides.minimaxKeySlot === 2)
            ? Number(overrides.minimaxKeySlot)
            : getActiveMinimaxSlot(settings);
        let slot = preferred;
        let resolved = resolveMinimaxKey(settings, slot);
        // Autofill/CV must not die because the chosen slot is empty while
        // the other MiniMax key is configured.
        if (!resolved.apiKey) {
            const alt = slot === 2 ? 1 : 2;
            const altResolved = resolveMinimaxKey(settings, alt);
            if (altResolved.apiKey) {
                resolved = altResolved;
                slot = alt;
                // Persist the working slot so Settings matches runtime.
                try {
                    promoteMinimaxSlot(alt);
                } catch (_) { /* ignore */ }
            }
        }
        apiKey = resolved.apiKey;
        keySource = resolved.source || (slot === 2 ? cfg.apiKeyEnv2 : cfg.apiKeyEnv);
        usedSlot = slot;
        if (!apiKey) {
            throw new Error(
                `MiniMax API key slot ${preferred} is not set. ` +
                `Add ${preferred === 2 ? 'MINIMAX_API_KEY_2' : 'MINIMAX_API_KEY'} to server/local.env (or .env), ` +
                `or paste a key in Admin → Settings, then restart.`
            );
        }
    } else if (p === 'groq') {
        const settings = getSettings();
        const keys = listResolvedGroqKeys(settings);
        if (!keys.length) {
            throw new Error(
                'No Groq API keys set. Paste one or more keys (one per line) in Admin → Settings, ' +
                'or set GROQ_API_KEY / GROQ_API_KEY_1… in server/local.env, then restart.'
            );
        }
        let preferred = overrides && overrides.groqKeySlot != null
            ? Number(overrides.groqKeySlot)
            : getActiveGroqSlot(settings);
        if (!Number.isFinite(preferred) || preferred < 1 || preferred > keys.length) preferred = 1;
        let slot = preferred;
        let resolved = resolveGroqKey(settings, slot);
        if (!resolved.apiKey) {
            for (let i = 1; i <= keys.length; i++) {
                if (i === preferred) continue;
                const alt = resolveGroqKey(settings, i);
                if (alt.apiKey) {
                    resolved = alt;
                    slot = i;
                    try { promoteGroqSlot(i); } catch (_) { /* ignore */ }
                    break;
                }
            }
        }
        apiKey = resolved.apiKey;
        keySource = resolved.source || `groq_slot_${slot}`;
        usedGroqSlot = slot;
        if (!apiKey) {
            throw new Error('Groq API key is not set. Paste keys in Admin → Settings.');
        }
    } else if (p === 'deepseek') {
        const settings = getSettings();
        const pasted = settings.deepseek_api_key;
        const pastedOk = pasted && !isPlaceholderKey(pasted, 'deepseek');
        const envKey = process.env[cfg.apiKeyEnv];
        const envOk = envKey && !isPlaceholderKey(envKey, 'deepseek');
        if (pastedOk) {
            apiKey = String(pasted).trim();
            keySource = 'pasted_deepseek';
        } else if (envOk) {
            apiKey = String(envKey).trim();
            keySource = cfg.apiKeyEnv;
        } else {
            throw new Error(
                'DeepSeek API key is not set. Paste it in Admin → Settings, ' +
                `or set ${cfg.apiKeyEnv} in server/local.env and restart.`
            );
        }
    } else {
        apiKey = process.env[cfg.apiKeyEnv];
        if (!apiKey || isPlaceholderKey(apiKey, p)) {
            const isPlaceholder = apiKey && isPlaceholderKey(apiKey, p);
            throw new Error(
                `${cfg.apiKeyEnv} ${isPlaceholder ? 'is a placeholder' : 'is not set'} in environment. ` +
                `Add your real API key to server/.env and restart the server.`
            );
        }
    }

    const model = (overrides && overrides.model) || cfg.defaultModel;
    return {
        provider: p,
        apiKey,
        apiUrl: cfg.apiUrl,
        model,
        keySource,
        minimax_key_slot: p === 'minimax' ? usedSlot : null,
        groq_key_slot: p === 'groq' ? usedGroqSlot : null
    };
}

function promoteMinimaxSlot(slot) {
    const n = Number(slot) === 2 ? 2 : 1;
    const current = getSettings();
    if (Number(current.minimax_key_slot) === n) return current;
    runQuery(
        `UPDATE app_settings SET minimax_key_slot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
        [n]
    );
    clearProviderCache();
    return getSettings();
}

function promoteGroqSlot(slot) {
    const n = Math.max(1, Math.min(MAX_GROQ_KEYS, Number(slot) || 1));
    const current = getSettings();
    if (Number(current.groq_key_slot) === n) return current;
    runQuery(
        `UPDATE app_settings SET groq_key_slot = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
        [n]
    );
    clearProviderCache();
    return getSettings();
}

/**
 * Other MiniMax key slot when the active one is empty or rate-limited.
 */
function getAlternateMinimaxConfig(failedSlot, overrides) {
    const alt = Number(failedSlot) === 2 ? 1 : 2;
    try {
        return getProviderConfig('minimax', {
            ...(overrides || {}),
            minimaxKeySlot: alt
        });
    } catch (_) {
        return null;
    }
}

/**
 * Next Groq key after a rate-limit / quota failure (wraps around).
 */
function getAlternateGroqConfig(failedSlot, overrides) {
    const keys = listResolvedGroqKeys();
    if (keys.length < 2) return null;
    const failed = Number(failedSlot) || 1;
    for (let step = 1; step < keys.length; step++) {
        const slot = ((failed - 1 + step) % keys.length) + 1;
        try {
            const cfg = getProviderConfig('groq', {
                ...(overrides || {}),
                groqKeySlot: slot
            });
            if (cfg?.apiKey) return cfg;
        } catch (_) { /* try next */ }
    }
    return null;
}

function isMinimaxQuotaError(error) {
    const status = error?.response?.status || error?.upstreamStatus;
    if (status === 429) return true;
    const msg = String(
        error?.upstreamMessage
        || error?.response?.data?.base_resp?.status_msg
        || error?.response?.data?.error?.message
        || error?.message
        || ''
    );
    return /usage limit|rate limit|quota|token plan|2056|insufficient/i.test(msg);
}

function isGroqQuotaError(error) {
    const status = error?.response?.status || error?.upstreamStatus;
    if (status === 429) return true;
    const msg = String(
        error?.upstreamMessage
        || error?.response?.data?.error?.message
        || error?.message
        || ''
    );
    return /rate limit|too many requests|quota|tokens per|requests per|RPD|TPM|RPM/i.test(msg);
}

function normalizeChatCompletionsUrl(baseUrl) {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!u) u = 'http://127.0.0.1:11434/v1';
    if (u.endsWith('/chat/completions')) return u;
    if (u.endsWith('/v1')) return `${u}/chat/completions`;
    // Ollama native root without /v1 — still speak OpenAI-compat if user added /v1 elsewhere
    if (/\/api$/.test(u)) return `${u.replace(/\/api$/, '/v1')}/chat/completions`;
    return `${u}/chat/completions`;
}

/**
 * Local OpenAI-compatible LLM (Ollama, LM Studio, llama.cpp server, etc.)
 * Used for autofill / bidder application answers when enabled.
 */
function getLocalLlmConfig() {
    const settings = getSettings();
    const envUrl = process.env.LOCAL_LLM_BASE_URL;
    const envModel = process.env.LOCAL_LLM_MODEL;
    const envKey = process.env.LOCAL_LLM_API_KEY;

    const enabled = !!(settings.local_llm_enabled)
        || String(process.env.LOCAL_LLM_ENABLED || '').toLowerCase() === 'true'
        || process.env.LOCAL_LLM_ENABLED === '1';

    const baseUrl = (settings.local_llm_base_url && String(settings.local_llm_base_url).trim())
        || (envUrl && String(envUrl).trim())
        || 'http://127.0.0.1:11434/v1';

    const model = (settings.local_llm_model && String(settings.local_llm_model).trim())
        || (envModel && String(envModel).trim())
        || 'llama3.2';

    let apiKey = null;
    let keySource = null;
    if (settings.local_llm_api_key && !isPlaceholderKey(settings.local_llm_api_key, 'local')) {
        apiKey = String(settings.local_llm_api_key).trim();
        keySource = 'pasted_local';
    } else if (envKey && String(envKey).trim()) {
        apiKey = String(envKey).trim();
        keySource = 'LOCAL_LLM_API_KEY';
    } else {
        // Ollama / many local servers ignore the key but expect a Bearer header.
        apiKey = 'local';
        keySource = 'dummy_local';
    }

    return {
        provider: 'local',
        enabled: !!enabled,
        apiKey,
        apiUrl: normalizeChatCompletionsUrl(baseUrl),
        baseUrl: String(baseUrl).replace(/\/+$/, ''),
        model,
        keySource,
        timeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS) || 120000
    };
}

/**
 * Provider for WRITTEN application answers (Why company, screening text, etc.).
 *
 * Fixed profile fields (gender, Hispanic/Latino, veteran, disability, work auth, …)
 * are NEVER answered by any LLM — they come from the saved profile only
 * (see applicationAnswersService fixedProfileKind).
 *
 * Default: MiniMax (same family as CV). Groq is rescue-only when MiniMax
 * rate-limits or leaves hard/new questions empty (see applicationAnswersService).
 * Override: ANSWERS_PROVIDER=minimax|groq|deepseek
 * Local Ollama only via ANSWERS_USE_LOCAL=1.
 */
function getAnswersProviderConfig() {
    const useLocal = String(process.env.ANSWERS_USE_LOCAL || '').toLowerCase() === 'true'
        || process.env.ANSWERS_USE_LOCAL === '1';
    if (useLocal) {
        const local = getLocalLlmConfig();
        if (local.enabled) {
            if (!local.model) {
                throw new Error('Local LLM model name is empty. Set it in Admin → Settings.');
            }
            return local;
        }
    }

    const forced = String(process.env.ANSWERS_PROVIDER || '').trim().toLowerCase();
    if (forced && PROVIDER_CONFIG[forced]) {
        if (forced === 'minimax') return getAnswersMinimaxConfig();
        return getProviderConfig(forced);
    }

    // Engine default: MiniMax for CV-aligned form answers.
    const mm = getAnswersMinimaxConfig();
    if (mm) return mm;
    return getProviderConfig();
}

/** MiniMax highspeed for primary answers / CV-aligned fill. */
function getAnswersMinimaxConfig() {
    try {
        return getProviderConfig('minimax', { model: 'MiniMax-M2.7-highspeed' });
    } catch (_) {
        try {
            return getProviderConfig('minimax');
        } catch (__) {
            return null;
        }
    }
}

/** @deprecated use getAnswersMinimaxConfig */
function getAnswersMinimaxFallbackConfig() {
    return getAnswersMinimaxConfig();
}

/** Groq rescue when MiniMax cannot answer (quota or empty hard questions). */
function getAnswersGroqRescueConfig() {
    if (!listResolvedGroqKeys().length) return null;
    try {
        return getProviderConfig('groq');
    } catch (_) {
        return null;
    }
}

function buildLocalLlmPublicStatus() {
    const local = getLocalLlmConfig();
    return {
        enabled: local.enabled,
        base_url: local.baseUrl,
        model: local.model,
        api_url: local.apiUrl,
        key_source: local.keySource,
        has_custom_key: local.keySource === 'pasted_local' || local.keySource === 'LOCAL_LLM_API_KEY'
    };
}

function buildPublicSettingsPayload() {
    const settings = getSettings();
    const cfg = PROVIDER_CONFIG[settings.ai_provider];
    let api_key_status;

    if (settings.ai_provider === 'minimax') {
        const mm = getMinimaxKeysStatus(settings);
        const active = mm.active_slot === 2 ? mm.key_2 : mm.key_1;
        api_key_status = {
            env_var: active.source || (mm.active_slot === 2 ? 'MINIMAX_API_KEY_2' : 'MINIMAX_API_KEY'),
            is_set: active.is_set,
            is_placeholder: !active.is_set,
            model: cfg ? cfg.defaultModel : null,
            minimax: mm
        };
    } else if (settings.ai_provider === 'groq') {
        const gq = getGroqKeysStatus(settings);
        const active = gq.keys.find((k) => k.active) || gq.keys[0];
        api_key_status = {
            env_var: active?.source || 'GROQ_API_KEY',
            is_set: gq.count > 0,
            is_placeholder: gq.count === 0,
            model: cfg ? cfg.defaultModel : null,
            groq: gq
        };
    } else if (settings.ai_provider === 'deepseek') {
        let apiKey = null;
        let source = 'DEEPSEEK_API_KEY';
        if (settings.deepseek_api_key && !isPlaceholderKey(settings.deepseek_api_key, 'deepseek')) {
            apiKey = settings.deepseek_api_key;
            source = 'pasted_deepseek';
        } else if (process.env.DEEPSEEK_API_KEY && !isPlaceholderKey(process.env.DEEPSEEK_API_KEY, 'deepseek')) {
            apiKey = process.env.DEEPSEEK_API_KEY;
        }
        api_key_status = {
            env_var: source,
            is_set: !!apiKey,
            is_placeholder: !apiKey,
            model: cfg ? cfg.defaultModel : null,
            masked: maskKey(apiKey)
        };
    } else {
        const envKey = cfg ? process.env[cfg.apiKeyEnv] : null;
        const isPlaceholder = !envKey || isPlaceholderKey(envKey, settings.ai_provider);
        api_key_status = {
            env_var: cfg ? cfg.apiKeyEnv : null,
            is_set: Boolean(envKey && !isPlaceholder),
            is_placeholder: isPlaceholder,
            model: cfg ? cfg.defaultModel : null
        };
    }

    return {
        ai_provider: settings.ai_provider,
        minimax_key_slot: getActiveMinimaxSlot(settings),
        minimax_keys: getMinimaxKeysStatus(settings),
        groq_key_slot: getActiveGroqSlot(settings),
        groq_keys: getGroqKeysStatus(settings),
        deepseek_key: (() => {
            const pasted = settings.deepseek_api_key && !isPlaceholderKey(settings.deepseek_api_key, 'deepseek');
            const envOk = process.env.DEEPSEEK_API_KEY && !isPlaceholderKey(process.env.DEEPSEEK_API_KEY, 'deepseek');
            const key = pasted ? settings.deepseek_api_key : (envOk ? process.env.DEEPSEEK_API_KEY : null);
            return {
                is_set: !!key,
                masked: maskKey(key),
                from_env: !pasted && !!envOk,
                source: pasted ? 'pasted_deepseek' : (envOk ? 'DEEPSEEK_API_KEY' : null)
            };
        })(),
        local_llm: buildLocalLlmPublicStatus(),
        answers_provider: (() => {
            try {
                const a = getAnswersProviderConfig();
                return { provider: a.provider, model: a.model, key_source: a.keySource || null };
            } catch (_) {
                return { provider: null, model: null, key_source: null };
            }
        })(),
        updated_at: settings.updated_at,
        updated_by: settings.updated_by,
        api_key_status
    };
}

module.exports = {
    PROVIDER_CONFIG,
    MAX_GROQ_KEYS,
    getSettings,
    updateSettings,
    getActiveProvider,
    getProviderConfig,
    getLocalLlmConfig,
    getAnswersProviderConfig,
    getAnswersMinimaxConfig,
    getAnswersMinimaxFallbackConfig,
    getAnswersGroqRescueConfig,
    getActiveMinimaxSlot,
    getActiveGroqSlot,
    syncMinimaxSlotFromEnv,
    promoteMinimaxSlot,
    promoteGroqSlot,
    getAlternateMinimaxConfig,
    getAlternateGroqConfig,
    isMinimaxQuotaError,
    isGroqQuotaError,
    clearProviderCache,
    getMinimaxKeysStatus,
    getGroqKeysStatus,
    listResolvedGroqKeys,
    hasUsableProviderKey,
    buildPublicSettingsPayload,
    buildLocalLlmPublicStatus,
    isPlaceholderKey,
    maskKey
};
