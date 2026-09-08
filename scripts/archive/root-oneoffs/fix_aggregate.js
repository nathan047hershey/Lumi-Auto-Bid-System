const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/statsService.js';
let c = fs.readFileSync(p, 'utf8');

// Fix aggregateStatusForCurrentUser to handle errors gracefully
const oldFunc = `function aggregateStatusForCurrentUser(userId) {
    const rows = getAll(
        \`
        SELECT a.status, COUNT(*) as count
        FROM job_applications a
        JOIN user_profile_assignments upa ON upa.profile_id = a.profile_id
        WHERE upa.user_id = ?
        GROUP BY a.status
        \`,
        [userId]
    );
    const out = { pending: 0, applied: 0, interview: 0, rejected: 0, total: 0 };
    for (const row of rows) {
        if (row.status in out) out[row.status] = row.count;
        out.total += row.count;
    }
    return out;
}`;

const newFunc = `function aggregateStatusForCurrentUser(userId) {
    try {
        const rows = getAll(
            \`
            SELECT a.status, COUNT(*) as count
            FROM job_applications a
            JOIN user_profile_assignments upa ON upa.profile_id = a.profile_id
            WHERE upa.user_id = ?
            GROUP BY a.status
            \`,
            [userId]
        );
        const out = { pending: 0, applied: 0, interview: 0, rejected: 0, total: 0 };
        for (const row of rows) {
            if (row.status in out) out[row.status] = row.count;
            out.total += row.count;
        }
        return out;
    } catch (err) {
        console.error('aggregateStatusForCurrentUser error:', err.message);
        return { pending: 0, applied: 0, interview: 0, rejected: 0, total: 0 };
    }
}`;

if (c.includes(oldFunc)) {
    c = c.replace(oldFunc, newFunc);
    fs.writeFileSync(p, c);
    console.log('Fixed aggregateStatusForCurrentUser');
} else {
    console.log('Pattern not found, checking for issues...');
    // Just check if the function exists
    if (c.includes('function aggregateStatusForCurrentUser')) {
        console.log('Function exists but pattern may differ');
    }
}
