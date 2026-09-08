const fs = require('fs');

const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('Before:', content.split('\n').length, 'lines');

// The destructuring import is on one very long line - split it properly
const oldPattern = `const {    // Used by the legacy GET /applications list endpoint to decorate    // each row with the latest milestone (without an N+1).    getLatestMilestonesForApplications,    // Milestone workflow (new) helpers    MILESTONE_KINDS,    MILESTONE_KIND_LABELS,    labelForKind,    listMilestonesForRequest,    addMilestone: svcAddMilestone,    completeMilestone: svcCompleteMilestone,    uncompleteMilestone: svcUncompleteMilestone,    deleteMilestone: svcDeleteMilestone,    approveMilestone: svcApproveMilestone,    unapproveMilestone: svcUnapproveMilestone,    payMilestone: svcPayMilestone,    unpayMilestone: svcUnpayMilestone,    assignDeveloper,    setApplicationFlags,    summariseMilestones,    getUserRoles} = require('../services/milestoneService');`;

const newPattern = `const {
    // Used by the legacy GET /applications list endpoint to decorate
    // each row with the latest milestone (without an N+1).
    getLatestMilestonesForApplications,
    // Milestone workflow (new) helpers
    MILESTONE_KINDS,
    MILESTONE_KIND_LABELS,
    labelForKind,
    listMilestonesForRequest,
    addMilestone: svcAddMilestone,
    completeMilestone: svcCompleteMilestone,
    uncompleteMilestone: svcUncompleteMilestone,
    deleteMilestone: svcDeleteMilestone,
    approveMilestone: svcApproveMilestone,
    unapproveMilestone: svcUnapproveMilestone,
    payMilestone: svcPayMilestone,
    unpayMilestone: svcUnpayMilestone,
    assignDeveloper,
    setApplicationFlags,
    summariseMilestones,
    getUserRoles
} = require('../services/milestoneService');`;

if (content.includes(oldPattern)) {
    content = content.replace(oldPattern, newPattern);
    console.log('Fixed destructuring import!');
} else {
    console.log('Pattern not found - checking content...');
    // Try to find and fix any long lines with destructuring
    const lines = content.split('\n');
    const fixedLines = [];
    
    for (const line of lines) {
        if (line.includes('getLatestMilestonesForApplications') && line.length > 200) {
            // This is the problematic line - split it
            const fixed = `const {
    // Used by the legacy GET /applications list endpoint to decorate
    // each row with the latest milestone (without an N+1).
    getLatestMilestonesForApplications,
    // Milestone workflow (new) helpers
    MILESTONE_KINDS,
    MILESTONE_KIND_LABELS,
    labelForKind,
    listMilestonesForRequest,
    addMilestone: svcAddMilestone,
    completeMilestone: svcCompleteMilestone,
    uncompleteMilestone: svcUncompleteMilestone,
    deleteMilestone: svcDeleteMilestone,
    approveMilestone: svcApproveMilestone,
    unapproveMilestone: svcUnapproveMilestone,
    payMilestone: svcPayMilestone,
    unpayMilestone: svcUnpayMilestone,
    assignDeveloper,
    setApplicationFlags,
    summariseMilestones,
    getUserRoles
} = require('../services/milestoneService');`;
            fixedLines.push(fixed);
            console.log('Fixed long destructuring line!');
        } else {
            fixedLines.push(line);
        }
    }
    content = fixedLines.join('\n');
}

console.log('After:', content.split('\n').length, 'lines');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
