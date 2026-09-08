const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let lines = fs.readFileSync(p, 'utf8').split('\n');

// Fix line 81 - SQL with ' ' inside single quotes
if (lines[80].includes("p.first_name || ' ' ||")) {
    lines[80] = `        const applications = getAll(\`SELECT a.*, p.first_name || ' ' || p.last_name as candidate_name, p.email as candidate_email FROM job_applications a LEFT JOIN candidate_profiles p ON a.profile_id = p.id WHERE \${whereSQL} ORDER BY a.created_at DESC LIMIT ? OFFSET ?\`, [...params, limit, offset]);`;
    console.log('Fixed line 81');
}

fs.writeFileSync(p, lines.join('\n'));
console.log('Done');
