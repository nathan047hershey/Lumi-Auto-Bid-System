// Seed script: Part 1 - Creates test users (role=user)
const path = require('path');
process.chdir(path.join(__dirname, 'server'));
const bcrypt = require('bcryptjs');
const { initDatabase, getOne, runQuery } = require('./config/database');

(async () => {
    try {
        await initDatabase();
        console.log('\n=== Seeding Test Users ===\n');

        const testUsers = [
            { username: 'alice',   password: 'alice123' },
            { username: 'bob',     password: 'bob123' },
            { username: 'charlie', password: 'charlie123' },
            { username: 'diana',   password: 'diana123' },
            { username: 'ethan',   password: 'ethan123' }
        ];

        const userIds = {};
        for (const u of testUsers) {
            const existing = getOne('SELECT id FROM users WHERE username = ?', [u.username]);
            if (existing) {
                console.log(`User '${u.username}' exists (id=${existing.id})`);
                userIds[u.username] = existing.id;
            } else {
                const hash = bcrypt.hashSync(u.password, 10);
                const result = runQuery(
                    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
                    [u.username, hash, 'user']
                );
                userIds[u.username] = result.lastInsertRowid;
                console.log(`Created user '${u.username}' (id=${result.lastInsertRowid})`);
            }
        }
        require('fs').writeFileSync('seed_state.json', JSON.stringify({ userIds }, null, 2));
        console.log('\nDone with users.');
    } catch (e) {
        console.error('Error:', e.message);
    }
})();
