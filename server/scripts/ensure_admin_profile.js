/**
 * Ensure admin has at least one assigned candidate profile.
 * Usage: node server/scripts/ensure_admin_profile.js
 */
const path = require('path');

async function main() {
    process.chdir(path.join(__dirname, '..'));
    const { initDatabase, getOne, getAll, runQuery, saveDatabase } = require('../config/database');
    await initDatabase();

    const admin = getOne("SELECT id, username FROM users WHERE username = 'admin'");
    if (!admin) throw new Error('admin user missing');

    let assignment = getOne(
        'SELECT id, profile_id FROM user_profile_assignments WHERE user_id = ? LIMIT 1',
        [admin.id]
    );

    let profile = getOne('SELECT id, first_name, last_name FROM candidate_profiles ORDER BY id LIMIT 1');
    if (!profile) {
        runQuery(
            `INSERT INTO candidate_profiles
             (first_name, last_name, email, phone, city, state, country, salary_range, work_experience, education)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                'Admin',
                'Candidate',
                'admin.candidate@example.com',
                '+1-555-0100',
                'Austin',
                'TX',
                'USA',
                '$120,000 - $150,000',
                'Full-stack engineer. React, Node.js, Python.',
                'BS Computer Science'
            ]
        );
        profile = getOne('SELECT id, first_name, last_name FROM candidate_profiles ORDER BY id DESC LIMIT 1');
        console.log('Created profile', profile.id, profile.first_name, profile.last_name);
    }

    if (!assignment) {
        runQuery(
            'INSERT INTO user_profile_assignments (user_id, profile_id, is_default) VALUES (?, ?, 1)',
            [admin.id, profile.id]
        );
        console.log('Assigned profile', profile.id, 'to admin as default');
    } else {
        // Make sure one is default
        runQuery(
            'UPDATE user_profile_assignments SET is_default = 1 WHERE user_id = ? AND profile_id = ?',
            [admin.id, assignment.profile_id]
        );
        console.log('Admin already has profile', assignment.profile_id, '(marked default)');
    }

    // Also ensure bob keeps a profile if present
    const bob = getOne("SELECT id FROM users WHERE username = 'bob'");
    if (bob) {
        const bobAsg = getOne(
            'SELECT id FROM user_profile_assignments WHERE user_id = ? LIMIT 1',
            [bob.id]
        );
        if (!bobAsg) {
            runQuery(
                'INSERT INTO user_profile_assignments (user_id, profile_id, is_default) VALUES (?, ?, 1)',
                [bob.id, profile.id]
            );
            console.log('Assigned same profile to bob');
        }
    }

    saveDatabase();

    const rows = getAll(`
        SELECT u.username, p.id AS profile_id, p.first_name, p.last_name, a.is_default
        FROM user_profile_assignments a
        JOIN users u ON u.id = a.user_id
        JOIN candidate_profiles p ON p.id = a.profile_id
        ORDER BY u.username, p.id
    `);
    console.log('\nAssignments:');
    for (const r of rows) {
        console.log(
            `  ${r.username} → #${r.profile_id} ${r.first_name} ${r.last_name}` +
            (r.is_default ? ' (default)' : '')
        );
    }
    console.log('\nRestart API or reload DB so the running server sees this.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
