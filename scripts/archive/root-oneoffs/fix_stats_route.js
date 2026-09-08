const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js';
let c = fs.readFileSync(p, 'utf8');

// Improve stats route error handling
const oldRoute = `router.get('/stats', (req, res) => { try { let userIds = []; if (req.query.userIds !== undefined) { const raw = Array.isArray(req.query.userIds) ? req.query.userIds : [req.query.userIds]; for (const part of raw) { for (const v of String(part).split(',')) { const n = Number(v.trim()); if (Number.isFinite(n)) userIds.push(n); } } userIds = Array.from(new Set(userIds)); } const allowedPeriods = new Set(['workday', '24h', '7d', '30d', 'custom']); const periodKey = allowedPeriods.has(req.query.period) ? req.query.period : '24h'; const from = typeof req.query.from === 'string' ? req.query.from : undefined; const to = typeof req.query.to === 'string' ? req.query.to : undefined; const payload = buildStatsResponse(req, 'admin', { userIds, periodKey, from, to }); res.json(payload); } catch (error) { console.error('Get admin stats error:', error); res.status(500).json({ error: 'Internal server error' }); } });`;

const newRoute = `router.get('/stats', (req, res) => { try { let userIds = []; if (req.query.userIds !== undefined) { const raw = Array.isArray(req.query.userIds) ? req.query.userIds : [req.query.userIds]; for (const part of raw) { for (const v of String(part).split(',')) { const n = Number(v.trim()); if (Number.isFinite(n)) userIds.push(n); } } userIds = Array.from(new Set(userIds)); } const allowedPeriods = new Set(['workday', '24h', '7d', '30d', 'custom']); const periodKey = allowedPeriods.has(req.query.period) ? req.query.period : '24h'; const from = typeof req.query.from === 'string' ? req.query.from : undefined; const to = typeof req.query.to === 'string' ? req.query.to : undefined; const payload = buildStatsResponse(req, 'admin', { userIds, periodKey, from, to }); res.json(payload); } catch (error) { console.error('Get admin stats error:', error); const errMsg = error instanceof Error ? error.message : String(error); res.status(500).json({ error: 'Internal server error: ' + errMsg }); } });`;

if (c.includes(oldRoute)) {
    c = c.replace(oldRoute, newRoute);
    fs.writeFileSync(p, c);
    console.log('Fixed stats route error handling');
} else {
    console.log('Stats route pattern not found');
}
