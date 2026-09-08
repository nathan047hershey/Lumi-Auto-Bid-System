// Update defaults so new installs also use MiniMax-M2.7
const fs = require('fs');

// 1. Update database.js default
const p1 = 'd:/Projects/job-apply-master/job-apply-master/server/config/database.js';
let c1 = fs.readFileSync(p1, 'utf8');
c1 = c1.replace(
    /CHECK\(ai_provider IN \('deepseek', 'minimax'\)\)/g,
    "CHECK(ai_provider IN ('minimax', 'deepseek'))"
);
c1 = c1.replace(
    /INSERT OR IGNORE INTO app_settings \(id, ai_provider\) VALUES \(1, 'deepseek'\)/,
    "INSERT OR IGNORE INTO app_settings (id, ai_provider) VALUES (1, 'minimax')"
);
fs.writeFileSync(p1, c1);
console.log('✓ Updated database.js defaults');

// 2. Update settingsService.js default fallback
const p2 = 'd:/Projects/job-apply-master/job-apply-master/server/services/settingsService.js';
let c2 = fs.readFileSync(p2, 'utf8');
c2 = c2.replace(
    /return row \|\| \{ id: 1, ai_provider: 'deepseek' \};/,
    "return row || { id: 1, ai_provider: 'minimax' };"
);
fs.writeFileSync(p2, c2);
console.log('✓ Updated settingsService.js fallback default');

// 3. Update Settings.jsx UI default selection
const p3 = 'd:/Projects/job-apply-master/job-apply-master/client/src/pages/admin/Settings.jsx';
let c3 = fs.readFileSync(p3, 'utf8');
// Reorder PROVIDER_OPTIONS so minimax is first/default
const oldOptions = `const PROVIDER_OPTIONS = [
    {
        value: 'deepseek',
        label: 'DeepSeek',
        description: 'deepseek-reasoner via api.deepseek.com',
        badge: 'Default'
    },
    {
        value: 'minimax',
        label: 'MiniMax',
        description: 'MiniMax-M2.7 via api.MiniMax.chat',
        badge: 'Beta'
    }
];`;

const newOptions = `const PROVIDER_OPTIONS = [
    {
        value: 'minimax',
        label: 'MiniMax',
        description: 'MiniMax-M2.7 via api.MiniMax.chat',
        badge: 'Default'
    },
    {
        value: 'deepseek',
        label: 'DeepSeek',
        description: 'deepseek-reasoner via api.deepseek.com',
        badge: 'Alternative'
    }
];`;

if (c3.includes(oldOptions)) {
    c3 = c3.replace(oldOptions, newOptions);
    c3 = c3.replace(/useState\('deepseek'\)/, "useState('minimax')");
    fs.writeFileSync(p3, c3);
    console.log('✓ Updated Settings.jsx UI - minimax is now default');
} else {
    console.log('  Settings.jsx UI not updated (pattern not found)');
}

console.log('\nDone.');
