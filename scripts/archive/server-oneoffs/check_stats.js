// Quick check for statsService aggregate function
const { getAll, getOne } = require('./config/database');

console.log('Testing aggregateStatusForCurrentUser query...');

try {
    const rows = getAll(`
        SELECT a.status, COUNT(*) as count
        FROM job_applications a
        JOIN user_profile_assignments upa ON upa.profile_id = a.profile_id
        WHERE upa.user_id = 1
        GROUP BY a.status
    `);
    console.log('Query result:', rows);
} catch (err) {
    console.error('Query error:', err.message);
}

try {
    const tables = getAll("SELECT name FROM sqlite_master WHERE type='table'");
    console.log('Tables:', tables.map(t => t.name));
} catch (err) {
    console.error('Tables error:', err.message);
}
