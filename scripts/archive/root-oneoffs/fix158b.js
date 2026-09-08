const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let c = fs.readFileSync(p, 'utf8');

// Replace the problematic line
const bad = `const requests = getAll('SELECT ir.*, a.company_name, a.job_role, a.profile_id, p.first_name || ' ' || p.last_name as candidate_name, u.username as created_by_username, d.username as developer_username FROM interview_requests ir JOIN job_applications a ON ir.application_id = a.id LEFT JOIN candidate_profiles p ON a.profile_id = p.id LEFT JOIN users u ON ir.created_by = u.id LEFT JOIN users d ON ir.developer_id = d.id WHERE '+whereSQL+' ORDER BY ir.created_at DESC LIMIT ? OFFSET ?', [...params, Math.min(parseInt(limit), 100), offset]);`;

const good = `const requests = getAll(\`SELECT ir.*, a.company_name, a.job_role, a.profile_id, p.first_name || ' ' || p.last_name as candidate_name, u.username as created_by_username, d.username as developer_username FROM interview_requests ir JOIN job_applications a ON ir.application_id = a.id LEFT JOIN candidate_profiles p ON a.profile_id = p.id LEFT JOIN users u ON ir.created_by = u.id LEFT JOIN users d ON ir.developer_id = d.id WHERE \${whereSQL} ORDER BY ir.created_at DESC LIMIT ? OFFSET ?\`, [...params, Math.min(parseInt(limit), 100), offset]);`;

if (c.includes(bad)) {
    c = c.replace(bad, good);
    fs.writeFileSync(p, c);
    console.log('Fixed line 158');
} else {
    console.log('Pattern not found');
}
