const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'server', 'routes', 'admin.js');
const content = fs.readFileSync(file, 'utf8');

// Replace literal "10" patterns with newlines
let fixed = content
    .replace(/10const/g, '\nconst')
    .replace(/10let/g, '\nlet')
    .replace(/10var/g, '\nvar')
    .replace(/10function/g, '\nfunction')
    .replace(/10router/g, '\nrouter')
    .replace(/10module/g, '\nmodule')
    .replace(/10if/g, '\nif')
    .replace(/10try/g, '\ntry')
    .replace(/10catch/g, '\ncatch')
    .replace(/10  /g, '\n  ')
    .replace(/10\/\//g, '\n//');

// Clean up any double newlines
fixed = fixed.replace(/\n\n\n/g, '\n\n');

fs.writeFileSync(file, fixed);
console.log('Fixed admin.js line breaks!');
