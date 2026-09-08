const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';

const newRoutesPart2 = `
// ==================== INTERVIEWS ====================
router.post('/interviews', (req, res) => {
    try {
        const { application_id, scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes } = req.body;
        if (!application_id) return res.status(400).json({ error: 'application_id is required' });
        const result = runQuery('INSERT INTO interviews (application_id, scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [application_id, scheduled_date || null, scheduled_time || null, timezone || 'America/New_York', interview_type || null, interviewer_name || null, location || null, meeting_link || null, notes || null]);
        res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) { console.error('Create interview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.put('/interviews/:id', (req, res) => {
    try {
        const { scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes, status } = req.body;
        runQuery('UPDATE interviews SET scheduled_date = ?, scheduled_time = ?, timezone = ?, interview_type = ?, interviewer_name = ?, location = ?, meeting_link = ?, notes = ?, status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP WHERE id = ?', [scheduled_date, scheduled_time, timezone, interview_type, interviewer_name, location, meeting_link, notes, status, parseInt(req.params.id)]);
        res.json({ message: 'Interview updated' });
    } catch (error) { console.error('Update interview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/interviews/:id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM interviews WHERE id = ?', [parseInt(req.params.id)]);
        if (result.changes === 0) return res.status(404).json({ error: 'Interview not found' });
        res.json({ message: 'Interview deleted' });
    } catch (error) { console.error('Delete interview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});
`;

fs.appendFileSync(path, newRoutesPart2);
console.log('Part 2 added!');
