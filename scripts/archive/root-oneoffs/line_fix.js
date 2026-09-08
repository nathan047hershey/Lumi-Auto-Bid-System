const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let lines = fs.readFileSync(p, 'utf8').split('\n');

// Line 238 - developers getAll
if (lines[237].includes("IN ('developer', 'user')")) {
    lines[237] = `        res.json(getAll("SELECT u.id, u.username, u.technical_skills, u.availability, u.developer_resume, u.contact_email, u.contact_whatsapp, u.contact_phone, u.contact_telegram, u.created_at FROM users u WHERE u.role IN ('developer', 'user') ORDER BY u.username ASC"));`;
    console.log('Fixed line 238');
}

// Line 245 - developers profiles sql
if (lines[244].includes("IN ('developer', 'user')")) {
    lines[244] = `        let sql = "SELECT u.id, u.username, u.technical_skills, u.availability, u.contact_email, u.contact_telegram FROM users u WHERE u.role IN ('developer', 'user')";`;
    console.log('Fixed line 245');
}

// Line 257 - update developer profile
if (lines[256] && lines[256].includes("IN ('developer', 'user')")) {
    lines[256] = lines[256].replace("IN ('developer', 'user')", "IN ('developer', 'user')");
    console.log('Fixed line 257');
}

fs.writeFileSync(p, lines.join('\n'));
console.log('Done');
