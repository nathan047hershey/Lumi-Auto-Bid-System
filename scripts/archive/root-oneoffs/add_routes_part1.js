const fs = require('fs');
const path = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';

const newRoutesPart1 = `

// ==================== APPLICATIONS ====================
router.get('/applications', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const offset = (page - 1) * limit;
        const { status, profile_id, user_id, search } = req.query;
        let whereClauses = ['1=1'];
        let params = [];
        if (status && status !== 'all') { whereClauses.push('a.status = ?'); params.push(status); }
        if (profile_id) { whereClauses.push('a.profile_id = ?'); params.push(parseInt(profile_id)); }
        if (user_id) { whereClauses.push('EXISTS (SELECT 1 FROM user_profile_assignments upa WHERE upa.profile_id = a.profile_id AND upa.user_id = ?)'); params.push(parseInt(user_id)); }
        if (search) { whereClauses.push('(a.company_name LIKE ? OR a.job_role LIKE ?)'); params.push('%'+search+'%', '%'+search+'%'); }
        const whereSQL = whereClauses.join(' AND ');
        const countRow = getOne('SELECT COUNT(*) as total FROM job_applications a WHERE '+whereSQL, params);
        const total = countRow?.total || 0;
        const applications = getAll('SELECT a.*, p.first_name || \' \' || p.last_name as candidate_name, p.email as candidate_email FROM job_applications a LEFT JOIN candidate_profiles p ON a.profile_id = p.id WHERE '+whereSQL+' ORDER BY a.created_at DESC LIMIT ? OFFSET ?', [...params, limit, offset]);
        res.json({ applications, total, page, limit, totalPages: Math.ceil(total / limit) });
    } catch (error) { console.error('Get applications error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/applications/:id', (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'applied', 'interview', 'rejected'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        runQuery('UPDATE job_applications SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, parseInt(req.params.id)]);
        res.json({ message: 'Status updated' });
    } catch (error) { console.error('Update application status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/applications/:id/state', (req, res) => {
    try {
        const { state, reject_reason } = req.body;
        const validStates = ['completed', 'cancelled', 'rejected', 'in_progress'];
        if (!validStates.includes(state)) return res.status(400).json({ error: 'Invalid state' });
        runQuery('UPDATE job_applications SET status = ?, reject_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [state, reject_reason || null, parseInt(req.params.id)]);
        res.json({ message: 'State updated' });
    } catch (error) { console.error('Update application state error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.patch('/applications/:id/flags', (req, res) => {
    try {
        const { success, failed, cancelled } = req.body;
        runQuery('UPDATE job_applications SET success = ?, failed = ?, cancelled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [success ? 1 : 0, failed ? 1 : 0, cancelled ? 1 : 0, parseInt(req.params.id)]);
        res.json({ message: 'Flags updated' });
    } catch (error) { console.error('Update application flags error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

router.delete('/applications/:id', (req, res) => {
    try {
        const result = runQuery('DELETE FROM job_applications WHERE id = ?', [parseInt(req.params.id)]);
        if (result.changes === 0) return res.status(404).json({ error: 'Application not found' });
        res.json({ message: 'Application deleted' });
    } catch (error) { console.error('Delete application error:', error); res.status(500).json({ error: 'Internal server error' }); }
});
`;

const content = fs.readFileSync(path, 'utf8');
const withoutOldExport = content.replace(/module\.exports = router;[\s\n]*$/, '');
fs.writeFileSync(path, withoutOldExport + newRoutesPart1);
console.log('Part 1 added!');
