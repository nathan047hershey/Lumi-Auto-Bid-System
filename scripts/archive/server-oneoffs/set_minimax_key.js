// Quick helper to set a real MiniMax API key in .env
// Usage: node server/set_minimax_key.js <your-api-key>

const fs = require('fs');
const path = require('path');

const apiKey = process.argv[2];
if (!apiKey) {
    console.log('Usage: node set_minimax_key.js <your-minimax-api-key>');
    console.log('Get one from https://api.minimax.io');
    process.exit(1);
}

const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
    console.error('No .env file found at', envPath);
    process.exit(1);
}

let content = fs.readFileSync(envPath, 'utf8');
content = content.replace(
    /^MINIMAX_API_KEY=.*$/m,
    `MINIMAX_API_KEY=${apiKey}`
);

fs.writeFileSync(envPath, content);
console.log('Updated MINIMAX_API_KEY in', envPath);
console.log('Restart the server for the change to take effect.');
