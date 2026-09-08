// Cleanup script: Find all rows in job_links where fetch_error is "AggregateError"
// and either clear it or retry the fetch
const path = require('path');
process.chdir(path.join(__dirname, 'server'));
const { initDatabase, getAll, runQuery } = require('./config/database');

(async () => {
    try {
        await initDatabase();
        const rows = getAll(`SELECT id, fetch_status, fetch_error FROM job_links WHERE fetch_error LIKE '%AggregateError%' OR fetch_error LIKE '%[object%' LIMIT 20`);
        console.log(`Found ${rows.length} rows with AggregateError or [object`);
        rows.forEach(r => {
            console.log(`  #${r.id} status=${r.fetch_status} error="${r.fetch_error && r.fetch_error.slice(0,80)}"`);
        });

        if (rows.length > 0) {
            console.log('\nResetting these rows to pending for retry...');
            const ids = rows.map(r => r.id);
            const placeholders = ids.map(() => '?').join(',');
            runQuery(`UPDATE job_links SET fetch_status = 'pending', fetch_error = NULL, next_retry_at = NULL WHERE id IN (${placeholders})`, ids);
            console.log(`Reset ${ids.length} rows. They'll be retried automatically.`);
        }
    } catch (e) {
        console.error('Error:', e.message);
    }
})();
