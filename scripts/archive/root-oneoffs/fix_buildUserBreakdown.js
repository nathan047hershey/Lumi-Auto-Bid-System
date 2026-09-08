const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/statsService.js';
let c = fs.readFileSync(p, 'utf8');

// Find and wrap buildUserBreakdown with try-catch
const oldStart = `function buildUserBreakdown({ periods, userIds = [], activePeriod = null }) {
    const profileFilter = userIds.length > 0`;

const newStart = `function buildUserBreakdown({ periods, userIds = [], activePeriod = null }) {
    try {
    const profileFilter = userIds.length > 0`;

if (c.includes(oldStart) && !c.includes('function buildUserBreakdown({ periods, userIds = [], activePeriod = null }) {\n    try {')) {
    c = c.replace(oldStart, newStart);
    // Need to add the closing try-catch at the end of the function
    // Find the end of the function (before the next function)
    const lines = c.split('\n');
    let braceCount = 0;
    let inFunction = false;
    let endLine = -1;
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('function buildUserBreakdown')) {
            inFunction = true;
        }
        if (inFunction) {
            for (const char of lines[i]) {
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
            }
            if (braceCount === 0 && i > 0) {
                endLine = i;
                break;
            }
        }
    }
    
    if (endLine > 0) {
        lines.splice(endLine, 0, '    } catch (err) { console.error("buildUserBreakdown error:", err.message); return []; }');
        c = lines.join('\n');
        console.log('Added try-catch to buildUserBreakdown');
    }
    
    fs.writeFileSync(p, c);
} else {
    console.log('buildUserBreakdown already has error handling or pattern not found');
}
