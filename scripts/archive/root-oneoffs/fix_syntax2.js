const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let c = fs.readFileSync(p, 'utf8');
// Fix the broken getAll calls
c = c.replace(/res\.json\("getAll\("SELECT u\.id, u\.username, u\.created_at FROM users u WHERE u\.role = 'caller' ORDER BY u\.username ASC"\)"\)/g, 
    'res.json(getAll("SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = \'caller\' ORDER BY u.username ASC"))');
fs.writeFileSync(p, c);
console.log('Fixed');
