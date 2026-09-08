const initSqlJs = require('sql.js');
const fs = require('fs');
initSqlJs().then(async (SQL) => {
  const buf = fs.readFileSync('database.sqlite');
  const db = new SQL.Database(buf);
  const r = db.exec("SELECT id, company_name, position_title, fetch_status, LENGTH(COALESCE(job_description,'')) AS desc_len FROM job_links WHERE id IN (73,78)");
  if (r[0]) console.table(r[0].values.map(x => Object.fromEntries(r[0].columns.map((k,i) => [k, x[i]]))));
});
