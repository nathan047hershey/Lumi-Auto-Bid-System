const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let content = fs.readFileSync(path, 'utf8');

// Fix the escaped quotes in the SQL strings
content = content.replace(/\\\'developer\\\', \\\'user\\\'/g, "'developer', 'user'");
content = content.replace(/\\\'caller\\\'/g, "'caller'");

fs.writeFileSync(path, content);
console.log('Fixed quotes!');
