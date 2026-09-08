const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';

const newRoutesPart5 = `
// ==================== DEVELOPERS ====================
router.get('/developers', (req, res) => {
    try {
        res.json(getAll('SELECT u.id, u.username, u.technical_skills, u.availability, u.developer_resume, u.contact_email, u.contact_whatsapp, u.contact_phone, u.contact_telegram, u.created_at FROM users u WHERE u.role IN (\\'developer\\', \\'user\\') ORDER BY u.username ASC'));
    } catch (error) { console.error('Get developers error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/developers/profiles', (req, res) => {
    try {
        const { q } = req.query;
        let sql = 'SELECT u.id, u.username, u.technical_skills, u.availability, u.contact_email, u.contact_telegram FROM users u WHERE u.role IN (\\'developer\\', \\'user\\')';
        let params = [];
        if (q) { sql += ' AND (u.username LIKE ? OR u.technical_skills LIKE ?)'; params.push('%'+q+'%', '%'+q+'%'); }
        sql += ' ORDER BY u.username ASC LIMIT 50';
        res.json(getAll(sql, params));
    } catch (error) { console.error('Get developer profiles error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/developers/:id/profile', (req, res) => {
    try {
        const { technical_skills, availability, contact_email, contact_whatsapp, contact_phone, contact_telegram } = req.body;
        if (contact_email && !contact_telegram) return res.status(400).json({ error: 'contact_telegram is required when contact_email is provided' });
        runQuery('UPDATE users SET technical_skills = ?, availability = ?, contact_email = ?, contact_whatsapp = ?, contact_phone = ?, contact_telegram = ? WHERE id = ? AND role IN (\\'developer\\', \\'user\\')', [technical_skills || null, availability || null, contact_email || null, contact_whatsapp || null, contact_phone || null, contact_telegram || null, parseInt(req.params.id)]);
        res.json({ message: 'Developer profile updated' });
    } catch (error) { console.error('Update developer profile error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/developers/:id/profile/resume', (req, res) => {
    try {
        const { filename, content } = req.body;
        if (!filename || !content) return res.status(400).json({ error: 'filename and content are required' });
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filepath = path.join(resumesDir, 'developer_'+req.params.id+'_'+safeName);
        const buffer = Buffer.from(content, 'base64');
        fs.writeFileSync(filepath, buffer);
        runQuery('UPDATE users SET developer_resume = ? WHERE id = ?', [filepath, parseInt(req.params.id)]);
        res.json({ message: 'Resume uploaded', path: filepath });
    } catch (error) { console.error('Upload developer resume error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ==================== CALLERS ====================
router.get('/callers', (req, res) => {
    try {
        res.json(getAll('SELECT u.id, u.username, u.created_at FROM users u WHERE u.role = \\'caller\\' ORDER BY u.username ASC'));
    } catch (error) { console.error('Get callers error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/caller-assignments', (req, res) => {
    try {
        const { application_id, caller_id } = req.body;
        if (!application_id || !caller_id) return res.status(400).json({ error: 'application_id and caller_id are required' });
        const existing = getOne('SELECT id FROM caller_assignments WHERE application_id = ? AND caller_id = ?', [parseInt(application_id), parseInt(caller_id)]);
        if (existing) return res.status(409).json({ error: 'Assignment already exists' });
        const result = runQuery('INSERT INTO caller_assignments (application_id, caller_id) VALUES (?, ?)', [parseInt(application_id), parseInt(caller_id)]);
        res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) { console.error('Create caller assignment error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/caller-assignments/:caller_id/:application_id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM caller_assignments WHERE caller_id = ? AND application_id = ?', [parseInt(req.params.caller_id), parseInt(req.params.application_id)]);
        if (result.changes === 0) return res.status(404).json({ error: 'Assignment not found' });
        res.json({ message: 'Assignment removed' });
    } catch (error) { console.error('Delete caller assignment error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/caller-assignments/:application_id', (req, res) => {
    try {
        res.json(getAll('SELECT ca.*, u.username as caller_username FROM caller_assignments ca JOIN users u ON ca.caller_id = u.id WHERE ca.application_id = ?', [parseInt(req.params.application_id)]));
    } catch (error) { console.error('Get caller assignments error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

module.exports = router;
`;

fs.appendFileSync(path, newRoutesPart5);
console.log('Part 5 added - All routes complete!');
