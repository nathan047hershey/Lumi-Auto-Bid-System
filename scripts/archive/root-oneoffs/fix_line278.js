const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let lines = fs.readFileSync(p, 'utf8').split('\n');

// Fix line 278
if (lines[277].includes("= 'caller'")) {
    lines[277] = `        res.json(getAll("SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = 'caller' ORDER BY u.username ASC"));`;
    console.log('Fixed line 278');
}

fs.writeFileSync(p, lines.join('\n'));
console.log('Done');
