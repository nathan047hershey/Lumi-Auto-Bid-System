const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/statsService.js';
let c = fs.readFileSync(p, 'utf8');

// Wrap buildLinkBreakdown body with try-catch
const oldStart = `function buildLinkBreakdown({ userIds = [], activePeriod = null }) {
    const userFilter = userIds.length > 0
        ? \`AND u.id IN (\${userIds.map(() => '?').join(',')})\`
        : '';
    const userFilterParams = userIds.length > 0 ? userIds.map(Number) : [];`;

const newStart = `function buildLinkBreakdown({ userIds = [], activePeriod = null }) {
    try {
    const userFilter = userIds.length > 0
        ? \`AND u.id IN (\${userIds.map(() => '?').join(',')})\`
        : '';
    const userFilterParams = userIds.length > 0 ? userIds.map(Number) : [];`;

if (c.includes(oldStart)) {
    c = c.replace(oldStart, newStart);

    // Find the end of buildLinkBreakdown - it ends with '}\n}' before the next function or close
    // Add catch before the closing brace of buildLinkBreakdown
    // Look for the last `}` before the next section
    // Find the function end by looking for the next function declaration
    const lastReturnIdx = c.lastIndexOf('return {');
    const linkStart = c.indexOf('function buildLinkBreakdown');
    // Find the end of the function - it's the closing `}` followed by a blank line and another function or export
    const funcEndPattern = /function buildLinkBreakdown[\s\S]+?\n\}\n(?=\n\/\*\*|function|module\.exports|let \w+\s*=)/;
    const match = funcEndPattern.exec(c);
    if (match) {
        const before = c.substring(0, match.index + match[0].length - 2);
        const after = c.substring(match.index + match[0].length - 2);
        c = before + '\n    } catch (err) { console.error("buildLinkBreakdown error:", err.message); return null; }\n}\n' + after.substring(after.indexOf('\n') + 1);
        console.log('✓ Added try-catch to buildLinkBreakdown');
    } else {
        console.log('✗ Could not find end of buildLinkBreakdown');
    }
}

fs.writeFileSync(p, c);
console.log('Done');
