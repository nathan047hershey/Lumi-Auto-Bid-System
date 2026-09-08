/**
 * Read / upsert keys in server/local.env without wiping unrelated lines.
 */
const fs = require('fs');
const path = require('path');

function localEnvPath() {
    return path.join(__dirname, '..', 'local.env');
}

function readLocalEnvText() {
    const p = localEnvPath();
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
}

function writeLocalEnvText(text) {
    fs.writeFileSync(localEnvPath(), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

/**
 * Set or remove env vars in local.env.
 * Pass value `null` / `undefined` / '' to delete the line.
 */
function upsertLocalEnvVars(updates) {
    let text = readLocalEnvText();
    if (!text.trim()) {
        text = '# Local secrets — gitignored. Restart API after manual edits.\n';
    }

    const upsert = (name, value) => {
        const re = new RegExp(`^${name}=.*$`, 'm');
        if (value == null || value === '') {
            if (!re.test(text)) return;
            text = text.replace(re, '').replace(/\n{3,}/g, '\n\n');
            delete process.env[name];
            return;
        }
        const line = `${name}=${value}`;
        if (re.test(text)) {
            text = text.replace(re, line);
        } else {
            text = `${text.trimEnd()}\n${line}\n`;
        }
        process.env[name] = String(value);
    };

    for (const [name, value] of Object.entries(updates || {})) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        upsert(name, value);
    }

    writeLocalEnvText(text);
    return localEnvPath();
}

/**
 * Persist Groq keys as GROQ_API_KEY_1…N (and GROQ_API_KEY = first).
 * Clears higher-numbered slots so the file matches the list.
 */
function writeGroqKeysToLocalEnv(keys, { maxKeys = 20 } = {}) {
    const list = (Array.isArray(keys) ? keys : [])
        .map((k) => String(k || '').trim())
        .filter(Boolean)
        .slice(0, maxKeys);

    const updates = {};
    if (list.length) {
        updates.GROQ_API_KEY = list[0];
    } else {
        updates.GROQ_API_KEY = null;
    }

    for (let i = 1; i <= maxKeys; i++) {
        updates[`GROQ_API_KEY_${i}`] = list[i - 1] || null;
    }

    const filePath = upsertLocalEnvVars(updates);
    return { filePath, count: list.length, keys: list };
}

module.exports = {
    localEnvPath,
    readLocalEnvText,
    writeLocalEnvText,
    upsertLocalEnvVars,
    writeGroqKeysToLocalEnv
};
