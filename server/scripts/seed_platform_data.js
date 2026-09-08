#!/usr/bin/env node
'use strict';

/**
 * Comprehensive platform seed data for manual QA and API smoke tests.
 *
 * Usage (from repo root):
 *   node server/scripts/seed_platform_data.js
 *
 * Idempotent — safe to re-run. Uses stable usernames / apply URLs as keys.
 */

const path = require('path');
const bcrypt = require('bcryptjs');

process.chdir(path.join(__dirname, '..'));

const { initDatabase, getOne, getAll, runQuery, saveDatabase } = require('../config/database');

const SEED_PREFIX = 'https://seed-data.local';

/** Number of auto-generated bulk job links (plus 8 curated fixtures). */
const BULK_JOB_LINK_COUNT = Math.max(
    50,
    parseInt(process.argv[2] || process.env.SEED_BULK_LINKS || '55', 10) || 55
);

const SEED_TECHSTACKS = ['python', 'java', 'dotnet', 'golang', 'nodejs', 'frontend'];
const SEED_LOCATION_FLAGS = ['US', 'Brazil', 'EU', 'Asia', 'Other'];
const SEED_FETCH_STATUSES = ['success', 'success', 'success', 'success', 'pending', 'failed', 'fetching'];
const SEED_LOCATIONS = {
    US: ['Remote US', 'New York, NY', 'Austin, TX', 'Seattle, WA', 'Boston, MA', 'Chicago, IL'],
    Brazil: ['São Paulo, SP', 'Remote Brazil', 'Rio de Janeiro, RJ', 'Curitiba, PR'],
    EU: ['London, UK', 'Berlin, Germany', 'Remote EU', 'Amsterdam, NL', 'Paris, France'],
    Asia: ['Singapore', 'Bangalore, India', 'Tokyo, Japan', 'Remote APAC'],
    Other: ['Toronto, Canada', 'Sydney, Australia', 'Mexico City, MX']
};
const SEED_TITLES = {
    python: ['Python Engineer', 'Senior Python Developer', 'ML Engineer', 'Data Engineer', 'Django Developer'],
    java: ['Java Developer', 'Spring Boot Engineer', 'Backend Java Engineer', 'JVM Platform Engineer'],
    dotnet: ['.NET Developer', 'C# Software Engineer', 'Azure Backend Engineer', 'Lead .NET Architect'],
    golang: ['Golang Engineer', 'Go Backend Developer', 'Platform Engineer', 'Payments Engineer'],
    nodejs: ['Node.js Developer', 'Full Stack Node Engineer', 'API Engineer', 'TypeScript Backend Dev'],
    frontend: ['Frontend Engineer', 'React Developer', 'Senior UI Engineer', 'Web Performance Engineer']
};
const SEED_SKILLS = {
    python: 'Python, Django, FastAPI, PostgreSQL, AWS',
    java: 'Java 17, Spring Boot, Kafka, Microservices',
    dotnet: 'C#, .NET 8, Azure, Entity Framework',
    golang: 'Go, gRPC, PostgreSQL, Kubernetes',
    nodejs: 'Node.js, TypeScript, Express, MongoDB',
    frontend: 'React, TypeScript, CSS, accessibility, Vite'
};

function bindParams(params) {
    return params.map((p) => (p === undefined ? null : p));
}

function q(sql, params = []) {
    return runQuery(sql, bindParams(params));
}

function daysAgo(n, hour = 10) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(hour, 30, 0, 0);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

