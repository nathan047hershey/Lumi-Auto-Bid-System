/**
 * Seed profile education + github for autofill testing.
 * Usage: node server/scripts/seed_profile_education.js [profileId]
 */
const path = require('path');
const http = require('http');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', 'local.env'), override: true });

function request(method, urlPath, body, token) {
    return new Promise((resolve, reject) => {
        const data = body != null ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: '127.0.0.1',
            port: 9017,
            path: urlPath,
            method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            }
        }, (res) => {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(b || '{}') }); }
                catch { resolve({ status: res.statusCode, data: { raw: b } }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const profileId = parseInt(process.argv[2] || '2', 10);
    let login = await request('POST', '/auth/login', { username: 'admin', password: 'admin123' });
    if (!login.data?.token) {
        login = await request('POST', '/auth/login', { username: 'bob', password: 'bob123' });
    }
    const token = login.data?.token || login.data?.access_token;
    if (!token) {
        console.error('Login failed', login);
        process.exit(1);
    }

    // Get current profile (admin list or user)
    let profile = null;
    const asAdmin = await request('GET', `/admin/profiles/${profileId}`, null, token);
    if (asAdmin.status === 200 && asAdmin.data?.id) {
        profile = asAdmin.data;
    } else {
        const list = await request('GET', '/user/profiles', null, token);
        profile = (list.data || []).find((p) => Number(p.id) === profileId);
    }
    if (!profile) {
        console.error('Profile not found', profileId);
        process.exit(1);
    }

    const education = profile.education || 'B.S. Honors degrees in Computer Science at Virginia Tech in 2004 - 2007';
    const patch = {
        first_name: profile.first_name,
        last_name: profile.last_name,
        education,
        school: profile.school || 'Virginia Tech',
        degree: profile.degree || 'Bachelor of Science',
        discipline: profile.discipline || 'Computer Science',
        education_level: profile.education_level || "Bachelor's",
        years_of_experience: profile.years_of_experience || '18',
        github_url: profile.github_url || '',
        website_url: profile.website_url || '',
        city: profile.city || 'Palo Alto',
        state: profile.state || 'CA',
        country: profile.country || 'United States',
        work_authorization: profile.work_authorization || 'Yes'
    };

    let saved;
    if (asAdmin.status === 200) {
        saved = await request('PUT', `/admin/profiles/${profileId}`, { ...profile, ...patch }, token);
    } else {
        // User cannot update profile fields usually — try admin only message
        console.error('Need admin login to update profile. Status', asAdmin.status, asAdmin.data);
        process.exit(1);
    }

    console.log(JSON.stringify({
        ok: saved.status < 400,
        status: saved.status,
        seeded: {
            school: patch.school,
            degree: patch.degree,
            discipline: patch.discipline,
            years_of_experience: patch.years_of_experience,
            github_url: patch.github_url,
            city: patch.city
        },
        response: saved.data
    }, null, 2));
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
