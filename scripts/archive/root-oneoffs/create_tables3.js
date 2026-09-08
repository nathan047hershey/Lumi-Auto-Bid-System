const path = require('path');
const fs = require('fs');
const initSqlJs = require(path.join(__dirname, 'server', 'node_modules', 'sql.js'));

async function main() {
    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'server', 'database.sqlite');
    
    let db;
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    
    // Create caller_assignments table if not exists
    db.run(`
        CREATE TABLE IF NOT EXISTS caller_assignments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            application_id INTEGER NOT NULL,
            caller_id INTEGER NOT NULL,
            assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (application_id) REFERENCES job_applications(id),
            FOREIGN KEY (caller_id) REFERENCES users(id),
            UNIQUE(application_id, caller_id)
        )
    `);
    
    console.log('Table created/verified');
    
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
    console.log('Database saved');
    
    db.close();
}

main().catch(console.error);
