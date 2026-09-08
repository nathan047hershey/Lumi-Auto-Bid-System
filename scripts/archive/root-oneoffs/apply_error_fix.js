const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/jobDetailFetchService.js';
let c = fs.readFileSync(p, 'utf8');

// Add formatError helper function at the top of the file after 'use strict';
const formatErrorHelper = `
// Helper to format errors including AggregateError for display
function formatError(err) {
    if (err && typeof err === 'object') {
        if (err.constructor && err.constructor.name === 'AggregateError') {
            return 'AggregateError: ' + (err.errors || []).map(e => {
                if (e instanceof Error) return e.message;
                return String(e);
            }).join('; ');
        }
        if (err instanceof Error) return err.message;
    }
    return String(err);
}

`;

// Insert after 'use strict'; line
if (!c.includes('function formatError')) {
    c = c.replace(/^'use strict';\s*$/m, "'use strict';\n" + formatErrorHelper);
}

// Replace lastError assignments to use formatError
c = c.replace(
    /lastError = err\.message \|\| String\(err\);/g,
    'lastError = formatError(err);'
);

// Replace lastError = errMsg with formatError  
c = c.replace(
    /lastError = errMsg;/g,
    'lastError = formatError({ message: errMsg });'
);

fs.writeFileSync(p, c);
console.log('Fixed jobDetailFetchService.js error handling');
console.log('File now includes formatError helper for AggregateError');