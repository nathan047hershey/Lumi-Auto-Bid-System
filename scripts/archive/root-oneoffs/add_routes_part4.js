const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';

const newRoutesPart4 = `
// ==================== MILESTONES ====================
router.get('/milestones/:applicationId', (req, res) => {
    try {
        const milestones = getAll('SELECT m.*, u.username as assigned_to_username FROM milestones m LEFT JOIN users u ON m.assigned_to = u.id WHERE m.application_id = ? ORDER BY m.due_date ASC', [parseInt(req.params.applicationId)]);
        res.json(milestones);
    } catch (error) { console.error('Get milestones error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/milestones/:applicationId', (req, res) => {
    try {
        const { title, description, due_date, assigned_to, estimated_hours, kind } = req.body;
        if (!title) return res.status(400).json({ error: 'title is required' });
        const result = runQuery('INSERT INTO milestones (application_id, title, description, due_date, assigned_to, estimated_hours, kind) VALUES (?, ?, ?, ?, ?, ?, ?)', [parseInt(req.params.applicationId), title, description || null, due_date || null, assigned_to || null, estimated_hours || null, kind || 'general']);
        res.status(201).json({ id: result.lastInsertRowid });
    } catch (error) { console.error('Create milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/milestones/:milestoneId', (req, res) => {
    try {
        const { title, description, due_date, assigned_to, estimated_hours, kind } = req.body;
        runQuery('UPDATE milestones SET title = COALESCE(?, title), description = ?, due_date = ?, assigned_to = ?, estimated_hours = ?, kind = COALESCE(?, kind) WHERE id = ?', [title, description, due_date, assigned_to, estimated_hours, kind, parseInt(req.params.milestoneId)]);
        res.json({ message: 'Milestone updated' });
    } catch (error) { console.error('Update milestone error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/milestones/:milestoneId/complete', (req, res) => { try { runQuery('UPDATE milestones SET completed = 1, completed_at = CURRENT_TIMESTAMP, completion_notes = ? WHERE id = ?', [req.body.notes || null, parseInt(req.params.milestoneId)]); res.json({ message: 'Milestone completed' }); } catch (error) { console.error('Complete milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/milestones/:milestoneId/uncomplete', (req, res) => { try { runQuery('UPDATE milestones SET completed = 0, completed_at = NULL, completion_notes = NULL WHERE id = ?', [parseInt(req.params.milestoneId)]); res.json({ message: 'Milestone uncompleted' }); } catch (error) { console.error('Uncomplete milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/milestones/:milestoneId/approve', (req, res) => { try { runQuery('UPDATE milestones SET approved = 1, approved_at = CURRENT_TIMESTAMP WHERE id = ?', [parseInt(req.params.milestoneId)]); res.json({ message: 'Milestone approved' }); } catch (error) { console.error('Approve milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/milestones/:milestoneId/unapprove', (req, res) => { try { runQuery('UPDATE milestones SET approved = 0, approved_at = NULL WHERE id = ?', [parseInt(req.params.milestoneId)]); res.json({ message: 'Milestone unapproved' }); } catch (error) { console.error('Unapprove milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/milestones/:milestoneId/pay', (req, res) => { try { runQuery('UPDATE milestones SET paid = 1, paid_at = CURRENT_TIMESTAMP WHERE id = ?', [parseInt(req.params.milestoneId)]); res.json({ message: 'Milestone paid' }); } catch (error) { console.error('Pay milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.post('/milestones/:milestoneId/unpay', (req, res) => { try { runQuery('UPDATE milestones SET paid = 0, paid_at = NULL WHERE id = ?', [parseInt(req.params.milestoneId)]); res.json({ message: 'Milestone unpaid' }); } catch (error) { console.error('Unpay milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
router.delete('/milestones/:milestoneId', (req, res) => { try { const result = runQuery('DELETE FROM milestones WHERE id = ?', [parseInt(req.params.milestoneId)]); if (result.changes === 0) return res.status(404).json({ error: 'Milestone not found' }); res.json({ message: 'Milestone deleted' }); } catch (error) { console.error('Delete milestone error:', error); res.status(500).json({ error: 'Internal server error' }); } });
`;

fs.appendFileSync(path, newRoutesPart4);
console.log('Part 4 added!');