function hoursAgo(n) {
    const d = new Date(Date.now() - n * 60 * 60 * 1000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

function upsertUser(username, password, role, fields = {}) {
    let row = getOne('SELECT id, role FROM users WHERE username = ?', [username]);
    const hash = bcrypt.hashSync(password, 10);
    if (row) {
        q(
            `UPDATE users SET role = ?, password_hash = ?,
                technical_skills = COALESCE(?, technical_skills),
                availability = COALESCE(?, availability),
                contact_email = COALESCE(?, contact_email)
             WHERE id = ?`,
            [
                role,
                hash,
                fields.technical_skills ?? null,
                fields.availability ?? null,
                fields.contact_email ?? null,
                row.id
            ]
        );
        return row.id;
    }
    const result = q(
        `INSERT INTO users (username, password_hash, role, technical_skills, availability, contact_email, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            username,
            hash,
            role,
            fields.technical_skills ?? null,
            fields.availability ?? null,
            fields.contact_email ?? null,
            fields.created_by ?? null
        ]
    );
    return result.lastInsertRowid;
}

function ensureUserRole(userId, role) {
    const existing = getOne('SELECT id FROM user_roles WHERE user_id = ? AND role = ?', [userId, role]);
    if (!existing) {
        q('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', [userId, role]);
    }
}

function upsertProfile(data, adminId) {
    const existing = getOne('SELECT id FROM candidate_profiles WHERE email = ?', [data.email]);
    if (existing) {
        q(
            `UPDATE candidate_profiles SET
                first_name = ?, last_name = ?, phone = ?, city = ?, state = ?, country = ?,
                work_experience = ?, education = ?, resume_prompt = ?, location_flag = ?
             WHERE id = ?`,
            [
                data.first_name,
                data.last_name,
                data.phone,
                data.city,
                data.state,
                data.country,
                data.work_experience,
                data.education,
                data.resume_prompt,
                data.location_flag,
                existing.id
            ]
        );
        return existing.id;
    }
    const result = q(
        `INSERT INTO candidate_profiles
            (first_name, last_name, email, phone, city, state, country,
             work_experience, education, resume_prompt, location_flag, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.first_name,
            data.last_name,
            data.email,
            data.phone,
            data.city,
            data.state,
            data.country,
            data.work_experience,
            data.education,
            data.resume_prompt,
            data.location_flag,
            adminId
        ]
    );
    return result.lastInsertRowid;
}

function setProfileTechstacks(profileId, stacks) {
    q('DELETE FROM profile_techstacks WHERE profile_id = ?', [profileId]);
    for (const t of stacks) {
        q('INSERT INTO profile_techstacks (profile_id, techstack) VALUES (?, ?)', [profileId, t]);
    }
}

function assignProfile(userId, profileId) {
    const existing = getOne(
        'SELECT id FROM user_profile_assignments WHERE user_id = ? AND profile_id = ?',
        [userId, profileId]
    );
    if (!existing) {
        const count = getOne(
            'SELECT COUNT(*) AS c FROM user_profile_assignments WHERE user_id = ?',
            [userId]
        );
        const isDefault = (count?.c || 0) === 0 ? 1 : 0;
        q(
            'INSERT INTO user_profile_assignments (user_id, profile_id, is_default) VALUES (?, ?, ?)',
            [userId, profileId, isDefault]
        );
    }
}

function upsertJobLink(data, adminId) {
    const existing = getOne('SELECT id FROM job_links WHERE job_apply_url = ?', [data.job_apply_url]);
    const cols = [
        'techstack', 'source_url', 'job_apply_url', 'job_description',
        'company_name', 'position_title', 'location', 'location_flag',
        'is_available', 'clearance_required', 'fetch_status', 'fetch_error', 'created_by', 'created_at'
    ];
    const vals = [
        data.techstack,
        data.source_url,
        data.job_apply_url,
        data.job_description,
        data.company_name,
        data.position_title,
        data.location,
        data.location_flag,
        data.is_available,
        data.clearance_required,
        data.fetch_status,
        data.fetch_error,
        adminId,
        data.created_at || daysAgo(0)
    ];
    if (existing) {
        q(
            `UPDATE job_links SET
                techstack = ?, source_url = ?, job_description = ?,
                company_name = ?, position_title = ?, location = ?, location_flag = ?,
                is_available = ?, clearance_required = ?, fetch_status = ?, fetch_error = ?,
                created_at = ?
             WHERE id = ?`,
            [
                data.techstack,
                data.source_url,
                data.job_description,
                data.company_name,
                data.position_title,
                data.location,
                data.location_flag,
                data.is_available,
                data.clearance_required,
                data.fetch_status,
                data.fetch_error,
                data.created_at || daysAgo(0),
                existing.id
            ]
        );
        return existing.id;
    }
    const result = q(
        `INSERT INTO job_links
            (techstack, source_url, job_apply_url, job_description, company_name, position_title,
             location, location_flag, is_available, clearance_required, fetch_status, fetch_error,
             created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        vals
    );
    return result.lastInsertRowid;
}

function upsertApplication(data) {
    const existing = getOne(
        `SELECT id FROM job_applications
         WHERE profile_id = ? AND company_name = ? AND job_role = ?`,
        [data.profile_id, data.company_name, data.job_role]
    );
    if (existing) {
        q(
            `UPDATE job_applications SET
                core_skills = ?, job_description = ?, resume_filename = ?,
                status = ?, state = ?, source = ?, job_link_id = ?, match_score = ?,
                generation_status = ?, applier_id = ?, job_url = ?, reject_reason = ?,
                created_at = ?, updated_at = ?
             WHERE id = ?`,
            [
                data.core_skills,
                data.job_description,
                data.resume_filename,
                data.status,
                data.state,
                data.source,
                data.job_link_id,
                data.match_score,
                data.generation_status,
                data.applier_id,
                data.job_url,
                data.reject_reason,
                data.created_at,
                data.updated_at || data.created_at,
                existing.id
            ]
        );
        return existing.id;
    }
    const result = q(
        `INSERT INTO job_applications
            (profile_id, company_name, job_role, core_skills, job_description, resume_filename,
             status, state, source, job_link_id, match_score, generation_status, applier_id,
             job_url, reject_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.profile_id,
            data.company_name,
            data.job_role,
            data.core_skills,
            data.job_description,
            data.resume_filename,
            data.status,
            data.state,
            data.source,
            data.job_link_id,
            data.match_score,
            data.generation_status,
            data.applier_id,
            data.job_url,
            data.reject_reason,
            data.created_at,
            data.updated_at || data.created_at
        ]
    );
    return result.lastInsertRowid;
}

function upsertInterviewRequest(data) {
    const existing = getOne(
        'SELECT id FROM interview_requests WHERE application_id = ?',
        [data.application_id]
    );
    if (existing) {
        q(
            `UPDATE interview_requests SET
                status = ?, recruiter_reply = ?, recruiter_reply_at = ?,
                interview_type = ?, scheduled_date = ?, scheduled_time = ?, timezone = ?,
                interviewer_name = ?, location = ?, meeting_link = ?, user_notes = ?,
                reply_channel = ?, assigned_developer_id = ?, created_by = ?,
                created_at = ?, updated_at = ?
             WHERE id = ?`,
            [
                data.status,
                data.recruiter_reply,
                data.recruiter_reply_at,
                data.interview_type,
                data.scheduled_date,
                data.scheduled_time,
                data.timezone,
                data.interviewer_name,
                data.location,
                data.meeting_link,
                data.user_notes,
                data.reply_channel,
                data.assigned_developer_id,
                data.created_by,
                data.created_at,
                data.updated_at || data.created_at,
                existing.id
            ]
        );
        return existing.id;
    }
    const result = q(
        `INSERT INTO interview_requests
            (application_id, status, recruiter_reply, recruiter_reply_at, interview_type,
             scheduled_date, scheduled_time, timezone, interviewer_name, location, meeting_link,
             user_notes, reply_channel, assigned_developer_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.application_id,
            data.status,
            data.recruiter_reply,
            data.recruiter_reply_at,
            data.interview_type,
            data.scheduled_date,
            data.scheduled_time,
            data.timezone,
            data.interviewer_name,
            data.location,
            data.meeting_link,
            data.user_notes,
            data.reply_channel,
            data.assigned_developer_id,
            data.created_by,
            data.created_at,
            data.updated_at || data.created_at
        ]
    );
    return result.lastInsertRowid;
}

function nullish(v) {
    return v === undefined ? null : v;
}

function upsertMilestone(requestId, milestone) {
    const existing = getOne(
        'SELECT id FROM interview_milestones WHERE interview_request_id = ? AND position = ?',
        [requestId, milestone.position]
    );
    if (existing) {
        q(
            `UPDATE interview_milestones SET
                kind = ?, label = ?, scheduled_at = ?, completed_at = ?, notes = ?,
                recruiter_message = ?, reply_message = ?, interview_link = ?,
                ai_interview_detail = ?, approved = ?, paid = ?
             WHERE id = ?`,
            [
                milestone.kind,
                milestone.label,
                nullish(milestone.scheduled_at),
                nullish(milestone.completed_at),
                nullish(milestone.notes),
                nullish(milestone.recruiter_message),
                nullish(milestone.reply_message),
                nullish(milestone.interview_link),
                nullish(milestone.ai_interview_detail),
                milestone.approved ? 1 : 0,
                milestone.paid ? 1 : 0,
                existing.id
            ]
        );
        return existing.id;
    }
    const result = q(
        `INSERT INTO interview_milestones
            (interview_request_id, kind, label, scheduled_at, completed_at, notes, position,
             recruiter_message, reply_message, interview_link, ai_interview_detail, approved, paid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            requestId,
            milestone.kind,
            milestone.label,
            nullish(milestone.scheduled_at),
            nullish(milestone.completed_at),
            nullish(milestone.notes),
            milestone.position,
            nullish(milestone.recruiter_message),
            nullish(milestone.reply_message),
            nullish(milestone.interview_link),
            nullish(milestone.ai_interview_detail),
            milestone.approved ? 1 : 0,
            milestone.paid ? 1 : 0
        ]
    );
    return result.lastInsertRowid;
}

function upsertInterview(data) {
    const existing = getOne(
        'SELECT id FROM interviews WHERE application_id = ? AND scheduled_date = ?',
        [data.application_id, data.scheduled_date]
    );
    if (existing) {
        q(
            `UPDATE interviews SET status = ?, scheduled_time = ?, timezone = ?,
                interview_type = ?, interviewer_name = ?, location = ?, meeting_link = ?, notes = ?
             WHERE id = ?`,
            [
                data.status,
                data.scheduled_time,
                data.timezone,
                data.interview_type,
                data.interviewer_name,
                data.location,
                data.meeting_link,
                data.notes,
                existing.id
            ]
        );
        return existing.id;
    }
    const result = q(
        `INSERT INTO interviews
            (application_id, status, scheduled_date, scheduled_time, timezone, interview_type,
             interviewer_name, location, meeting_link, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.application_id,
            data.status,
            data.scheduled_date,
            data.scheduled_time,
            data.timezone,
            data.interview_type,
            data.interviewer_name,
            data.location,
            data.meeting_link,
            data.notes
        ]
    );
    return result.lastInsertRowid;
}

function upsertCallerAssignment(callerId, applicationId) {
    const existing = getOne(
        'SELECT id FROM caller_assignments WHERE caller_id = ? AND application_id = ?',
        [callerId, applicationId]
    );
    if (!existing) {
        q(
            'INSERT INTO caller_assignments (caller_id, application_id) VALUES (?, ?)',
            [callerId, applicationId]
        );
    }
}

function upsertCallerProfile(callerId, data) {
    const existing = getOne('SELECT id FROM caller_profile_inputs WHERE caller_id = ?', [callerId]);
    if (existing) {
        q(
            `UPDATE caller_profile_inputs SET profile_info = ?, years_of_experience = ?,
                main_tech_stack = ?, availability = ?, email = ?, whatsapp = ?
             WHERE caller_id = ?`,
            [
                data.profile_info,
                data.years_of_experience,
                data.main_tech_stack,
                data.availability,
                data.email,
                data.whatsapp,
                callerId
            ]
        );
        return;
    }
    q(
        `INSERT INTO caller_profile_inputs
            (caller_id, profile_info, years_of_experience, main_tech_stack, availability, email, whatsapp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            callerId,
            data.profile_info,
            data.years_of_experience,
            data.main_tech_stack,
            data.availability,
            data.email,
            data.whatsapp
        ]
    );
}

const SAMPLE_JD = (company, role, skills) =>
    `${company} — ${role}\n\nWe are hiring a ${role} to build scalable products.\n\nRequirements:\n- ${skills}\n- 5+ years experience\n- Strong communication\n\nBenefits: remote-friendly, equity, health coverage.`;

/**
 * Generate many job links for pagination / filter QA. Each row gets a
 * stable apply URL under SEED_PREFIX so re-runs upsert instead of duping.
 */
function seedBulkJobLinks(adminId, count) {
    const ids = [];
    for (let i = 1; i <= count; i++) {
        const techstack = SEED_TECHSTACKS[i % SEED_TECHSTACKS.length];
        const locationFlag = SEED_LOCATION_FLAGS[i % SEED_LOCATION_FLAGS.length];
        const fetchStatus = SEED_FETCH_STATUSES[i % SEED_FETCH_STATUSES.length];
        const hasJd = i % 5 !== 0;
        const isAvailable = i % 7 !== 0 ? 1 : 0;
        const clearanceRequired = i % 13 === 0 ? 'Secret' : (i % 17 === 0 ? 'TS/SCI' : null);
        const company = `SeedCorp ${String(i).padStart(2, '0')}`;
        const titles = SEED_TITLES[techstack];
        const positionTitle = titles[i % titles.length];
        const locList = SEED_LOCATIONS[locationFlag] || SEED_LOCATIONS.US;
        const location = locList[i % locList.length];
        const skills = SEED_SKILLS[techstack];
        const slug = `bulk-${String(i).padStart(3, '0')}`;
        const daysBack = i % 45;

        const id = upsertJobLink({
            techstack,
            source_url: `${SEED_PREFIX}/src/${slug}`,
            job_apply_url: `${SEED_PREFIX}/apply/${slug}`,
            job_description: hasJd
                ? SAMPLE_JD(company, positionTitle, skills)
                : '',
            company_name: company,
            position_title: positionTitle,
            location,
            location_flag: locationFlag,
            is_available: clearanceRequired ? 0 : isAvailable,
            clearance_required: clearanceRequired,
            fetch_status: hasJd ? fetchStatus : (fetchStatus === 'success' ? 'pending' : fetchStatus),
            fetch_error: fetchStatus === 'failed' ? `Seed error: simulated fetch failure #${i}` : null,
            created_at: daysAgo(daysBack, 8 + (i % 10))
        }, adminId);
        ids.push(id);
    }
    return ids;
}

async function notifyServerReload() {
    const base = process.env.API_BASE || 'http://localhost:9017';
    try {
        const axios = require('axios');
        const login = await axios.post(`${base}/auth/login`, {
            username: 'admin',
            password: 'admin123'
        });
        const reload = await axios.post(
            `${base}/admin/system/reload-database`,
            {},
            { headers: { Authorization: `Bearer ${login.data.token}` } }
        );
        console.log('\nRunning server picked up seed data:', reload.data.counts);
    } catch (err) {
        if (err.code === 'ECONNREFUSED' || err.response?.status === 404) {
            console.log('\nTip: restart the dev server (`npm run dev`) so it loads the new seed data.');
        } else {
            console.log('\nCould not reload running server:', err.response?.data?.error || err.message);
            console.log('Restart the dev server to see all seeded job links.');
        }
    }
}

async function main() {
    await initDatabase();
    console.log('\n=== Seeding platform test data ===\n');

    const admin = getOne("SELECT id FROM users WHERE username = 'admin'");
    if (!admin) throw new Error('Admin user missing — run the server once to create admin/admin123');
    const adminId = admin.id;

    // ── Users ──────────────────────────────────────────────────────────
    const users = {
        alice: upsertUser('alice', 'alice123', 'user'),
        bob: upsertUser('bob', 'bob123', 'user'),
        charlie: upsertUser('charlie', 'charlie123', 'user'),
        diana: upsertUser('diana', 'diana123', 'user'),
        ethan: upsertUser('ethan', 'ethan123', 'user'),
        frank: upsertUser('frank', 'dev123', 'developer', {
            technical_skills: 'Python, React, System Design',
            availability: 'Mon–Fri 9am–5pm EST',
            contact_email: 'frank.dev@example.com',
            created_by: adminId
        }),
        grace: upsertUser('grace', 'caller123', 'developer', {
            technical_skills: 'Java, Spring, Outreach',
            availability: 'Flexible',
            contact_email: 'grace.caller@example.com',
            created_by: adminId
        }),
        henry: upsertUser('henry', 'mgr123', 'manager', { created_by: adminId }),
        iris: upsertUser('iris', 'dev2123', 'developer', {
            technical_skills: 'Node.js, AWS, Interviews',
            availability: 'Evenings OK',
            contact_email: 'iris.dev@example.com',
            created_by: adminId
        })
    };
    ensureUserRole(users.henry, 'manager');
    ensureUserRole(users.frank, 'developer');
    ensureUserRole(users.grace, 'developer');
    console.log('Users ready:', Object.keys(users).join(', '));

    // ── Profiles ───────────────────────────────────────────────────────
    const profiles = {
        alex: upsertProfile({
            first_name: 'Alex',
            last_name: 'Morgan',
            email: 'alex.morgan@seed.test',
            phone: '+1-555-0101',
            city: 'Austin',
            state: 'TX',
            country: 'USA',
            location_flag: 'US',
            work_experience: 'Senior Software Engineer at TechCorp (2020–Present)\nBuilt React/Node APIs serving 2M users.',
            education: 'BS Computer Science, UT Austin',
            resume_prompt: 'Emphasize full-stack JavaScript and leadership.'
        }, adminId),
        sarah: upsertProfile({
            first_name: 'Sarah',
            last_name: 'Chen',
            email: 'sarah.chen@seed.test',
            phone: '+1-555-0102',
            city: 'Seattle',
            state: 'WA',
            country: 'USA',
            location_flag: 'US',
            work_experience: 'Staff Engineer at CloudScale.\nLed Java microservices migration.',
            education: 'MS Software Engineering, UW',
            resume_prompt: 'Highlight Java, Spring Boot, and cloud architecture.'
        }, adminId),
        marcus: upsertProfile({
            first_name: 'Marcus',
            last_name: 'Johnson',
            email: 'marcus.johnson@seed.test',
            phone: '+55-11-5555-0103',
            city: 'São Paulo',
            state: 'SP',
            country: 'Brazil',
            location_flag: 'Brazil',
            work_experience: 'Golang backend developer at FinTech BR.',
            education: 'BSc Information Systems',
            resume_prompt: 'Focus on Golang, PostgreSQL, and payments.'
        }, adminId),
        priya: upsertProfile({
            first_name: 'Priya',
            last_name: 'Patel',
            email: 'priya.patel@seed.test',
            phone: '+44-20-5555-0104',
            city: 'London',
            state: '',
            country: 'UK',
            location_flag: 'EU',
            work_experience: 'Frontend engineer — design systems and React.',
            education: 'BEng Computing, Imperial College',
            resume_prompt: 'Frontend, accessibility, and performance.'
        }, adminId),
        liam: upsertProfile({
            first_name: 'Liam',
            last_name: 'O’Brien',
            email: 'liam.obrien@seed.test',
            phone: '+1-555-0105',
            city: 'Boston',
            state: 'MA',
            country: 'USA',
            location_flag: 'US',
            work_experience: '.NET developer — enterprise healthcare apps.',
            education: 'BS Computer Science, Northeastern',
            resume_prompt: 'C#, .NET Core, Azure, HL7/FHIR experience.'
        }, adminId)
    };

    setProfileTechstacks(profiles.alex, ['frontend', 'nodejs']);
    setProfileTechstacks(profiles.sarah, ['java', 'dotnet']);
    setProfileTechstacks(profiles.marcus, ['golang', 'nodejs']);
    setProfileTechstacks(profiles.priya, ['frontend', 'python']);
    setProfileTechstacks(profiles.liam, ['dotnet', 'java']);

    assignProfile(users.alice, profiles.alex);
    assignProfile(users.bob, profiles.sarah);
    assignProfile(users.bob, profiles.liam);
    assignProfile(users.charlie, profiles.marcus);
    assignProfile(users.diana, profiles.priya);
    assignProfile(users.ethan, profiles.alex);
    assignProfile(users.ethan, profiles.marcus);
    console.log('Profiles + assignments ready');

    // ── Job links ──────────────────────────────────────────────────────
    const jobLinks = {
        pythonSr: upsertJobLink({
            techstack: 'python',
            source_url: `${SEED_PREFIX}/src/python-sr`,
            job_apply_url: `${SEED_PREFIX}/apply/python-sr`,
            job_description: SAMPLE_JD('DataFlow Inc', 'Senior Python Engineer', 'Python, Django, PostgreSQL, AWS'),
            company_name: 'DataFlow Inc',
            position_title: 'Senior Python Engineer',
            location: 'Remote US',
            location_flag: 'US',
            is_available: 1,
            clearance_required: null,
            fetch_status: 'success',
            fetch_error: null,
            created_at: daysAgo(1)
        }, adminId),
        javaMid: upsertJobLink({
            techstack: 'java',
            source_url: `${SEED_PREFIX}/src/java-mid`,
            job_apply_url: `${SEED_PREFIX}/apply/java-mid`,
            job_description: SAMPLE_JD('BankCore', 'Java Backend Developer', 'Java 17, Spring Boot, Kafka'),
            company_name: 'BankCore',
            position_title: 'Java Backend Developer',
            location: 'New York, NY',
            location_flag: 'US',
            is_available: 1,
            clearance_required: null,
            fetch_status: 'success',
            fetch_error: null,
            created_at: daysAgo(2)
        }, adminId),
        dotnetLead: upsertJobLink({
            techstack: 'dotnet',
            source_url: `${SEED_PREFIX}/src/dotnet-lead`,
            job_apply_url: `${SEED_PREFIX}/apply/dotnet-lead`,
            job_description: SAMPLE_JD('HealthSync', 'Lead .NET Architect', 'C#, .NET 8, Azure, microservices'),
            company_name: 'HealthSync',
            position_title: 'Lead .NET Architect',
            location: 'Boston, MA',
            location_flag: 'US',
            is_available: 1,
            clearance_required: null,
            fetch_status: 'success',
            fetch_error: null,
            created_at: daysAgo(3)
        }, adminId),
        golangEmpty: upsertJobLink({
            techstack: 'golang',
            source_url: `${SEED_PREFIX}/src/golang-pending`,
            job_apply_url: `${SEED_PREFIX}/apply/golang-pending`,
            job_description: '',
            company_name: 'PayStream',
            position_title: 'Golang Engineer',
            location: 'São Paulo, Brazil',
            location_flag: 'Brazil',
            is_available: 1,
            clearance_required: null,
            fetch_status: 'pending',
            fetch_error: null,
            created_at: daysAgo(0)
        }, adminId),
        nodeFailed: upsertJobLink({
            techstack: 'nodejs',
            source_url: `${SEED_PREFIX}/src/node-failed`,
            job_apply_url: `${SEED_PREFIX}/apply/node-failed`,
            job_description: '',
            company_name: 'ShopAPI',
            position_title: 'Node.js Developer',
            location: 'Berlin, Germany',
            location_flag: 'EU',
            is_available: 0,
            clearance_required: null,
            fetch_status: 'failed',
            fetch_error: 'HTTP 403 from source URL',
            created_at: daysAgo(5)
        }, adminId),
        frontendRemote: upsertJobLink({
            techstack: 'frontend',
            source_url: `${SEED_PREFIX}/src/fe-remote`,
            job_apply_url: `${SEED_PREFIX}/apply/fe-remote`,
            job_description: SAMPLE_JD('DesignHub', 'Senior Frontend Engineer', 'React, TypeScript, CSS, accessibility'),
            company_name: 'DesignHub',
            position_title: 'Senior Frontend Engineer',
            location: 'Remote EU',
            location_flag: 'EU',
            is_available: 1,
            clearance_required: null,
            fetch_status: 'success',
            fetch_error: null,
            created_at: daysAgo(7)
        }, adminId),
        javaClearance: upsertJobLink({
            techstack: 'java',
            source_url: `${SEED_PREFIX}/src/java-clearance`,
            job_apply_url: `${SEED_PREFIX}/apply/java-clearance`,
            job_description: SAMPLE_JD('DefenseTech', 'Java Developer (TS/SCI)', 'Java, security clearance required'),
            company_name: 'DefenseTech',
            position_title: 'Java Developer',
            location: 'Washington, DC',
            location_flag: 'US',
            is_available: 0,
            clearance_required: 'TS/SCI',
            fetch_status: 'success',
            fetch_error: null,
            created_at: daysAgo(14)
        }, adminId),
        pythonOld: upsertJobLink({
            techstack: 'python',
            source_url: `${SEED_PREFIX}/src/python-old`,
            job_apply_url: `${SEED_PREFIX}/apply/python-old`,
            job_description: SAMPLE_JD('LegacyCo', 'Python Data Engineer', 'Python, Spark, Airflow'),
            company_name: 'LegacyCo',
            position_title: 'Python Data Engineer',
            location: 'Chicago, IL',
            location_flag: 'US',
            is_available: 1,
            clearance_required: null,
            fetch_status: 'success',
            fetch_error: null,
            created_at: daysAgo(30)
        }, adminId)
    };
    const bulkLinkIds = seedBulkJobLinks(adminId, BULK_JOB_LINK_COUNT);
    const seedLinkTotal = getOne(
        'SELECT COUNT(*) AS n FROM job_links WHERE job_apply_url LIKE ?',
        [`${SEED_PREFIX}/apply/%`]
    )?.n;
    console.log(
        `Job links ready: ${Object.keys(jobLinks).length} curated + ${bulkLinkIds.length} bulk`
        + ` (${seedLinkTotal} seed URLs total)`
    );

    // ── Applications ───────────────────────────────────────────────────
    const jdPython = SAMPLE_JD('DataFlow Inc', 'Senior Python Engineer', 'Python, FastAPI, PostgreSQL');
    const jdJava = SAMPLE_JD('BankCore', 'Java Backend Developer', 'Java, Spring, Kafka');
    const jdFrontend = SAMPLE_JD('DesignHub', 'Senior Frontend Engineer', 'React, TypeScript');
    const jdDotnet = SAMPLE_JD('HealthSync', 'Lead .NET Architect', 'C#, Azure');
    const jdGolang = SAMPLE_JD('FinTech BR', 'Golang Payments Engineer', 'Go, gRPC, PostgreSQL');

    const apps = {
        alexPending: upsertApplication({
            profile_id: profiles.alex,
            company_name: 'DataFlow Inc',
            job_role: 'Senior Python Engineer',
            core_skills: 'Python, Django, AWS, PostgreSQL',
            job_description: jdPython,
            resume_filename: 'alex_dataflow_seed.docx',
            status: 'pending',
            state: 'in_progress',
            source: 'user',
            job_link_id: jobLinks.pythonSr,
            match_score: null,
            generation_status: 'ready',
            applier_id: users.alice,
            job_url: `${SEED_PREFIX}/apply/python-sr`,
            reject_reason: null,
            created_at: hoursAgo(2)
        }),
        sarahApplied: upsertApplication({
            profile_id: profiles.sarah,
            company_name: 'BankCore',
            job_role: 'Java Backend Developer',
            core_skills: 'Java, Spring Boot, Kafka, Microservices',
            job_description: jdJava,
            resume_filename: 'sarah_bankcore_seed.docx',
            status: 'applied',
            state: 'in_progress',
            source: 'user',
            job_link_id: jobLinks.javaMid,
            match_score: null,
            generation_status: 'ready',
            applier_id: users.bob,
            job_url: `${SEED_PREFIX}/apply/java-mid`,
            reject_reason: null,
            created_at: daysAgo(1, 11)
        }),
        sarahInterview: upsertApplication({
            profile_id: profiles.sarah,
            company_name: 'HealthSync',
            job_role: 'Lead .NET Architect',
            core_skills: 'C#, .NET, Azure, Architecture',
            job_description: jdDotnet,
            resume_filename: 'sarah_healthsync_seed.docx',
            status: 'interview',
            state: 'in_progress',
            source: 'auto',
            job_link_id: jobLinks.dotnetLead,
            match_score: 0.91,
            generation_status: 'ready',
            applier_id: users.bob,
            job_url: `${SEED_PREFIX}/apply/dotnet-lead`,
            reject_reason: null,
            created_at: daysAgo(3, 14)
        }),
        marcusRejected: upsertApplication({
            profile_id: profiles.marcus,
            company_name: 'ShopAPI',
            job_role: 'Node.js Developer',
            core_skills: 'Node.js, Express, MongoDB',
            job_description: SAMPLE_JD('ShopAPI', 'Node.js Developer', 'Node, Express'),
            resume_filename: null,
            status: 'rejected',
            state: 'rejected',
            source: 'user',
            job_link_id: jobLinks.nodeFailed,
            match_score: null,
            generation_status: 'failed',
            applier_id: users.charlie,
            job_url: `${SEED_PREFIX}/apply/node-failed`,
            reject_reason: 'Role requires on-site Berlin relocation',
            created_at: daysAgo(6)
        }),
        priyaApplied: upsertApplication({
            profile_id: profiles.priya,
            company_name: 'DesignHub',
            job_role: 'Senior Frontend Engineer',
            core_skills: 'React, TypeScript, CSS, WCAG',
            job_description: jdFrontend,
            resume_filename: 'priya_designhub_seed.docx',
            status: 'applied',
            state: 'completed',
            source: 'user',
            job_link_id: jobLinks.frontendRemote,
            match_score: null,
            generation_status: 'ready',
            applier_id: users.diana,
            job_url: `${SEED_PREFIX}/apply/fe-remote`,
            reject_reason: null,
            created_at: daysAgo(2, 9)
        }),
        liamPending: upsertApplication({
            profile_id: profiles.liam,
            company_name: 'LegacyCo',
            job_role: 'Python Data Engineer',
            core_skills: 'Python, Spark, Airflow, SQL',
            job_description: SAMPLE_JD('LegacyCo', 'Python Data Engineer', 'Python, Spark'),
            resume_filename: null,
            status: 'pending',
            state: 'in_progress',
            source: 'auto',
            job_link_id: jobLinks.pythonOld,
            match_score: 0.78,
            generation_status: 'pending',
            applier_id: users.bob,
            job_url: `${SEED_PREFIX}/apply/python-old`,
            reject_reason: null,
            created_at: daysAgo(25)
        }),
        alexAutoReady: upsertApplication({
            profile_id: profiles.alex,
            company_name: 'BankCore',
            job_role: 'Java Backend Developer',
            core_skills: 'React, Node.js, JavaScript',
            job_description: jdJava,
            resume_filename: 'alex_bankcore_auto_seed.docx',
            status: 'applied',
            state: 'in_progress',
            source: 'auto',
            job_link_id: jobLinks.javaMid,
            match_score: 0.84,
            generation_status: 'ready',
            applier_id: users.alice,
            job_url: `${SEED_PREFIX}/apply/java-mid`,
            reject_reason: null,
            created_at: daysAgo(0, 15)
        }),
        marcusGolang: upsertApplication({
            profile_id: profiles.marcus,
            company_name: 'FinTech BR',
            job_role: 'Golang Payments Engineer',
            core_skills: 'Golang, gRPC, PostgreSQL, PIX',
            job_description: jdGolang,
            resume_filename: 'marcus_fintech_seed.docx',
            status: 'interview',
            state: 'in_progress',
            source: 'user',
            job_link_id: null,
            match_score: null,
            generation_status: 'ready',
            applier_id: users.charlie,
            job_url: 'https://example.com/fintech-br/golang',
            reject_reason: null,
            created_at: daysAgo(4, 16)
        }),
        priyaCancelled: upsertApplication({
            profile_id: profiles.priya,
            company_name: 'StartupXYZ',
            job_role: 'Full Stack Engineer',
            core_skills: 'React, Python, PostgreSQL',
            job_description: SAMPLE_JD('StartupXYZ', 'Full Stack Engineer', 'React, Python'),
            resume_filename: 'priya_startup_seed.docx',
            status: 'applied',
            state: 'cancelled',
            source: 'user',
            job_link_id: null,
            match_score: null,
            generation_status: 'ready',
            applier_id: users.diana,
            job_url: 'https://example.com/startupxyz',
            reject_reason: null,
            created_at: daysAgo(10)
        }),
        ethanRecent: upsertApplication({
            profile_id: profiles.alex,
            company_name: 'CloudNine',
            job_role: 'Staff Frontend Engineer',
            core_skills: 'React, GraphQL, performance, leadership',
            job_description: SAMPLE_JD('CloudNine', 'Staff Frontend Engineer', 'React, GraphQL'),
            resume_filename: 'ethan_cloudnine_seed.docx',
            status: 'pending',
            state: 'in_progress',
            source: 'user',
            job_link_id: null,
            match_score: null,
            generation_status: 'ready',
            applier_id: users.ethan,
            job_url: 'https://example.com/cloudnine',
            reject_reason: null,
            created_at: hoursAgo(5)
        })
    };
    console.log('Applications ready:', Object.keys(apps).length);

    // ── Interview requests + milestones ────────────────────────────────
    const irRequested = upsertInterviewRequest({
        application_id: apps.sarahApplied,
        status: 'requested',
        recruiter_reply: null,
        recruiter_reply_at: null,
        interview_type: null,
        scheduled_date: null,
        scheduled_time: null,
        timezone: 'America/New_York',
        interviewer_name: null,
        location: null,
        meeting_link: null,
        user_notes: 'Recruiter emailed — waiting for schedule',
        reply_channel: 'Email',
        assigned_developer_id: users.frank,
        created_by: users.bob,
        created_at: daysAgo(1)
    });
    upsertMilestone(irRequested, {
        kind: 'recruiter_reply',
        label: 'Recruiter reply',
        position: 0,
        scheduled_at: daysAgo(1),
        completed_at: null,
        notes: 'Initial outreach received',
        recruiter_message: 'Thanks for applying! We would like to schedule a phone screen.',
        reply_message: null,
        interview_link: null,
        approved: false,
        paid: false
    });

    const irScheduled = upsertInterviewRequest({
        application_id: apps.sarahInterview,
        status: 'scheduled',
        recruiter_reply: 'Video interview scheduled with hiring manager.',
        recruiter_reply_at: daysAgo(2),
        interview_type: 'Video',
        scheduled_date: '2026-09-05',
        scheduled_time: '14:00',
        timezone: 'America/New_York',
        interviewer_name: 'Jane Hiring Manager',
        location: 'Zoom',
        meeting_link: 'https://zoom.us/j/seed-scheduled-interview',
        user_notes: 'Prepare system design examples',
        reply_channel: 'Email',
        assigned_developer_id: users.iris,
        created_by: users.bob,
        created_at: daysAgo(3)
    });
    upsertMilestone(irScheduled, {
        kind: 'recruiter_reply',
        label: 'Recruiter reply',
        position: 0,
        scheduled_at: daysAgo(3),
        completed_at: daysAgo(3),
        recruiter_message: 'We loved your resume!',
        reply_message: 'Thank you — I am available next week.',
        interview_link: null,
        approved: true,
        paid: false
    });
    upsertMilestone(irScheduled, {
        kind: 'phone_screen',
        label: 'Phone screen',
        position: 1,
        scheduled_at: daysAgo(2),
        completed_at: daysAgo(2),
        notes: '45 min with recruiter',
        recruiter_message: null,
        reply_message: null,
        interview_link: 'https://zoom.us/j/seed-phone-screen',
        approved: true,
        paid: false
    });
    upsertMilestone(irScheduled, {
        kind: 'video',
        label: 'Video interview',
        position: 2,
        scheduled_at: '2026-09-05 14:00:00',
        completed_at: null,
        notes: 'HM round — system design',
        recruiter_message: null,
        reply_message: null,
        interview_link: 'https://zoom.us/j/seed-scheduled-interview',
        approved: false,
        paid: false
    });

    const irCompleted = upsertInterviewRequest({
        application_id: apps.priyaApplied,
        status: 'completed',
        recruiter_reply: 'Offer extended after panel interview.',
        recruiter_reply_at: daysAgo(1),
        interview_type: 'Panel',
        scheduled_date: '2026-08-20',
        scheduled_time: '10:00',
        timezone: 'Europe/London',
        interviewer_name: 'Panel Team',
        location: 'Remote',
        meeting_link: 'https://meet.google.com/seed-panel',
        user_notes: 'Accepted offer verbally',
        reply_channel: 'Email',
        assigned_developer_id: users.frank,
        created_by: users.diana,
        created_at: daysAgo(5)
    });
    upsertMilestone(irCompleted, {
        kind: 'recruiter_reply',
        label: 'Recruiter reply',
        position: 0,
        scheduled_at: daysAgo(5),
        completed_at: daysAgo(5),
        recruiter_message: 'Great portfolio!',
        approved: true,
        paid: false
    });
    upsertMilestone(irCompleted, {
        kind: 'technical',
        label: 'Technical interview',
        position: 1,
        scheduled_at: daysAgo(3),
        completed_at: daysAgo(3),
        notes: 'Live coding — passed',
        approved: true,
        paid: true
    });
    upsertMilestone(irCompleted, {
        kind: 'offer',
        label: 'Offer',
        position: 2,
        scheduled_at: daysAgo(1),
        completed_at: daysAgo(1),
        notes: 'Signed offer letter',
        approved: true,
        paid: false
    });

    const irCancelled = upsertInterviewRequest({
        application_id: apps.marcusRejected,
        status: 'cancelled',
        recruiter_reply: 'Position filled internally.',
        recruiter_reply_at: daysAgo(4),
        interview_type: null,
        scheduled_date: null,
        scheduled_time: null,
        timezone: 'Europe/Berlin',
        interviewer_name: null,
        location: null,
        meeting_link: null,
        user_notes: 'Withdrew after relocation requirement',
        reply_channel: 'LinkedIn',
        assigned_developer_id: null,
        created_by: users.charlie,
        created_at: daysAgo(6)
    });
    upsertMilestone(irCancelled, {
        kind: 'recruiter_reply',
        label: 'Recruiter reply',
        position: 0,
        scheduled_at: daysAgo(6),
        completed_at: daysAgo(6),
        recruiter_message: 'Are you open to relocation?',
        reply_message: 'Unfortunately not at this time.',
        approved: false,
        paid: false
    });

    const irAi = upsertInterviewRequest({
        application_id: apps.marcusGolang,
        status: 'scheduled',
        recruiter_reply: 'Please complete AI interview within 48 hours.',
        recruiter_reply_at: daysAgo(1),
        interview_type: 'AI Interview',
        scheduled_date: '2026-09-01',
        scheduled_time: '23:59',
        timezone: 'America/Sao_Paulo',
        interviewer_name: 'HireVue Bot',
        location: 'Online',
        meeting_link: 'https://hirevue.com/seed-ai-interview',
        user_notes: 'AI screener — practice behavioral questions',
        reply_channel: 'Email',
        assigned_developer_id: users.iris,
        created_by: users.charlie,
        created_at: daysAgo(2)
    });
    upsertMilestone(irAi, {
        kind: 'ai_interview',
        label: 'AI interview',
        position: 0,
        scheduled_at: daysAgo(1),
        completed_at: null,
        ai_interview_detail: 'Record 5 video responses — deadline tomorrow',
        recruiter_message: 'Complete AI interview link below.',
        interview_link: 'https://hirevue.com/seed-ai-interview',
        approved: false,
        paid: false
    });

    console.log('Interview requests + milestones ready');

    // ── Admin/caller interviews ────────────────────────────────────────
    upsertInterview({
        application_id: apps.alexPending,
        status: 'scheduled',
        scheduled_date: '2026-09-10',
        scheduled_time: '11:00',
        timezone: 'America/Chicago',
        interview_type: 'Phone',
        interviewer_name: 'Recruiter Team',
        location: 'Phone',
        meeting_link: null,
        notes: 'Initial recruiter screen for DataFlow'
    });
    upsertInterview({
        application_id: apps.sarahInterview,
        status: 'completed',
        scheduled_date: '2026-08-15',
        scheduled_time: '15:30',
        timezone: 'America/New_York',
        interview_type: 'Onsite',
        interviewer_name: 'Engineering Panel',
        location: 'Boston HQ',
        meeting_link: null,
        notes: 'Completed onsite — positive feedback'
    });

    // ── Caller assignments + profile ───────────────────────────────────
    upsertCallerAssignment(users.grace, apps.sarahApplied);
    upsertCallerAssignment(users.grace, apps.alexPending);
    upsertCallerAssignment(users.frank, apps.sarahInterview);
    upsertCallerProfile(users.grace, {
        profile_info: 'Experienced technical recruiter supporting US remote roles.',
        years_of_experience: '8',
        main_tech_stack: 'Java, Python, SaaS',
        availability: 'Mon–Sat mornings EST',
        email: 'grace.caller@example.com',
        whatsapp: '+1-555-0199'
    });
    upsertCallerProfile(users.frank, {
        profile_info: 'Developer interview coach — system design focus.',
        years_of_experience: '12',
        main_tech_stack: 'Python, React, AWS',
        availability: 'Weekday evenings',
        email: 'frank.dev@example.com',
        whatsapp: '+1-555-0188'
    });
    console.log('Caller assignments + profiles ready');

    saveDatabase();

    const counts = {
        users: getOne('SELECT COUNT(*) AS n FROM users')?.n,
        profiles: getOne('SELECT COUNT(*) AS n FROM candidate_profiles')?.n,
        job_links: getOne('SELECT COUNT(*) AS n FROM job_links')?.n,
        applications: getOne('SELECT COUNT(*) AS n FROM job_applications')?.n,
        interview_requests: getOne('SELECT COUNT(*) AS n FROM interview_requests')?.n,
        milestones: getOne('SELECT COUNT(*) AS n FROM interview_milestones')?.n,
        interviews: getOne('SELECT COUNT(*) AS n FROM interviews')?.n,
        caller_assignments: getOne('SELECT COUNT(*) AS n FROM caller_assignments')?.n
    };

    console.log('\n=== Seed complete ===\n');
    console.log('Row counts:', counts);
    console.log(`
Test accounts (password shown):
  admin / admin123          — admin
  alice / alice123          — user (Alex profile)
  bob / bob123              — user (Sarah + Liam profiles)
  charlie / charlie123      — user (Marcus profile)
  diana / diana123          — user (Priya profile)
  ethan / ethan123          — user (Alex + Marcus profiles)
  frank / dev123            — developer (interview coach)
  grace / caller123         — developer (caller assignments)
  henry / mgr123            — manager
  iris / dev2123            — developer (assigned interviews)

Seed job links use URLs starting with: ${SEED_PREFIX}
  (${BULK_JOB_LINK_COUNT} bulk rows — filter by techstack, JD status, date, availability)
Applications span statuses: pending, applied, interview, rejected
Application states: in_progress, completed, cancelled, rejected
Interview request statuses: requested, scheduled, completed, cancelled
`);
    await notifyServerReload();
}

main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
