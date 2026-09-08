const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';

const newRoutesPart3 = `
// ==================== INTERVIEW REQUESTS ====================
router.get('/interview-requests', (req, res) => {
    try {
        const { status, developer_id, page = 1, limit = 50 } = req.query;
        const offset = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);
        let whereClauses = ['1=1'];
        let params = [];
        if (status && status !== 'all') { whereClauses.push('ir.status = ?'); params.push(status); }
        if (developer_id && developer_id !== 'all') { whereClauses.push('ir.developer_id = ?'); params.push(parseInt(developer_id)); }
        const whereSQL = whereClauses.join(' AND ');
        const requests = getAll('SELECT ir.*, a.company_name, a.job_role, a.profile_id, p.first_name || \' \' || p.last_name as candidate_name, u.username as created_by_username, d.username as developer_username FROM interview_requests ir JOIN job_applications a ON ir.application_id = a.id LEFT JOIN candidate_profiles p ON a.profile_id = p.id LEFT JOIN users u ON ir.created_by = u.id LEFT JOIN users d ON ir.developer_id = d.id WHERE '+whereSQL+' ORDER BY ir.created_at DESC LIMIT ? OFFSET ?', [...params, Math.min(parseInt(limit), 100), offset]);
        res.json(requests);
    } catch (error) { console.error('Get interview requests error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/interview-requests/summary', (req, res) => {
    try {
        const rows = getAll('SELECT status, COUNT(*) as count FROM interview_requests GROUP BY status');
        const summary = { requested: 0, scheduled: 0, completed: 0, cancelled: 0, total: 0 };
        for (const row of rows) { summary[row.status] = row.count; summary.total += row.count; }
        res.json(summary);
    } catch (error) { console.error('Get interview requests summary error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/interview-requests/:id/status', (req, res) => {
    try {
        const { status, notes } = req.body;
        const validStatuses = ['requested', 'scheduled', 'completed', 'cancelled'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        runQuery('UPDATE interview_requests SET status = ?, recruiter_reply = ?, recruiter_reply_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, notes || null, parseInt(req.params.id)]);
        res.json({ message: 'Status updated' });
    } catch (error) { console.error('Update interview request status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/interview-requests/:id', (req, res) => {
    try {
        const { status, recruiter_reply, interview_type, scheduled_date, scheduled_time, timezone, interviewer_name, location, meeting_link, user_notes, reply_channel } = req.body;
        runQuery('UPDATE interview_requests SET status = COALESCE(?, status), recruiter_reply = ?, interview_type = ?, scheduled_date = ?, scheduled_time = ?, timezone = ?, interviewer_name = ?, location = ?, meeting_link = ?, user_notes = ?, reply_channel = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, recruiter_reply, interview_type, scheduled_date, scheduled_time, timezone, interviewer_name, location, meeting_link, user_notes, reply_channel, parseInt(req.params.id)]);
        res.json({ message: 'Interview request updated' });
    } catch (error) { console.error('Update interview request error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/interview-requests/:id/assign-developer', (req, res) => {
    try {
        const { developer_id } = req.body;
        if (developer_id === null) {
            runQuery('UPDATE interview_requests SET developer_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [parseInt(req.params.id)]);
        } else {
            runQuery('UPDATE interview_requests SET developer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [parseInt(developer_id), parseInt(req.params.id)]);
        }
        res.json({ message: 'Developer assigned' });
    } catch (error) { console.error('Assign developer error:', error); res.status(500).json({ error: 'Internal server error' }); }
});
`;

fs.appendFileSync(path, newRoutesPart3);
console.log('Part 3 added!');
