/**
 * Write MiniMax Key 2 into server/local.env and default to slot 2.
 * Usage: node server/scripts/set_local_minimax_key2.js <your-api-key>
 */
const fs = require('fs');
const path = require('path');

const apiKey = process.argv[2];
if (!apiKey || !String(apiKey).trim()) {
    console.log('Usage: node server/scripts/set_local_minimax_key2.js <your-minimax-api-key>');
    process.exit(1);
}

const key = String(apiKey).trim();
const envPath = path.join(__dirname, '..', 'local.env');
const examplePath = path.join(__dirname, '..', 'local.env.example');

let content = '';
if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
} else if (fs.existsSync(examplePath)) {
    content = fs.readFileSync(examplePath, 'utf8');
} else {
    content = `# Local secrets\nMINIMAX_PREFER_ENV=1\nMINIMAX_KEY_SLOT=2\nMINIMAX_API_KEY_2=\n`;
}

const upsert = (text, name, value) => {
    const re = new RegExp(`^${name}=.*$`, 'm');
    if (re.test(text)) return text.replace(re, `${name}=${value}`);
    return `${text.trimEnd()}\n${name}=${value}\n`;
};

content = upsert(content, 'MINIMAX_PREFER_ENV', '1');
content = upsert(content, 'MINIMAX_KEY_SLOT', '2');
content = upsert(content, 'MINIMAX_API_KEY_2', key);

fs.writeFileSync(envPath, content, 'utf8');
console.log('Updated', envPath);
console.log('  MINIMAX_PREFER_ENV=1');
console.log('  MINIMAX_KEY_SLOT=2');
console.log('  MINIMAX_API_KEY_2=(saved)');
console.log('\nRestart the API server so it reloads local.env.');
