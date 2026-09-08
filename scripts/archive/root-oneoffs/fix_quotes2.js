const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let content = fs.readFileSync(path, 'utf8');

// Fix: role = 'caller' inside single-quoted JS string - convert to double quotes
content = content.replace(/getAll\('SELECT u\.id, u\.username, u\.created_at FROM users u WHERE u\.role = 'caller' ORDER BY u\.username ASC'\)/g, 
    'getAll("SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = \'caller\' ORDER BY u.username ASC")');

// Fix developer role IN clause  
content = content.replace(/IN \('developer', 'user'\)/g, "IN ('developer', 'user')");

fs.writeFileSync(path, content);
console.log('Fixed quotes properly!');
