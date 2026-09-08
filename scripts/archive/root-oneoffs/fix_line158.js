const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let lines = fs.readFileSync(p, 'utf8').split('\n');

// Fix line 158 - similar issue
if (lines[157] && lines[157].includes("|| ' ' ||")) {
    lines[157] = lines[157].replace(/getAll\('SELECT ir\.\*, a\.company_name, a\.job_role, a\.profile_id, p\.first_name \|\| ' ' \|\| p\.last_name/, 
        'getAll(`SELECT ir.*, a.company_name, a.job_role, a.profile_id, p.first_name || \' \' || p.last_name');
    lines[157] = lines[157].replace(/ORDER BY ir\.created_at DESC LIMIT \? OFFSET \?', '/, [...params, Math.min(parseInt(limit), 100), offset]`)');
    lines[157] = lines[157].replace(/'\)\s*\);\s*$/, '`)\\\\);');
    console.log('Fixed line 158');
}

fs.writeFileSync(p, lines.join('\n'));
console.log('Done');
