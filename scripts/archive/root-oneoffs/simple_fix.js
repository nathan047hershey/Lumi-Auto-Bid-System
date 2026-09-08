const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let c = fs.readFileSync(p, 'utf8');

// Direct replacements for each broken pattern
const fixes = [
    // Fix developers getAll
    [/getAll\('SELECT u\.id, u\.username, u\.technical_skills, u\.availability, u\.developer_resume, u\.contact_email, u\.contact_whatsapp, u\.contact_phone, u\.contact_telegram, u\.created_at FROM users u WHERE u\.role IN \('developer', 'user'\) ORDER BY u\.username ASC'\)/g,
     'getAll("SELECT u.id, u.username, u.technical_skills, u.availability, u.developer_resume, u.contact_email, u.contact_whatsapp, u.contact_phone, u.contact_telegram, u.created_at FROM users u WHERE u.role IN (\'developer\', \'user\') ORDER BY u.username ASC")'],
    
    // Fix developers profiles sql
    [/let sql = 'SELECT u\.id, u\.username, u\.technical_skills, u\.availability, u\.contact_email, u\.contact_telegram FROM users u WHERE u\.role IN \('developer', 'user'\);/g,
     'let sql = "SELECT u.id, u.username, u.technical_skills, u.availability, u.contact_email, u.contact_telegram FROM users u WHERE u.role IN (\'developer\', \'user\")";'],
    
    // Fix UPDATE users SET ... WHERE role IN
    [/runQuery\('UPDATE users SET technical_skills = \?, availability = \?, contact_email = \?, contact_whatsapp = \?, contact_phone = \?, contact_telegram = \? WHERE id = \? AND role IN \('developer', 'user'\)'/g,
     'runQuery("UPDATE users SET technical_skills = ?, availability = ?, contact_email = ?, contact_whatsapp = ?, contact_phone = ?, contact_telegram = ? WHERE id = ? AND role IN (\'developer\', \'user\')"']
];

for (const [pattern, replacement] of fixes) {
    if (pattern.test(c)) {
        c = c.replace(pattern, replacement);
        console.log('Fixed:', pattern.toString().slice(0,50));
    }
}

fs.writeFileSync(p, c);
console.log('Done');
