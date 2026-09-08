require('dotenv').config();
const axios = require('axios');
const { initDatabase, getOne } = require('./config/database');
(async () => {
  const t = (await axios.post('http://localhost:8001/auth/login', { username: 'admin', password: 'admin123' })).data.token;
  // Reset fetch_status to pending and refetch
  await initDatabase();
  const { runQuery } = require('./config/database');
  runQuery("UPDATE job_links SET fetch_status='pending', fetch_error=NULL WHERE id = 176");
  await axios.post('http://localhost:8001/admin/job-links/176/refetch', {}, { headers: { Authorization: `Bearer ${t}` } });
  console.log('Refetch enqueued');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1500));
    await initDatabase();
    const row = getOne("SELECT id, length(job_description) as len, fetch_status, fetch_error FROM job_links WHERE id = 176");
    if (!row) continue;
    if (['fetching','pending'].includes(row.fetch_status)) continue;
    console.log(`After ${i*1.5}s:`, JSON.stringify(row));
    break;
  }
})();
