const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/statsService.js';
let c = fs.readFileSync(p, 'utf8');

// Fix: add closing } catch before return users;
if (c.includes('    return users;\n}') && c.includes('function buildUserBreakdown({ periods, userIds = [], activePeriod = null }) {\n    try {')) {
    c = c.replace('    return users;\n}', '    } catch (err) { console.error("buildUserBreakdown error:", err.message); return []; }\n    return users;\n}');
    fs.writeFileSync(p, c);
    console.log('Fixed try-catch for buildUserBreakdown');
} else {
    console.log('Pattern not found');
}
