const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let c = fs.readFileSync(p, 'utf8');

// Fix line 238
c = c.replace(
    /res\.json\(getAll\("SELECT u\.id, u\.username, u\.technical_skills, u\.availability, u\.developer_resume, u\.contact_email, u\.contact_whatsapp, u\.contact_phone, u\.contact_telegram, u\.created_at FROM users u WHERE u\.role IN \('developer', 'user'\) ORDER BY u\.username ASC"\)\)/g,
    'res.json(getAll("SELECT u.id, u.username, u.technical_skills, u.availability, u.developer_resume, u.contact_email, u.contact_whatsapp, u.contact_phone, u.contact_telegram, u.created_at FROM users u WHERE u.role IN (\'developer\', \'user\') ORDER BY u.username ASC"))'
);

// Fix line 245
c = c.replace(
    /let sql = 'SELECT u\.id, u\.username, u\.technical_skills, u\.availability, u\.contact_email, u\.contact_telegram FROM users u WHERE u\.role IN \('developer', 'user'\);/g,
    'let sql = "SELECT u.id, u.username, u.technical_skills, u.availability, u.contact_email, u.contact_telegram FROM users u WHERE u.role IN (\'developer\', \'user\")";'
);

// Fix line 257
c = c.replace(
    /runQuery\("UPDATE users SET technical_skills = \?, availability = \?, contact_email = \?, contact_whatsapp = \?, contact_phone = \?, contact_telegram = \? WHERE id = \? AND role IN \('developer', 'user'\)"/g,
    'runQuery("UPDATE users SET technical_skills = ?, availability = ?, contact_email = ?, contact_whatsapp = ?, contact_phone = ?, contact_telegram = ? WHERE id = ? AND role IN (\'developer\', \'user\')"'
);

fs.writeFileSync(p, c);
console.log('Done');
