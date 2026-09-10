const initSqlJs = require('../../server/node_modules/sql.js');
const fs = require('fs');
const path = require('path');
(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '../../database/database.sqlite')));
    const r = db.exec(
        'SELECT id, first_name, last_name, gender, disability_status, race_ethnicity, years_of_experience FROM candidate_profiles LIMIT 10'
    );
    if (!r[0]) {
        console.log('none');
        return;
    }
    for (const v of r[0].values) {
        console.log(JSON.stringify(Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]]))));
    }
})();
