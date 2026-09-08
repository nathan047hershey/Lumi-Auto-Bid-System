const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let lines = fs.readFileSync(p, 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
    // Fix line with u.role IN ('developer', 'user')
    if (lines[i].includes("IN ('developer', 'user')")) {
        lines[i] = lines[i].replace(/\(/g, '$$(').replace(/'/g, "\\'");
        lines[i] = lines[i].replace(/\$\$IN/g, "IN").replace(/\$\$\(/g, "('").replace(/'\)/g, "')");
        lines[i] = lines[i].replace(/'developer', 'user'/g, "'developer', 'user'");
        console.log('Fixed line', i+1);
    }
    // Fix line with u.role = 'caller'
    if (lines[i].includes("= 'caller'") && lines[i].includes('getAll')) {
        lines[i] = lines[i].replace(/\('SELECT/, "(\"SELECT").replace(/ASC'\)\)/g, "ASC\")\")");
        console.log('Fixed callers line', i+1);
    }
}

fs.writeFileSync(p, lines.join('\n'));
console.log('Done');
