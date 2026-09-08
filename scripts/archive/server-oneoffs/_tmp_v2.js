require('dotenv').config();
const { initDatabase, getOne } = require('./config/database');
(async () => {
  await initDatabase();
  const r = getOne("SELECT id, length(job_description) as len, fetch_status, fetch_error FROM job_links WHERE id = 176");
  console.log('Row 176:', JSON.stringify(r, null, 2));
  console.log('---');
  const d = getOne("SELECT job_description FROM job_links WHERE id = 176");
  console.log('description:', d?.job_description);
})();
