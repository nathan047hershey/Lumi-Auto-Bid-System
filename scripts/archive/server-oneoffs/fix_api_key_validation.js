// Add validation to detect placeholder API keys and surface clearer errors.
// Also improves the settings service to validate the configured provider's
// API key is actually present (and not a placeholder).

const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/settingsService.js';
let c = fs.readFileSync(p, 'utf8');

// Add placeholder detection at the top of the file (after PROVIDER_CONFIG)
const validationHelper = `
// Detect placeholder/empty API keys so we can surface a clear
// "configure your API key" error instead of the upstream provider's
// opaque 401.
function isPlaceholderKey(key, providerName) {
    if (!key) return true;
    const trimmed = String(key).trim();
    if (trimmed === '') return true;
    const placeholders = [
        'your-' + providerName + '-api-key',
        'your-' + providerName + '-api-key-here',
        'your-api-key',
        'your-api-key-here',
        'sk-your-' + providerName + '-api-key',
        'change-me'
    ];
    const lower = trimmed.toLowerCase();
    return placeholders.some(p => lower === p.toLowerCase() || lower.startsWith(p.toLowerCase()));
}

`;

// Insert before getSettings function
if (!c.includes('function isPlaceholderKey')) {
    c = c.replace(
        '// ---------- Settings persistence ----------',
        validationHelper + '// ---------- Settings persistence ----------'
    );
}

// Update getProviderConfig to use the validation
const oldCheck = `    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) {
        throw new Error(\`\${cfg.apiKeyEnv} is not set in environment\`);
    }`;

const newCheck = `    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey || isPlaceholderKey(apiKey, p)) {
        const isPlaceholder = apiKey && isPlaceholderKey(apiKey, p);
        throw new Error(
            \`\${cfg.apiKeyEnv} \${isPlaceholder ? 'is a placeholder' : 'is not set'} in environment. \` +
            \`Add your real API key to server/.env and restart the server.\`
        );
    }`;

if (c.includes(oldCheck)) {
    c = c.replace(oldCheck, newCheck);
    console.log('Updated getProviderConfig with placeholder detection');
} else {
    console.log('Could not find oldCheck pattern');
}

fs.writeFileSync(p, c);
console.log('Done.');
