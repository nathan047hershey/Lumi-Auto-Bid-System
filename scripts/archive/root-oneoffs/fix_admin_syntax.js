const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let content = fs.readFileSync(path, 'utf8');

// Fix line: res.json(getAll('SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = 'caller' ORDER BY u.username ASC'));
const bad = "res.json(getAll('SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = 'caller' ORDER BY u.username ASC'))";
const good = 'res.json(getAll("SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = \'caller\' ORDER BY u.username ASC"))';

if (content.includes(bad)) {
    content = content.replace(bad, good);
    console.log('Fixed callers SQL');
} else {
    console.log('Pattern not found, checking...');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("u.role = 'caller'")) {
            console.log('Found at line', i+1, ':', lines[i]);
            lines[i] = lines[i].replace(/getAll\('(.*)'\)/, function(m, sql) {
                return 'getAll("' + sql.replace(/'/g, "\\'") + '")';
            });
            content = lines.join('\n');
            console.log('Fixed at line', i+1);
            break;
        }
    }
}

fs.writeFileSync(path, content);
console.log('Done');
