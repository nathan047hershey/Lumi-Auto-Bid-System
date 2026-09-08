require('dotenv').config();
const { initDatabase, getOne } = require('./config/database');
(async () => {
  await initDatabase();
  const r = getOne("SELECT id, created_at, updated_at, last_fetched_at, fetch_status FROM job_links WHERE id = 176");
  console.log(JSON.stringify(r, null, 2));
})();
