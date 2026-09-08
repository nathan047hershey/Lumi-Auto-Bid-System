/**
 * Ensure demo user bob / bob123 exists (and reset password if already present).
 * Usage: node server/scripts/ensure_bob_user.js
 */
const bcrypt = require('bcryptjs');
const path = require('path');

async function main() {
    process.chdir(path.join(__dirname, '..'));
    const { initDatabase, getOne, getAll, runQuery, saveDatabase } = require('../config/database');
    await initDatabase();

    const hash = bcrypt.hashSync('bob123', 10);
    let user = getOne('SELECT id, username, role FROM users WHERE username = ?', ['bob']);
    if (!user) {
        runQuery(
            'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
            ['bob', hash, 'user']
        );
        user = getOne('SELECT id, username, role FROM users WHERE username = ?', ['bob']);
        console.log('Created user bob / bob123');
    } else {
        runQuery('UPDATE users SET password_hash = ?, role = ? WHERE id = ?', [hash, 'user', user.id]);
        console.log('Reset password for bob / bob123 (id=' + user.id + ')');
    }

    try {
        runQuery(
            'INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)',
            [user.id, 'user']
        );
    } catch (err) {
        // older schemas may not have user_roles
        console.warn('user_roles note:', err.message);
    }

    // Assign at least one profile if any exist and bob has none
    let assignment = getOne(
        'SELECT id FROM user_profile_assignments WHERE user_id = ? LIMIT 1',
        [user.id]
    );
    if (!assignment) {
        let profile = getOne('SELECT id FROM candidate_profiles ORDER BY id LIMIT 1');
        if (!profile) {
            runQuery(
                `INSERT INTO candidate_profiles
                 (first_name, last_name, email, phone, city, state, country, salary_range, work_experience, education)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    'Bob',
                    'Demo',
                    'bob.demo@example.com',
                    '+1-555-0199',
                    'Austin',
                    'TX',
                    'USA',
                    '$120,000 - $150,000',
                    'Software Engineer with React/Node experience.',
                    'BS Computer Science'
                ]
            );
            profile = getOne('SELECT id FROM candidate_profiles ORDER BY id DESC LIMIT 1');
            console.log('Created demo profile id=' + profile.id);
        }
        runQuery(
            'INSERT INTO user_profile_assignments (user_id, profile_id, is_default) VALUES (?, ?, 1)',
            [user.id, profile.id]
        );
        console.log('Assigned profile id=' + profile.id + ' to bob');
    }

    saveDatabase();
    const users = getAll('SELECT id, username, role FROM users ORDER BY id');
    console.log('Users in DB:');
    for (const u of users) console.log('  -', u.username, '(' + u.role + ')');
    console.log('\nLogin: bob / bob123');
    console.log('If the API is already running, restart it (or call reload-database) so it picks up this change.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
