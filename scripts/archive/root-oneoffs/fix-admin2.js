const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'server', 'routes', 'admin.js');
let content = fs.readFileSync(file, 'utf8', 'r');

// Replace literal patterns with actual newlines
content = content.replace(/10const/g, '\nconst');
content = content.replace(/10let/g, '\nlet');
content = content.replace(/10var/g, '\nvar');
content = content.replace(/10function/g, '\nfunction');
content = content.replace(/10router/g, '\nrouter');
content = content.replace(/10module/g, '\nmodule');
content = content.replace(/10if/g, '\nif');
content = content.replace(/10try/g, '\ntry');
content = content.replace(/10catch/g, '\ncatch');
content = content.replace(/10  /g, '\n  ');
content = content.replace(/10\/\//g, '\n//');
content = content.replace(/\n\n\n/g, '\n\n');

fs.writeFileSync(file, content, 'utf8');

const stats = fs.statSync(file);
console.log('Fixed! File size:', stats.size, 'bytes');
