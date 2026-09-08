const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { DB_PATH } = require('./paths');

let db = null;
let sqlFactory = null;

// Initialize database
async function initDatabase() {
  const SQL = await initSqlJs();
  sqlFactory = SQL;

  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Foreign keys: sql.js exposes REFERENCES clauses as part of
  // the table DDL but does not enforce them at runtime unless
  // PRAGMA foreign_keys = ON is set on the active connection.
  // The migration blocks below intentionally toggle FKs OFF for
  // table-rename dances (so they can recreate constraint syntax
  // atomically), but the rest of the codebase relies on the
  // routes to validate parent-row existence before INSERT —
  // see e.g. `normalizeTemplateId` in routes/admin.js. Enabling
  // FK enforcement here surfaced a stale FK in the live DB
  // (app_settings.updated_by REFERENCES "users_old" left over
  // from a previous migration crash) and started tripping
  // unrelated INSERTs, so we keep it off and rely on the route
  // layer for FK-style validation.
  //
  // If a future migration needs runtime FK enforcement, set it
  // ON locally around that one statement rather than globally.

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user', 'caller', 'manager', 'developer')),
      created_by INTEGER,
      -- Developer-profile fields. Email + Telegram are required when
      -- filling out the profile (server enforces), the rest are
      -- optional. Stored on 'users' so the data lives with the
      -- account.
      technical_skills TEXT,
      availability TEXT,
      developer_resume TEXT,
      contact_email TEXT,
      contact_whatsapp TEXT,
      contact_phone TEXT,
      contact_telegram TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS candidate_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      middle_name TEXT,
      birthdate TEXT,
      phone TEXT,
      email TEXT,
      linkedin_url TEXT,
      github_url TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      postal_code TEXT,
      salary_range TEXT,
      work_experience TEXT,
      education TEXT,
      resume_prompt TEXT,
      -- The admin's preferred resume template for this profile.
      -- NULL means "use the system default template"; otherwise the
      -- generation route passes this id through to
      -- templateService.resolveStyleSpec. FK ON DELETE SET NULL
      -- keeps the column self-healing if a custom template goes
      -- away.
      preferred_template_id INTEGER
        REFERENCES resume_templates(id) ON DELETE SET NULL,
      -- Disambiguates which template table the id points at.
      -- 'admin' = resume_templates (admin-uploaded DOCX);
      -- 'user'  = user_resume_templates (drag-drop).
      -- Defaults to 'admin' for legacy rows so existing
      -- assignments keep working.
      preferred_template_kind TEXT DEFAULT 'admin',
      -- Coarse region flag the admin sets per candidate (US,
      -- Brazil, EU, Asia, Other). Used downstream by the resume
      -- generator / job-link filter to scope which jobs a
      -- candidate is shown. Default 'US' so legacy rows have a
      -- safe value.
      location_flag TEXT DEFAULT 'US',
      -- Fixed EEO / eligibility answers for autofill (never AI-generated).
      gender TEXT,
      work_authorization TEXT,
      requires_sponsorship TEXT,
      disability_status TEXT,
      veteran_status TEXT,
      race_ethnicity TEXT,
      -- Extra fixed autofill fields (Simplify / Jobright-style logistics + links).
      website_url TEXT,
      portfolio_url TEXT,
      preferred_name TEXT,
      over_18 TEXT,
      hispanic_latino TEXT,
      willing_to_relocate TEXT,
      willing_to_travel TEXT,
      earliest_start_date TEXT,
      notice_period TEXT,
      how_heard TEXT,
      years_of_experience TEXT,
      education_level TEXT,
      security_clearance TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_profile_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      profile_id INTEGER NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE,
      UNIQUE(user_id, profile_id)
    )
  `);

  // Migration: per-user default among assigned profiles. The first
  // assignment for each user becomes default when upgrading older DBs.
  try {
    const upaInfo = db.exec('PRAGMA table_info(user_profile_assignments)');
    const upaColumns = upaInfo[0]?.values.map((row) => row[1]) || [];
    if (!upaColumns.includes('is_default')) {
      db.run('ALTER TABLE user_profile_assignments ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
      console.log('Added is_default column to user_profile_assignments table');
    }
    // Backfill: users with assignments but no default get their earliest
    // assignment marked default.
    db.run(`
      UPDATE user_profile_assignments
      SET is_default = 1
      WHERE id IN (
        SELECT id FROM (
          SELECT MIN(id) AS id
          FROM user_profile_assignments
          WHERE user_id IN (
            SELECT user_id FROM user_profile_assignments
            GROUP BY user_id
            HAVING COALESCE(SUM(is_default), 0) = 0
          )
          GROUP BY user_id
        )
      )
    `);
  } catch (error) {
    console.warn('user_profile_assignments is_default migration skipped:', error?.message || error);
  }

  // Many-to-many: a candidate_profile can be flagged with several
  // techstacks (Python, C#, Java, Golang, ...). Same closed enum
  // we use for job_links.techstack so the two stay in sync.
  //
  // The composite PK on (profile_id, techstack) is what makes
  // "several tech stacks per profile" natural — a row per
  // (profile, tech) — and the FK ON DELETE CASCADE mirrors the
  // user_profile_assignments cleanup: deleting a profile drops
  // all its techstack rows automatically.
  db.run(`
    CREATE TABLE IF NOT EXISTS profile_techstacks (
      profile_id INTEGER NOT NULL,
      techstack TEXT NOT NULL
        CHECK(techstack IN ('python', 'java', 'dotnet', 'golang', 'nodejs', 'frontend')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (profile_id, techstack),
      FOREIGN KEY (profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_profile_techstacks_techstack ON profile_techstacks(techstack)`);

  // Migration: Add location_flag column to candidate_profiles +
  // job_links (idempotent — runs every boot). The column is
  // already declared in the CREATE TABLE statements above so
  // fresh DBs get it for free; this block handles upgrades
  // from older database files.
  try {
    const cpInfo = db.exec("PRAGMA table_info(candidate_profiles)");
    const cpCols = cpInfo[0]?.values.map((r) => r[1]) || [];
    if (!cpCols.includes('location_flag')) {
      db.run(
        "ALTER TABLE candidate_profiles ADD COLUMN location_flag TEXT DEFAULT 'US'"
      );
      console.log('Added location_flag column to candidate_profiles table');
      saveDatabase();
    }
  } catch (e) {
    console.warn('location_flag migration (candidate_profiles) skipped:', e.message);
  }
  try {
    const jlInfo = db.exec("PRAGMA table_info(job_links)");
    const jlCols = jlInfo[0]?.values.map((r) => r[1]) || [];
    if (!jlCols.includes('location_flag')) {
      db.run(
        "ALTER TABLE job_links ADD COLUMN location_flag TEXT DEFAULT 'US'"
      );
      console.log('Added location_flag column to job_links table');
      saveDatabase();
    }
  } catch (e) {
    console.warn('location_flag migration (job_links) skipped:', e.message);
  }

  // Product default: every profile + job link is US. One-shot normalize
  // when any non-US rows remain (avoids rewriting the DB every boot).
  try {
    const badProfiles = db.exec(
      `SELECT COUNT(*) AS n FROM candidate_profiles
        WHERE location_flag IS NULL OR TRIM(COALESCE(location_flag,'')) = '' OR location_flag <> 'US'`
    );
    const badLinks = db.exec(
      `SELECT COUNT(*) AS n FROM job_links
        WHERE location_flag IS NULL OR TRIM(COALESCE(location_flag,'')) = '' OR location_flag <> 'US'`
    );
    const nProfiles = badProfiles[0]?.values?.[0]?.[0] || 0;
    const nLinks = badLinks[0]?.values?.[0]?.[0] || 0;
    if (nProfiles > 0 || nLinks > 0) {
      if (nProfiles > 0) {
        db.run(
          `UPDATE candidate_profiles
              SET location_flag = 'US'
            WHERE location_flag IS NULL
               OR TRIM(COALESCE(location_flag,'')) = ''
               OR location_flag <> 'US'`
        );
      }
      if (nLinks > 0) {
        db.run(
          `UPDATE job_links
              SET location_flag = 'US'
            WHERE location_flag IS NULL
               OR TRIM(COALESCE(location_flag,'')) = ''
               OR location_flag <> 'US'`
        );
      }
      saveDatabase();
      console.log(`[boot] location_flag → US (profiles=${nProfiles}, job_links=${nLinks})`);
    }
  } catch (e) {
    console.warn('location_flag normalize-to-US skipped:', e.message);
  }

  // Migration: job_applications gains source / job_link_id /
  // match_score / generation_status / generation_error columns so
  // the new auto-apply cron can track which applications it
  // generated. Legacy rows get the safe defaults: source='user',
  // generation_status='ready' (their resume_filename already
  // exists, so they're downloadable as-is).
  try {
    const jaInfo = db.exec("PRAGMA table_info(job_applications)");
    const jaCols = jaInfo[0]?.values.map((r) => r[1]) || [];
    const alter = (sql) => { try { db.run(sql); } catch (_) { /* already added */ } };
    if (!jaCols.includes('source')) {
      alter("ALTER TABLE job_applications ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
      console.log('Added source column to job_applications');
    }
    if (!jaCols.includes('job_link_id')) {
      alter("ALTER TABLE job_applications ADD COLUMN job_link_id INTEGER");
    }
    if (!jaCols.includes('match_score')) {
      alter("ALTER TABLE job_applications ADD COLUMN match_score REAL");
    }
    if (!jaCols.includes('generation_status')) {
      // Default 'ready' for legacy rows so the UI shows them as
      // downloadable. New cron-generated rows start at 'pending'
      // and walk pending → generating → ready/failed.
      alter("ALTER TABLE job_applications ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'ready'");
      console.log('Added generation_status column to job_applications');
    }
    if (!jaCols.includes('generation_error')) {
      alter("ALTER TABLE job_applications ADD COLUMN generation_error TEXT");
    }
    if (!jaCols.includes('generation_ms')) {
      // Wall-clock ms for the last successful CV generate (shown on Job Links).
      alter("ALTER TABLE job_applications ADD COLUMN generation_ms INTEGER");
      console.log('Added generation_ms column to job_applications');
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_job_applications_job_link ON job_applications(job_link_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_job_applications_source ON job_applications(source)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_job_applications_gen_status ON job_applications(generation_status)`);
    saveDatabase();
  } catch (e) {
    console.warn('job_applications cron columns migration skipped:', e.message);
  }

  // Migration: clean up orphan job_applications rows whose
  // job_link_id or profile_id points at a deleted parent. The
  // worker used to log "missing entity" forever on these rows;
  // now we garbage-collect them at boot. Safe to run repeatedly
  // — only deletes rows that no longer have a parent.
  try {
    const orphanJa = db.exec(`
      SELECT COUNT(*) FROM job_applications ja
       WHERE (ja.job_link_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM job_links jl WHERE jl.id = ja.job_link_id))
          OR NOT EXISTS (SELECT 1 FROM candidate_profiles cp WHERE cp.id = ja.profile_id)
    `);
    const orphanCount = orphanJa[0]?.values[0]?.[0] || 0;
    if (orphanCount > 0) {
      db.exec(`
        DELETE FROM job_applications
         WHERE (job_link_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM job_links jl WHERE jl.id = job_link_id))
            OR NOT EXISTS (SELECT 1 FROM candidate_profiles cp WHERE cp.id = profile_id)
      `);
      console.log(`[migration] cleaned up ${orphanCount} orphan job_applications row(s)`);
      saveDatabase();
    }
  } catch (e) {
    console.warn('orphan cleanup migration skipped:', e.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS job_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      company_name TEXT NOT NULL,
      job_role TEXT,
      core_skills TEXT,
      job_description TEXT NOT NULL,
      resume_filename TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'applied', 'rejected', 'interview')),
      state  TEXT NOT NULL DEFAULT 'in_progress'
        CHECK(state IN ('in_progress', 'completed', 'cancelled', 'rejected')),
      -- 'user' = generated by a logged-in user from /user/generate
      -- 'auto' = generated by the background autoApply cron from a
      --          job_links row. The new detail page distinguishes
      --          the two so admins can see which rows came from the
      --          cron vs the manual flow.
      source TEXT NOT NULL DEFAULT 'user'
        CHECK(source IN ('user', 'auto')),
      -- Back-pointer to job_links for cron-generated rows. Nullable
      -- so legacy / user-generated rows keep working. FK with
      -- ON DELETE CASCADE so deleting a job_link automatically
      -- removes its dependent job_applications rows — this
      -- prevents the "missing entity" orphan state that the
      -- worker used to log forever.
      job_link_id INTEGER REFERENCES job_links(id) ON DELETE CASCADE,
      -- Score the matcher computed when the cron picked this
      -- profile for this job (0..1). Higher = better fit. Stored
      -- so the detail page can sort / filter cards without
      -- recomputing. NULL for user-generated rows.
      match_score REAL,
      -- generation_status lets the UI distinguish "resume ready"
      -- from "AI still working" / "failed". One of:
      --   pending   - row created, resume not yet generated
      --   generating - cron is currently running AI generation
      --   ready     - resume_filename is set, downloadable
      --   failed    - generation failed; see generation_error
      generation_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(generation_status IN ('pending', 'generating', 'ready', 'failed')),
      generation_error TEXT,
      -- Wall-clock ms for last successful CV generate (Job Links UI).
      generation_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_job_applications_job_link ON job_applications(job_link_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_applications_source ON job_applications(source)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_applications_gen_status ON job_applications(generation_status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS caller_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER NOT NULL,
      application_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (application_id) REFERENCES job_applications(id) ON DELETE CASCADE,
      UNIQUE(caller_id, application_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user', 'caller', 'manager', 'developer')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, role)
    )
  `);

  // App-wide settings (singleton row, id=1). Holds AI model selection, etc.
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ai_provider TEXT NOT NULL DEFAULT 'deepseek' CHECK(ai_provider IN ('minimax', 'deepseek', 'groq')),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Resume templates uploaded by an admin. Each template is a DOCX file
  // whose layout / styles are parsed once on upload and persisted as a
  // style-spec JSON in 'style_spec'. The 'is_default' flag marks the
  // built-in default template (always id=1, never deletable) so users
  // always have something to pick even if every admin-uploaded template
  // is removed.
  db.run(`
    CREATE TABLE IF NOT EXISTS resume_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      filename TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      -- Parsed layout/style spec (JSON). Consumed by resumeService at
      -- generation time to drive both DOCX (via the docx npm package) and
      -- PDF (via inline style on the rendered HTML).
      style_spec TEXT NOT NULL,
      -- Extracted candidate data (name / contact / experience / education)
      -- pulled from the DOCX by templateExtractor. JSON blob. Nullable
      -- because the extractor is best-effort and may produce nothing
      -- (e.g. for a template whose content is just placeholder text).
      extracted_data TEXT,
      -- When the admin clicks "Apply" the extracted data is written to a
      -- real candidate_profiles row. We store the link so the admin can
      -- see which profile a given template produced and so we can re-open
      -- / re-edit the template's effect on that profile.
      candidate_profile_id INTEGER,
      is_default INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (candidate_profile_id) REFERENCES candidate_profiles(id) ON DELETE SET NULL
    )
  `);

  // Backfill migrations for `resume_templates` so existing deployments
  // pick up the new columns without a destructive recreate.
  try {
    const tInfo = db.exec("PRAGMA table_info(resume_templates)");
    const tCols = tInfo[0]?.values.map((r) => r[1]) || [];
    if (!tCols.includes('extracted_data')) {
      db.run("ALTER TABLE resume_templates ADD COLUMN extracted_data TEXT");
      console.log('Added extracted_data column to resume_templates table');
    }
    if (!tCols.includes('candidate_profile_id')) {
      db.run("ALTER TABLE resume_templates ADD COLUMN candidate_profile_id INTEGER");
      console.log('Added candidate_profile_id column to resume_templates table');
    }
  } catch (migErr) {
    console.warn('resume_templates migration check failed (non-fatal):', migErr.message);
  }

  // -------------------------------------------------------------------------
  // user_resume_templates - per-user, drag-drop built resume templates
  // -------------------------------------------------------------------------
  // Stores user-authored "builder" templates. Each row carries a JSON
  // `style_spec` describing the layout: which blocks are enabled and in
  // what order, what fields live in the contact block and their order,
  // per-element font sizes and alignments, and whether the experience
  // rows use a 2-column job-title-left / dates-right layout.
  //
  // The user_resume_templates table is keyed by `user_id` so every
  // regular user has their own library. The renderer (templateRenderer)
  // and the resume-pipeline (resumeService.generateResume) already
  // accept any style_spec JSON shape, so this is purely about persisting
  // user-built configs alongside admin-uploaded DOCX templates.
  db.run(`
    CREATE TABLE IF NOT EXISTS user_resume_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'builder'
        CHECK(kind IN ('builder', 'clone')),
      style_spec TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      is_editable INTEGER NOT NULL DEFAULT 1,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, name)
    )
  `);

  // -------------------------------------------------------------------------
  // job_links - admin-managed job-listing directory
  // -------------------------------------------------------------------------
  // Each row represents a job the team is tracking for applying. Admins
  // add rows via the Job Links admin page; the row carries the canonical
  // techstack (one of a fixed enum), an optional LinkedIn URL whose
  // job-description is fetched automatically by a cron, and the
  // job-apply URL (e.g. a Greenhouse / Lever / Workday link) the user
  // will actually submit to.
  //
  // The cron (services/jobLinkScraper.js) processes one row per 500 ms
  // (= 2 jobs / sec) to stay polite to LinkedIn, populating
  // `job_description`, `company_name`, `position_title`, `location`,
  // and `last_fetched_at`. `fetch_status` records whether the last
  // scrape succeeded; `fetch_error` holds the message on failure so
  // admins can see *why* a row never got a description.
  db.run(`
    CREATE TABLE IF NOT EXISTS job_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- Techstack is a closed enum so the admin filter / dropdown stay
      -- consistent with the column values.
      techstack TEXT NOT NULL
        CHECK(techstack IN ('python', 'java', 'dotnet', 'golang', 'nodejs', 'frontend')),
      -- The URL the cron scrapes. Not LinkedIn-specific — this column
      -- holds whatever ATS URL the user pasted (LinkedIn, Greenhouse,
      -- Lever, Ashby, iCIMS, JobVite, Workday, SuccessFactors,
      -- Paycom, Rippling, ApplyToJob, ...). UNIQUE because we don't
      -- want two rows for the same posting. Not NOT NULL because
      -- early-version schemas may have left it empty.
      source_url TEXT,
      job_apply_url TEXT NOT NULL,
      -- Description is fetched from the source URL by the cron.
      -- Optional on create — many users add a row before the
      -- description has been pulled in.
      job_description TEXT,
      company_name TEXT,
      position_title TEXT,
      location TEXT,
      -- Coarse region flag (US, Brazil, EU, Asia, Other) so the
      -- admin can scope job lists and resume generation per
      -- region. Default 'US' for legacy rows. CHECK-constrained
      -- at the DB level; route-layer validation mirrors this.
      location_flag TEXT DEFAULT 'US'
        CHECK(location_flag IN ('US', 'Brazil', 'EU', 'Asia', 'Other')),
      -- Availability flag — the admin marks a row unavailable when the
      -- job has closed or been filled. The filter dropdown / table pill
      -- are driven off this column.
      is_available INTEGER NOT NULL DEFAULT 1,
      -- Clearance level detected from the job description (e.g.
      -- "TS/SCI", "Secret", "Public Trust"). NULL means no clearance
      -- language was found. When non-NULL, the row is also flipped to
      -- is_available=0 so the auto-apply pipeline doesn't try to apply
      -- to a role that requires a background check the candidate
      -- pool doesn't carry.
      clearance_required TEXT,
      -- Free-text admin/team notes (not scraped; never overwritten by cron).
      comment TEXT,
      -- Cron bookkeeping. fetch_status is one of:
      --   pending   - never been fetched
      --   fetching  - a worker is currently scraping it
      --   success   - last scrape succeeded
      --   failed    - last scrape failed (see fetch_error). Will be
      --               retried after next_retry_at.
      --   dead      - too many consecutive failures. Terminal —
      --               requires human intervention (delete row, edit
      --               URL, or set fetch_status back to 'pending' to
      --               re-queue).
      fetch_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(fetch_status IN ('pending', 'fetching', 'success', 'failed', 'dead')),
      fetch_error TEXT,
      last_fetched_at DATETIME,
      -- After a failure, the cron waits until next_retry_at before
      -- retrying. NULL means "ready now" (used for pending + success).
      -- Each failure doubles the wait (5m, 10m, 20m, 40m, ...) until
      -- consecutive_failures reaches MAX_FAILURES and the row goes
      -- dead.
      next_retry_at DATETIME,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_links_techstack ON job_links(techstack)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_links_status ON job_links(fetch_status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_links_available ON job_links(is_available)`);
  // The next_retry_at index is created AFTER the migration block
  // below — creating it here would fail on a database that hasn't
  // been migrated yet (the column wouldn't exist).

  // Backfill columns for existing databases that pre-date the
  // backoff + dead-status additions. SQLite doesn't allow modifying
  // CHECK constraints in place; we tolerate the legacy CHECK by
  // relying on the application's `fetch_status` writes (which never
  // emit 'dead' from existing code paths until we wire it through).
  try {
    const linkInfo = db.exec("PRAGMA table_info(job_links)");
    const linkCols = linkInfo[0]?.values.map((r) => r[1]) || [];
    const ensureLink = (name, ddl) => {
      if (!linkCols.includes(name)) {
        db.run(`ALTER TABLE job_links ADD COLUMN ${name} ${ddl}`);
        console.log(`Added ${name} column to job_links table`);
      }
    };
    ensureLink('next_retry_at', 'DATETIME');
    ensureLink('consecutive_failures', 'INTEGER NOT NULL DEFAULT 0');
    // Clearance detector — when the cron scrapes a description that
    // mentions security clearance (TS/SCI, Secret, Public Trust,
    // etc.) it flips is_available=0 and stores the label here so the
    // admin can see why a row was auto-disabled. NULL means no
    // clearance language was detected.
    ensureLink('clearance_required', 'TEXT');
    // Free-text admin/team notes on a job link (not scraped).
    ensureLink('comment', 'TEXT');
    // The very first iteration of this migration dropped
    // job_apply_url from the rebuild. Restore it for any DB that
    // went through that broken pass. We use the same default the
    // main CREATE TABLE uses ('') so legacy rows still satisfy
    // NOT NULL after the column is added.
    if (!linkCols.includes('job_apply_url')) {
      try {
        db.run('ALTER TABLE job_links ADD COLUMN job_apply_url TEXT NOT NULL DEFAULT \'\'');
        console.log('Restored missing job_apply_url column on job_links');
      } catch (addErr) {
        console.warn('Failed to restore job_apply_url:', addErr.message);
      }
    }

    // Rename `linkedin_url` → `source_url` for databases that
    // pre-date the rename. The new column name reflects that the
    // URL can come from any supported ATS, not just LinkedIn.
    // We use ALTER TABLE RENAME COLUMN (SQLite 3.25+); for older
    // SQLite we fall back to add + copy + drop.
    if (linkCols.includes('linkedin_url') && !linkCols.includes('source_url')) {
      try {
        db.run('ALTER TABLE job_links RENAME COLUMN linkedin_url TO source_url');
        console.log('Renamed linkedin_url column to source_url');
      } catch (renameErr) {
        // Old SQLite without RENAME COLUMN: do add+copy+drop dance.
        console.warn('ALTER RENAME COLUMN failed, falling back:', renameErr.message);
        try {
          db.run('ALTER TABLE job_links ADD COLUMN source_url TEXT');
          db.run('UPDATE job_links SET source_url = linkedin_url');
          // linkedin_url column stays for now; it's no longer used by
          // the cron, the route, or the API.
          console.log('Copied linkedin_url → source_url (legacy fallback)');
        } catch (fallbackErr) {
          console.warn('source_url migration fallback failed:', fallbackErr.message);
        }
      }
    }

    // Rebuild the CHECK constraint if the legacy schema didn't yet
    // include 'dead' in the fetch_status enum. SQLite can't ALTER
    // CHECK constraints in place, so we copy the table aside, drop
    // the original, and re-create with the new CHECK.
    const linkSqlRows = db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='job_links'"
    );
    const linkSql = linkSqlRows[0]?.values[0]?.[0] || '';
    if (linkSql && !linkSql.includes("'dead'")) {
      console.log(
        'Rebuilding job_links to refresh fetch_status CHECK (adding "dead")'
      );
      db.run('PRAGMA foreign_keys=OFF');
      try {
        db.run('BEGIN');
        db.run(
          `CREATE TABLE job_links_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            techstack TEXT NOT NULL,
            source_url TEXT,
            job_apply_url TEXT NOT NULL,
            job_description TEXT,
            company_name TEXT,
            position_title TEXT,
            location TEXT,
            is_available INTEGER NOT NULL DEFAULT 1,
            fetch_status TEXT NOT NULL DEFAULT 'pending'
              CHECK(fetch_status IN ('pending', 'fetching', 'success', 'failed', 'dead')),
            fetch_error TEXT,
            last_fetched_at DATETIME,
            next_retry_at DATETIME,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
          )`
        );
        // Copy across, coercing legacy NULLs into the new defaults.
        // We pull `source_url` from either the new column or the
        // legacy `linkedin_url` so the rename is preserved across
        // a CHECK rebuild. `linkedin_job_id` is intentionally dropped
        // — it's not meaningful for the multi-ATS world we live in
        // now.
        db.run(
          `INSERT INTO job_links_new
            (id, techstack, source_url, job_apply_url, job_description,
             company_name, position_title, location, is_available,
             fetch_status, fetch_error, last_fetched_at,
             next_retry_at, consecutive_failures, created_by,
             created_at, updated_at)
           SELECT
            id, techstack,
            COALESCE(source_url, linkedin_url) AS source_url,
            job_apply_url, job_description,
            company_name, position_title, location, is_available,
            fetch_status, fetch_error, last_fetched_at,
            next_retry_at,
            COALESCE(consecutive_failures, 0) AS consecutive_failures,
            created_by, created_at, updated_at
           FROM job_links`
        );
        db.run('DROP TABLE job_links');
        db.run('ALTER TABLE job_links_new RENAME TO job_links');
        db.run('COMMIT');
        console.log('job_links CHECK constraint rebuilt');
        // Persist immediately so the rebuilt CHECK + new columns
        // survive the next restart, otherwise we'd re-run the rebuild
        // every boot.
        saveDatabase();
      } catch (rebuildErr) {
        db.run('ROLLBACK');
        console.warn(
          'job_links CHECK rebuild failed (non-fatal):',
          rebuildErr.message
        );
      }
      db.run('PRAGMA foreign_keys=ON');
    }

    // Follow-up: ensure `clearance_required` + `location_flag` exist
    // for databases that finished the CHECK rebuild before those
    // columns were introduced. The CHECK rebuild above intentionally
    // omits them so the rebuild stays compatible with very old
    // schemas; we add them via separate ALTERs afterwards so the
    // uptime impact is just two cheap migrations on legacy DBs.
    const linkInfo2 = db.exec("PRAGMA table_info(job_links)");
    const linkCols2 = linkInfo2[0]?.values.map((r) => r[1]) || [];
    if (!linkCols2.includes('clearance_required')) {
      try {
        db.run('ALTER TABLE job_links ADD COLUMN clearance_required TEXT');
        console.log('Added clearance_required column to job_links');
        saveDatabase();
      } catch (err) {
        console.warn('clearance_required migration failed:', err.message);
      }
    }
    if (!linkCols2.includes('location_flag')) {
      try {
        db.run("ALTER TABLE job_links ADD COLUMN location_flag TEXT DEFAULT 'US'");
        console.log('Added location_flag column to job_links');
        saveDatabase();
      } catch (err) {
        console.warn('location_flag migration failed:', err.message);
      }
    }

    // -------------------------------------------------------------------------
    // Drop `NOT NULL UNIQUE` on `source_url`
    // -------------------------------------------------------------------------
    // An earlier (pre-this-file) schema shipped with
    //   source_url TEXT NOT NULL UNIQUE
    // which combined with the route's `source || null` fallback to
    // make every "add a row without a source URL" hit a NOT NULL
    // failure. The route's catch-and-translate path then mapped
    // that to a misleading 409 "URL already exists" message. The
    // canonical schema has `source_url TEXT` (nullable) and the
    // dedup check is now a clean pre-INSERT in the route, so we
    // just relax the column here. Rebuild via copy/drop/rename
    // because SQLite can't ALTER COLUMN NULLABILITY in place.
    //
    // Before the rebuild we de-duplicate any existing rows that
    // share a non-empty source_url (keep the lowest id) so the new
    // unique index doesn't conflict during the rebuild.
    const linkSqlSourceRow = db.exec(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='job_links'"
    );
    const linkSqlCurrent = linkSqlSourceRow[0]?.values[0]?.[0] || '';
    if (linkSqlCurrent && /source_url\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(linkSqlCurrent)) {
      console.log('Relaxing job_links.source_url: drop NOT NULL UNIQUE (route now dedupes)');
      try {
        // De-duplicate any rows with the same non-empty source_url
        // BEFORE rebuilding — the new unique index would otherwise
        // blow up the COPY. We keep the lowest id of each group.
        const dupIds = db.exec(
          `SELECT id FROM job_links
             WHERE source_url IS NOT NULL AND source_url <> ''
               AND id NOT IN (
                 SELECT MIN(id) FROM job_links
                  WHERE source_url IS NOT NULL AND source_url <> ''
                  GROUP BY source_url
               )`
        );
        const dupRows = dupIds[0]?.values || [];
        if (dupRows.length > 0) {
          const ids = dupRows.map((r) => r[0]);
          console.log(`Removing ${ids.length} duplicate-by-source_url rows (older copies) before rebuild`);
          db.run(`DELETE FROM job_links WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        }

        db.run('PRAGMA foreign_keys=OFF');
        db.run('BEGIN');
        db.run(
          `CREATE TABLE job_links_source_relaxed (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            techstack TEXT NOT NULL,
            source_url TEXT,
            job_apply_url TEXT NOT NULL DEFAULT '',
            job_description TEXT,
            company_name TEXT,
            position_title TEXT,
            location TEXT,
            is_available INTEGER NOT NULL DEFAULT 1,
            fetch_status TEXT NOT NULL DEFAULT 'pending'
              CHECK(fetch_status IN ('pending', 'fetching', 'success', 'failed', 'dead')),
            fetch_error TEXT,
            last_fetched_at DATETIME,
            next_retry_at DATETIME,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
          )`
        );
        db.run(
          `INSERT INTO job_links_source_relaxed
            (id, techstack, source_url, job_apply_url, job_description,
             company_name, position_title, location, is_available,
             fetch_status, fetch_error, last_fetched_at,
             next_retry_at, consecutive_failures, created_by,
             created_at, updated_at)
           SELECT
            id, techstack, source_url, job_apply_url, job_description,
            company_name, position_title, location, is_available,
            fetch_status, fetch_error, last_fetched_at,
            next_retry_at, consecutive_failures, created_by,
            created_at, updated_at
           FROM job_links`
        );
        db.run('DROP TABLE job_links');
        db.run('ALTER TABLE job_links_source_relaxed RENAME TO job_links');
        db.run('COMMIT');
        console.log('job_links.source_url NOT NULL UNIQUE dropped');
        saveDatabase();
      } catch (relaxErr) {
        db.run('ROLLBACK');
        console.warn('job_links source_url relax failed (non-fatal):', relaxErr.message);
      }
      db.run('PRAGMA foreign_keys=ON');
    }
  } catch (migErr) {
    console.warn('job_links backfill migration failed (non-fatal):', migErr.message);
  }
  // Index on next_retry_at — created here (after the backfill) so it
  // works on a fresh DB and on a freshly-migrated one.
  db.run(`CREATE INDEX IF NOT EXISTS idx_job_links_next_retry ON job_links(next_retry_at)`);

  // Per-application interview-request record. Created the moment a user
  // captures a recruiter reply OR a new interview is scheduled. Carries
  // its own lifecycle status independent of job_applications.status and
  // the existing `interviews` (admin/caller-scheduled) table.
  //
  // Status lifecycle:
  //   requested → scheduled → completed
  //                       ↘ cancelled
  db.run(`
    CREATE TABLE IF NOT EXISTS interview_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'requested'
        CHECK(status IN ('requested', 'scheduled', 'completed', 'cancelled')),
      recruiter_reply TEXT,
      recruiter_reply_at DATETIME,
      -- The user-captured interview detail (date/time/type/interviewer/etc.)
      -- merged into the row when the request moves to 'scheduled'.
      interview_type TEXT,
      scheduled_date TEXT,
      scheduled_time TEXT,
      timezone TEXT,
      interviewer_name TEXT,
      location TEXT,
      meeting_link TEXT,
      user_notes TEXT,
      -- How the recruiter got back to the user (e.g. "Video", "Phone",
      -- "AI interview", "Email", "Text"). This is distinct from
      -- interview_type, which describes the upcoming interview mode.
      reply_channel TEXT,
      -- When the user submitted the request (defaults to now on first write).
      -- Stored as ISO-8601 string from <input type="datetime-local">.
      requested_time TEXT,
      -- When the request expires — the user chooses this so the admin can
      -- ignore stale requests after this point.
      expire_time TEXT,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES job_applications(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Admin/caller-entered interview details (one row per scheduled interview).
  // Contains the scheduling info that lives alongside the interview_requests record.
  db.run(`
    CREATE TABLE IF NOT EXISTS interviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK(status IN ('scheduled', 'completed', 'cancelled')),
      scheduled_date TEXT,
      scheduled_time TEXT,
      timezone TEXT,
      interview_type TEXT,
      interviewer_name TEXT,
      location TEXT,
      meeting_link TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (application_id) REFERENCES job_applications(id) ON DELETE CASCADE
    )
  `);

  // Caller-entered profile info (one row per caller). Lightweight text
  // fields so callers can hand-curate a short blurb they want associated
  // with their outreach.
  db.run(`
    CREATE TABLE IF NOT EXISTS caller_profile_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id INTEGER NOT NULL UNIQUE,
      profile_info TEXT,
      years_of_experience TEXT,
      main_tech_stack TEXT,
      availability TEXT,
      availability_this_week TEXT,
      location TEXT,
      -- Contact channels (free-form text — user is responsible for the
      -- format; we just trim and store)
      email TEXT,
      whatsapp TEXT,
      telegram TEXT,
      -- Filename (relative to server/resumes) of the caller's uploaded
      -- resume. NULL when no resume is attached.
      resume_filename TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Per-milestone progression for an interview-request. Users add these
  // step-by-step (e.g. "AI interview" → "Phone screen" → "Video" → "Onsite")
  // and mark each one completed. The progress bar is driven by the
  // completed_at ratio. When the parent request is cancelled or completed
  // the list is shown as a "final" trail.
  db.run(`
    CREATE TABLE IF NOT EXISTS interview_milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      interview_request_id INTEGER NOT NULL,
      -- One of: 'ai_interview', 'video', 'phone_screen', 'onsite',
      -- 'offer', 'other', 'reply_received'. Kept as TEXT (not enforced
      -- CHECK) so we can extend without a migration.
      kind TEXT NOT NULL DEFAULT 'other',
      label TEXT,
      scheduled_at DATETIME,
      completed_at DATETIME,
      notes TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      -- Per-milestone contextual fields. The legacy recruiter_reply /
      -- meeting_link / user_notes on the parent interview_requests
      -- row remain for history; new detail lives here so each step can
      -- have its own artefact.
      --
      --   recruiter_message  : the message the recruiter sent that
      --                        triggered THIS milestone.
      --   reply_message      : the user's reply to that message at this
      --                        step (free-form, no DB validation).
      --   interview_link     : a URL the recruiter shared at this
      --                        step (Zoom / Teams / HackerRank / etc.).
      --   ai_interview_detail: free-form notes specific to AI-driven
      --                        interviews (question asked, score, etc.)
      --                        — only used when kind='ai_interview'.
      recruiter_message TEXT,
      reply_message TEXT,
      interview_link TEXT,
      ai_interview_detail TEXT,
      -- Length of the interview in MINUTES (e.g. 30, 45, 60). Captured
      -- at completion time so the audit trail records how long the
      -- step actually took. Optional — only relevant for kinds that
      -- represent a real meeting (phone_screen, video, technical,
      -- hiring_manager_interview, panel_interview, ai_interview).
      duration_minutes INTEGER,
      -- Approval + payment workflow. Admins approve a completed
      -- milestone once the interview has been verified, and mark it
      -- paid once the invoice is settled. Both flags are non-terminal
      -- and stored alongside the actor + timestamp for audit.
      approved INTEGER NOT NULL DEFAULT 0,
      approved_by INTEGER,
      approved_at DATETIME,
      paid INTEGER NOT NULL DEFAULT 0,
      paid_by INTEGER,
      paid_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (interview_request_id) REFERENCES interview_requests(id) ON DELETE CASCADE
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_interview_milestones_request ON interview_milestones(interview_request_id, position)`);

  // Ensure the singleton row exists
  db.run(`INSERT OR IGNORE INTO app_settings (id, ai_provider) VALUES (1, 'minimax')`);

  // Migration: dual MiniMax API keys (paste in admin Settings) + active slot.
  try {
    const asInfo = db.exec('PRAGMA table_info(app_settings)');
    const asCols = asInfo[0]?.values.map((row) => row[1]) || [];
    if (!asCols.includes('minimax_key_slot')) {
      db.run('ALTER TABLE app_settings ADD COLUMN minimax_key_slot INTEGER NOT NULL DEFAULT 1');
      console.log('Added minimax_key_slot column to app_settings');
    }
    if (!asCols.includes('minimax_api_key_1')) {
      db.run('ALTER TABLE app_settings ADD COLUMN minimax_api_key_1 TEXT');
      console.log('Added minimax_api_key_1 column to app_settings');
    }
    if (!asCols.includes('minimax_api_key_2')) {
      db.run('ALTER TABLE app_settings ADD COLUMN minimax_api_key_2 TEXT');
      console.log('Added minimax_api_key_2 column to app_settings');
    }
    // Local OpenAI-compatible LLM for autofill / bidder answers (Ollama, LM Studio, etc.)
    if (!asCols.includes('local_llm_enabled')) {
      db.run('ALTER TABLE app_settings ADD COLUMN local_llm_enabled INTEGER NOT NULL DEFAULT 0');
      console.log('Added local_llm_enabled column to app_settings');
    }
    if (!asCols.includes('local_llm_base_url')) {
      db.run("ALTER TABLE app_settings ADD COLUMN local_llm_base_url TEXT DEFAULT 'http://127.0.0.1:11434/v1'");
      console.log('Added local_llm_base_url column to app_settings');
    }
    if (!asCols.includes('local_llm_model')) {
      db.run("ALTER TABLE app_settings ADD COLUMN local_llm_model TEXT DEFAULT 'llama3.2'");
      console.log('Added local_llm_model column to app_settings');
    }
    if (!asCols.includes('local_llm_api_key')) {
      db.run('ALTER TABLE app_settings ADD COLUMN local_llm_api_key TEXT');
      console.log('Added local_llm_api_key column to app_settings');
    }
    if (!asCols.includes('groq_api_keys')) {
      db.run('ALTER TABLE app_settings ADD COLUMN groq_api_keys TEXT');
      console.log('Added groq_api_keys column to app_settings');
    }
    if (!asCols.includes('groq_key_slot')) {
      db.run('ALTER TABLE app_settings ADD COLUMN groq_key_slot INTEGER NOT NULL DEFAULT 1');
      console.log('Added groq_key_slot column to app_settings');
    }
    if (!asCols.includes('deepseek_api_key')) {
      db.run('ALTER TABLE app_settings ADD COLUMN deepseek_api_key TEXT');
      console.log('Added deepseek_api_key column to app_settings');
    }

    // Allow ai_provider = 'groq' (legacy CREATE TABLE CHECK only had minimax/deepseek).
    try {
      const chkInfo = db.exec(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='app_settings'`
      );
      const createSql = String(chkInfo[0]?.values?.[0]?.[0] || '');
      if (createSql && !/ai_provider IN \([^)]*'groq'/i.test(createSql)) {
        db.run('BEGIN');
        db.run(`
          CREATE TABLE app_settings_new (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            ai_provider TEXT NOT NULL DEFAULT 'minimax'
              CHECK(ai_provider IN ('minimax', 'deepseek', 'groq')),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_by INTEGER,
            minimax_key_slot INTEGER NOT NULL DEFAULT 1,
            minimax_api_key_1 TEXT,
            minimax_api_key_2 TEXT,
            local_llm_enabled INTEGER NOT NULL DEFAULT 0,
            local_llm_base_url TEXT DEFAULT 'http://127.0.0.1:11434/v1',
            local_llm_model TEXT DEFAULT 'llama3.2',
            local_llm_api_key TEXT,
            groq_api_keys TEXT,
            groq_key_slot INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
          )
        `);
        db.run(`
          INSERT INTO app_settings_new (
            id, ai_provider, updated_at, updated_by,
            minimax_key_slot, minimax_api_key_1, minimax_api_key_2,
            local_llm_enabled, local_llm_base_url, local_llm_model, local_llm_api_key,
            groq_api_keys, groq_key_slot
          )
          SELECT
            id, ai_provider, updated_at, updated_by,
            COALESCE(minimax_key_slot, 1), minimax_api_key_1, minimax_api_key_2,
            COALESCE(local_llm_enabled, 0), local_llm_base_url, local_llm_model, local_llm_api_key,
            groq_api_keys, COALESCE(groq_key_slot, 1)
          FROM app_settings
        `);
        db.run('DROP TABLE app_settings');
        db.run('ALTER TABLE app_settings_new RENAME TO app_settings');
        db.run('COMMIT');
        console.log('Rebuilt app_settings to allow ai_provider=groq');
      }
    } catch (groqChkErr) {
      try { db.run('ROLLBACK'); } catch (_) { /* ignore */ }
      console.warn('app_settings groq CHECK rebuild skipped:', groqChkErr?.message || groqChkErr);
    }
  } catch (error) {
    console.warn('app_settings minimax/local LLM migration skipped:', error?.message || error);
  }

  // Bid-course analytics: log generate/fill/apply courses and interview outcomes.
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS bid_courses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id INTEGER NOT NULL UNIQUE,
        profile_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        job_url TEXT,
        company_name TEXT,
        job_role TEXT,
        started_at DATETIME,
        filled_at DATETIME,
        applied_at DATETIME,
        template_id INTEGER,
        font_family TEXT,
        cv_provider TEXT,
        answers_provider TEXT,
        answers_model TEXT,
        salary_value REAL,
        salary_formatted TEXT,
        fill_stats_json TEXT,
        outcome TEXT NOT NULL DEFAULT 'unknown'
          CHECK(outcome IN ('unknown', 'applied', 'interview', 'rejected')),
        answers_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES job_applications(id) ON DELETE CASCADE,
        FOREIGN KEY (profile_id) REFERENCES candidate_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS bid_course_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        at DATETIME DEFAULT CURRENT_TIMESTAMP,
        meta_json TEXT,
        FOREIGN KEY (course_id) REFERENCES bid_courses(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bid_courses_profile ON bid_courses(profile_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bid_courses_user ON bid_courses(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bid_courses_outcome ON bid_courses(outcome)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bid_course_events_course ON bid_course_events(course_id)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS bid_course_screenshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id INTEGER NOT NULL,
        application_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        file_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (course_id) REFERENCES bid_courses(id) ON DELETE CASCADE
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bid_shots_course ON bid_course_screenshots(course_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_bid_shots_app ON bid_course_screenshots(application_id)`);
  } catch (error) {
    console.warn('bid_courses tables migration skipped:', error?.message || error);
  }

  // MiniMax / AI usage events for Analyze page counts (chat, cv, answers, …).
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        profile_id INTEGER,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        success INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_events(user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_usage_kind ON ai_usage_events(kind)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_events(created_at)`);
  } catch (error) {
    console.warn('ai_usage_events table migration skipped:', error?.message || error);
  }

  // Migration: Add job_role and core_skills columns if they don't exist
  try {
    const tableInfo = db.exec("PRAGMA table_info(job_applications)");
    const columns = tableInfo[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('job_role')) {
      db.run("ALTER TABLE job_applications ADD COLUMN job_role TEXT");
      console.log('Added job_role column to job_applications table');
    }
    if (!columns.includes('core_skills')) {
      db.run("ALTER TABLE job_applications ADD COLUMN core_skills TEXT");
      console.log('Added core_skills column to job_applications table');
    }
    if (!columns.includes('applier_id')) {
      db.run("ALTER TABLE job_applications ADD COLUMN applier_id INTEGER");
      console.log('Added applier_id column to job_applications table');
    }
    if (!columns.includes('job_url')) {
      db.run("ALTER TABLE job_applications ADD COLUMN job_url TEXT");
      console.log('Added job_url column to job_applications table');
    }
    if (!columns.includes('reject_reason')) {
      db.run("ALTER TABLE job_applications ADD COLUMN reject_reason TEXT");
      console.log('Added reject_reason column to job_applications table');
    }
    if (!columns.includes('recruiter_reply')) {
      db.run("ALTER TABLE job_applications ADD COLUMN recruiter_reply TEXT");
      console.log('Added recruiter_reply column to job_applications table');
    }
    if (!columns.includes('recruiter_reply_at')) {
      db.run("ALTER TABLE job_applications ADD COLUMN recruiter_reply_at DATETIME");
      console.log('Added recruiter_reply_at column to job_applications table');
    }
    // `state` is the admin-owned terminal state for a job application:
    //   'in_progress' (default) – the user keeps recording milestones
    //   'completed'              – admin marked it done (e.g. hired)
    //   'cancelled'              – admin cancelled the request
    //   'rejected'               – admin marked it rejected
    // Only admins write this column; users see it as a read-only badge.
    if (!columns.includes('state')) {
      db.run("ALTER TABLE job_applications ADD COLUMN state TEXT NOT NULL DEFAULT 'in_progress'");
      console.log('Added state column to job_applications table');
    }
    // Resume generation preferences — store the chosen template id and
    // font name on the application so re-generation stays consistent and
    // the PDF/DOCX outputs always match the user's initial choice.
    if (!columns.includes('template_id')) {
      db.run("ALTER TABLE job_applications ADD COLUMN template_id INTEGER");
      console.log('Added template_id column to job_applications table');
    }
    if (!columns.includes('font_family')) {
      db.run("ALTER TABLE job_applications ADD COLUMN font_family TEXT DEFAULT 'Arial'");
      console.log('Added font_family column to job_applications table');
    }
    if (!columns.includes('draft_html')) {
      db.run("ALTER TABLE job_applications ADD COLUMN draft_html TEXT");
      console.log('Added draft_html column to job_applications table');
    }
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Migration: requested_time + expire_time on interview_requests
  try {
    const irInfo = db.exec("PRAGMA table_info(interview_requests)");
    const irColumns = irInfo[0]?.values.map(row => row[1]) || [];
    if (!irColumns.includes('requested_time')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN requested_time TEXT");
      console.log('Added requested_time column to interview_requests table');
    }
    if (!irColumns.includes('expire_time')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN expire_time TEXT");
      console.log('Added expire_time column to interview_requests table');
    }
    if (!irColumns.includes('reply_channel')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN reply_channel TEXT");
      console.log('Added reply_channel column to interview_requests table');
    }
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Migration: per-milestone detail columns.
  //
  // We add 4 new TEXT columns to interview_milestones so each step can
  // carry its own context (recruiter_message, reply_message,
  // interview_link, ai_interview_detail). Older milestones start with
  // NULL in each; one-shot backfill below seeds recruiter_message on
  // the head row of every interview_requests row that has a reply.
  try {
    const imInfo = db.exec("PRAGMA table_info(interview_milestones)");
    const imColumns = imInfo[0]?.values.map(row => row[1]) || [];
    const ensureIm = (name) => {
      if (!imColumns.includes(name)) {
        db.run(`ALTER TABLE interview_milestones ADD COLUMN ${name} TEXT`);
        console.log(`Added ${name} column to interview_milestones table`);
      }
    };
    ensureIm('recruiter_message');
    ensureIm('reply_message');
    ensureIm('interview_link');
    ensureIm('ai_interview_detail');
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Backfill: seed recruiter_message on the head (position=0) milestone
  // of every interview_requests row that has a reply on file. This
  // gives the admin modal something meaningful to show when an admin
  // opens an old request — the recruiter's first message is preserved
  // on the head row.
  try {
    db.run(`
      UPDATE interview_milestones
      SET recruiter_message = (
            SELECT ir.recruiter_reply FROM interview_requests ir
            WHERE ir.id = interview_milestones.interview_request_id
          ),
          updated_at = CURRENT_TIMESTAMP
      WHERE position = 0
        AND (recruiter_message IS NULL OR recruiter_message = '')
        AND EXISTS (
          SELECT 1 FROM interview_requests ir
          WHERE ir.id = interview_milestones.interview_request_id
            AND ir.recruiter_reply IS NOT NULL AND ir.recruiter_reply <> ''
        )
    `);
  } catch (error) {
    // The new columns may not exist yet on a fresh DB — ignore.
  }

  // Migration: clear the fake scheduled_at on synthetic reply_received
  // milestones. The auto-created row used to set scheduled_at to the
  // same value as completed_at (the recruiter reply timestamp), which
  // made the stepper render a misleading date label. The auto-milestone
  // now leaves scheduled_at NULL; this one-shot cleans up legacy rows.
  try {
    db.run(
      `UPDATE interview_milestones
       SET scheduled_at = NULL
       WHERE kind = 'reply_received' AND completed_at IS NOT NULL
         AND scheduled_at IS NOT NULL`
    );
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Migration: legacy reply_received rows are upgraded to a channel-kind
  // milestone (kind = reply_channel of the parent request), and all
  // existing milestones get marked `completed_at` so the request reads
  // as fully-completed once a reply has landed. Channel encoding table
  // (matches services/milestoneService.js):
  //
  //   Video        -> kind='video'
  //   Phone        -> kind='phone_screen'
  //   AI interview -> kind='ai_interview'
  //   Email | Text | Other -> kind='other'
  //
  // Also: if the interview_requests table had reply_channel set but no
  // recruiter_reply, we drop the leftover reply_received row (it was
  // created by older code that used reply_channel alone as the trigger).
  // Likewise, mark all milestones completed when the request has any
  // recruiter_reply text — implements "all milestones should be updated
  // as completed".
  try {
    const irRows = db.exec(`
      SELECT id, recruiter_reply, recruiter_reply_at, reply_channel
      FROM interview_requests
      WHERE reply_channel IS NOT NULL AND reply_channel <> ''
    `);
    const update = db.prepare(`UPDATE interview_milestones
                                SET kind = ?, label = ?, updated_at = CURRENT_TIMESTAMP
                                WHERE id = ?`);
    for (const row of irRows[0]?.values || []) {
      const [requestId, recruiterReply, recruiterReplyAt, channel] = row;
      const ch = String(channel).trim().toLowerCase();
      let newKind = 'other';
      if (ch === 'video') newKind = 'video';
      else if (ch === 'phone') newKind = 'phone_screen';
      else if (ch === 'ai interview') newKind = 'ai_interview';
      const stamp = (recruiterReplyAt && String(recruiterReplyAt).trim())
        ? new Date(String(recruiterReplyAt).replace(' ', 'T') + 'Z').toISOString()
        : new Date().toISOString();
      const hasReply = recruiterReply && String(recruiterReply).trim();

      // Look for any legacy `reply_received` row to upgrade in place.
      const headRow = db.exec(`
        SELECT id FROM interview_milestones
        WHERE interview_request_id = ${requestId}
          AND kind = 'reply_received'
        ORDER BY position ASC, id ASC LIMIT 1
      `);
      let headId = headRow[0]?.values?.[0]?.[0] || null;

      if (headId) {
        // Upgrade legacy row to the channel-kind milestone.
        const labelText = `Reply received (${channel})`;
        update.run([newKind, labelText, headId]);
      } else if (hasReply) {
        // No legacy row but we have a reply on file — insert a fresh
        // head-of-list channel-kind milestone so the stepper shows the
        // chain.
        const allRow = db.exec(`
          SELECT COALESCE(MAX(position), -1) AS m
          FROM interview_milestones
          WHERE interview_request_id = ${requestId}
        `);
        const basePos = (allRow[0]?.values?.[0]?.[0] ?? -1) + 1;
        // Bump every existing milestone's position by 1 so the new row
        // can take position 0.
        db.run(`
          UPDATE interview_milestones
          SET position = position + 1
          WHERE interview_request_id = ${requestId}
        `);
        const labelText = `Reply received (${channel})`;
        db.run(
          `INSERT INTO interview_milestones
              (interview_request_id, kind, label, scheduled_at, completed_at, notes, position)
           VALUES (${requestId}, ?, ?, NULL, ?, NULL, 0)`,
          [newKind, labelText, stamp]
        );
      }

      // Mark all remaining milestones completed if a reply is on file.
      if (hasReply) {
        db.run(`
          UPDATE interview_milestones
          SET completed_at = COALESCE(completed_at, ?),
              updated_at = CURRENT_TIMESTAMP
          WHERE interview_request_id = ${requestId}
            AND completed_at IS NULL
        `, [stamp]);
      }
    }
    update.free();
  } catch (error) {
    console.warn('Legacy reply-channel migration failed:', error.message);
  }

  // -------------------------------------------------------------------------
  // Milestone workflow rewrite — schema additions
  // -------------------------------------------------------------------------
  // The new milestone workflow lets the user add the first milestone from
  // their application dashboard. That first milestone auto-creates an
  // interview_request row so the admin can see it as an Interview Request
  // and assign a developer (a user with role='developer'). Per-application
  // developers are tracked here so the workflow can hand off to a
  // developer without touching the user's global role.

  // Migration: extend users.role CHECK to include 'developer'. SQLite
  // can't ALTER a CHECK constraint in place, so we recreate the table
  // via the rename-and-copy dance used by the existing role migration.
  //
  // Idempotency note: a previous crash mid-migration can leave a
  // `users_old` table on disk. We drop it up-front (when present
  // and empty) so the rename-to step below doesn't collide.
  try {
    // Belt-and-braces: drop any leftover `users_old` from a
    // earlier crashed migration. The table is only created by
    // the rename step below, so dropping it here is a no-op if
    // it's already gone.
    const orphanOld = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users_old'"
    );
    if (orphanOld.length > 0 && orphanOld[0].values.length > 0) {
      db.run('DROP TABLE users_old');
      console.log('Dropped leftover users_old from earlier migration');
    }

    const usersSqlResult = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
    if (usersSqlResult.length > 0 && usersSqlResult[0].values.length > 0) {
      const sql = usersSqlResult[0].values[0][0];
      if (sql && !sql.includes("'developer'")) {
        console.log('Migrating users.role to include developer...');
        db.run("ALTER TABLE users RENAME TO users_old");
        db.run(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'user', 'caller', 'manager', 'developer')),
            created_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.run(`
          INSERT INTO users (id, username, password_hash, role, created_by, created_at)
          SELECT id, username, password_hash, role, created_by, created_at FROM users_old
        `);
        db.run("DROP TABLE users_old");
        console.log('✅ users.role now supports developer');
      }
    }
  } catch (error) {
    console.error('developer-role migration error:', error.message);
  }

  // Migration: extend user_roles CHECK to include 'developer'. The
  // user_roles table is the source of truth for users that hold more
  // than one role; we keep the same constraint syntax so admin
  // assignments stay consistent.
  try {
    const urSqlResult = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_roles'");
    if (urSqlResult.length > 0 && urSqlResult[0].values.length > 0) {
      const sql = urSqlResult[0].values[0][0];
      if (sql && !sql.includes("'developer'")) {
        console.log('Migrating user_roles to include developer...');
        db.run("ALTER TABLE user_roles RENAME TO user_roles_old");
        db.run(`
          CREATE TABLE user_roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'user', 'caller', 'manager', 'developer')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, role)
          )
        `);
        db.run(`
          INSERT INTO user_roles (id, user_id, role, created_at)
          SELECT id, user_id, role, created_at FROM user_roles_old
        `);
        db.run("DROP TABLE user_roles_old");
        console.log('✅ user_roles now supports developer');
      }
    }
  } catch (error) {
    console.error('user_roles developer migration error:', error.message);
  }

  // Migration: interview_requests gains assigned_developer_id (FK to
  // users) and assigned_at. The new milestone workflow hands an
  // interview_request off to a developer-role user without changing
  // anyone's global role; this column captures the per-application
  // assignment.
  try {
    const irInfo = db.exec("PRAGMA table_info(interview_requests)");
    const irCols = irInfo[0]?.values.map(row => row[1]) || [];
    if (!irCols.includes('assigned_developer_id')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN assigned_developer_id INTEGER");
      console.log('Added assigned_developer_id to interview_requests');
    }
    if (!irCols.includes('assigned_at')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN assigned_at DATETIME");
      console.log('Added assigned_at to interview_requests');
    }
    if (!irCols.includes('last_milestone_added_by')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN last_milestone_added_by INTEGER");
      console.log('Added last_milestone_added_by to interview_requests');
    }
    if (!irCols.includes('success_flag')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN success_flag INTEGER NOT NULL DEFAULT 0");
      console.log('Added success_flag to interview_requests');
    }
    if (!irCols.includes('failed_flag')) {
      db.run("ALTER TABLE interview_requests ADD COLUMN failed_flag INTEGER NOT NULL DEFAULT 0");
      console.log('Added failed_flag to interview_requests');
    }
  } catch (error) {
    console.warn('interview_requests developer/flag migration failed:', error.message);
  }

  // Migration: interview_milestones gains milestone_type + memo so each
  // step has a structured kind label and free-form detail text. kind
  // remains for backward compatibility with legacy rows.
  try {
    const imInfo = db.exec("PRAGMA table_info(interview_milestones)");
    const imCols = imInfo[0]?.values.map(row => row[1]) || [];
    if (!imCols.includes('milestone_type')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN milestone_type TEXT");
      console.log('Added milestone_type to interview_milestones');
    }
    if (!imCols.includes('memo')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN memo TEXT");
      console.log('Added memo to interview_milestones');
    }
    if (!imCols.includes('completed_by')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN completed_by INTEGER");
      console.log('Added completed_by to interview_milestones');
    }
    if (!imCols.includes('added_by')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN added_by INTEGER");
      console.log('Added added_by to interview_milestones');
    }
    if (!imCols.includes('duration_minutes')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN duration_minutes INTEGER");
      console.log('Added duration_minutes to interview_milestones');
    }
    // Approval + payment workflow (2026-07). Admins mark a completed
    // milestone as approved (interview verified, ready to invoice) and
    // later as paid (invoice settled). Both flags are independent and
    // non-terminal — toggling them doesn't lock the row. The flags +
    // actor + timestamp are stored so the audit trail shows who
    // approved / paid each step.
    if (!imCols.includes('approved')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN approved INTEGER NOT NULL DEFAULT 0");
      console.log('Added approved to interview_milestones');
    }
    if (!imCols.includes('approved_by')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN approved_by INTEGER");
      console.log('Added approved_by to interview_milestones');
    }
    if (!imCols.includes('approved_at')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN approved_at DATETIME");
      console.log('Added approved_at to interview_milestones');
    }
    if (!imCols.includes('paid')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN paid INTEGER NOT NULL DEFAULT 0");
      console.log('Added paid to interview_milestones');
    }
    if (!imCols.includes('paid_by')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN paid_by INTEGER");
      console.log('Added paid_by to interview_milestones');
    }
    if (!imCols.includes('paid_at')) {
      db.run("ALTER TABLE interview_milestones ADD COLUMN paid_at DATETIME");
      console.log('Added paid_at to interview_milestones');
    }
    // scheduled_at is stored as ISO-8601 UTC string; UI converts to
    // GMT-4 on display. We don't enforce a column rename — the existing
    // scheduled_at is fine for the new workflow too.
  } catch (error) {
    console.warn('interview_milestones type/memo migration failed:', error.message);
  }

  // Migration: job_applications gains success_flag + failed_flag so
  // admins can mark the application outcome from the dashboard without
  // having to add a synthetic milestone. These are non-terminal —
  // toggling them does NOT lock the application.
  try {
    const jaInfo = db.exec("PRAGMA table_info(job_applications)");
    const jaCols = jaInfo[0]?.values.map(row => row[1]) || [];
    if (!jaCols.includes('success_flag')) {
      db.run("ALTER TABLE job_applications ADD COLUMN success_flag INTEGER NOT NULL DEFAULT 0");
      console.log('Added success_flag to job_applications');
    }
    if (!jaCols.includes('failed_flag')) {
      db.run("ALTER TABLE job_applications ADD COLUMN failed_flag INTEGER NOT NULL DEFAULT 0");
      console.log('Added failed_flag to job_applications');
    }
    if (!jaCols.includes('cancelled_flag')) {
      db.run("ALTER TABLE job_applications ADD COLUMN cancelled_flag INTEGER NOT NULL DEFAULT 0");
      console.log('Added cancelled_flag to job_applications');
    }
    if (!jaCols.includes('flags_set_by')) {
      db.run("ALTER TABLE job_applications ADD COLUMN flags_set_by INTEGER");
      console.log('Added flags_set_by to job_applications');
    }
    if (!jaCols.includes('flags_set_at')) {
      db.run("ALTER TABLE job_applications ADD COLUMN flags_set_at DATETIME");
      console.log('Added flags_set_at to job_applications');
    }
  } catch (error) {
    console.warn('job_applications flags migration failed:', error.message);
  }

  // Migration: contact + resume columns on caller_profile_inputs
  try {
    const cpInfo = db.exec("PRAGMA table_info(caller_profile_inputs)");
    const cpColumns = cpInfo[0]?.values.map(row => row[1]) || [];
    const ensure = (name, type = 'TEXT') => {
      if (!cpColumns.includes(name)) {
        db.run(`ALTER TABLE caller_profile_inputs ADD COLUMN ${name} ${type}`);
        console.log(`Added ${name} column to caller_profile_inputs table`);
      }
    };
    ensure('email');
    ensure('whatsapp');
    ensure('telegram');
    ensure('resume_filename');
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Create the interview_requests indexes (guaranteed-safe with IF NOT EXISTS).
  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_interview_requests_status ON interview_requests(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_interview_requests_application ON interview_requests(application_id)`);
  } catch (error) {
    // Non-fatal — indexes are an optimisation, not a correctness requirement.
  }

  // Migration: Update users table to support caller role
  try {
    // Check if the users table has the old constraint by trying to insert a caller role
    const testResult = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'");
    if (testResult.length > 0 && testResult[0].values.length > 0) {
      const tableSql = testResult[0].values[0][0];

      // Check if the constraint needs updating (doesn't include 'caller')
      if (tableSql && !tableSql.includes("'caller'")) {
        console.log('Migrating users table to support caller role...');

        // Step 1: Rename old table
        db.run("ALTER TABLE users RENAME TO users_old");

        // Step 2: Create new table with updated constraint
        db.run(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'user', 'caller', 'manager')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // Step 3: Copy data from old table
        db.run(`
          INSERT INTO users (id, username, password_hash, role, created_at)
          SELECT id, username, password_hash, role, created_at FROM users_old
        `);

        // Step 4: Drop old table
        db.run("DROP TABLE users_old");

        console.log('✅ Users table migration completed - caller role is now supported');
        saveDatabase();
      }
    }
  } catch (error) {
    console.error('Migration error:', error.message);
  }

  // Migration: Add timezone column to interviews table if it doesn't exist
  try {
    const tableInfo = db.exec("PRAGMA table_info(interviews)");
    const columns = tableInfo[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('timezone')) {
      db.run("ALTER TABLE interviews ADD COLUMN timezone TEXT");
      console.log('Added timezone column to interviews table');
    }
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Migration: Add created_by column to candidate_profiles if it doesn't exist
  try {
    const tableInfo = db.exec("PRAGMA table_info(candidate_profiles)");
    const columns = tableInfo[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('created_by')) {
      db.run("ALTER TABLE candidate_profiles ADD COLUMN created_by INTEGER");
      console.log('Added created_by column to candidate_profiles table');
      saveDatabase();
    }
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Migration: Add preferred_template_id column to candidate_profiles
  // -----------------------------------------------------------------
  // When a profile has a preferred_template_id set, the resume-
  // generation routes (/user/generate-resume, /user/regenerate-resume)
  // use it as the default `template_id` override. NULL means "fall
  // back to the system default template". FK ON DELETE SET NULL so
  // deleting a custom template doesn't orphan a profile reference.
  //
  // We add the index lazily on the migration path so older DBs pick
  // it up; a fresh DB's CREATE TABLE already declares it.
  try {
    const cpInfo = db.exec("PRAGMA table_info(candidate_profiles)");
    const cpCols = cpInfo[0]?.values.map((r) => r[1]) || [];
    if (!cpCols.includes('preferred_template_id')) {
      db.run(
        "ALTER TABLE candidate_profiles ADD COLUMN preferred_template_id INTEGER REFERENCES resume_templates(id) ON DELETE SET NULL"
      );
      console.log('Added preferred_template_id column to candidate_profiles table');
      saveDatabase();
    }
    // Disambiguates which template table the id points at when
    // an admin picks a drag-drop template from another user.
    // Values: 'admin' | 'user' | NULL. NULL defaults to 'admin'
    // for legacy rows so existing assignments keep working.
    if (!cpCols.includes('preferred_template_kind')) {
      db.run(
        "ALTER TABLE candidate_profiles ADD COLUMN preferred_template_kind TEXT DEFAULT 'admin'"
      );
      console.log('Added preferred_template_kind column to candidate_profiles table');
      saveDatabase();
    }
    db.run(
      "CREATE INDEX IF NOT EXISTS idx_candidate_profiles_preferred_template ON candidate_profiles(preferred_template_id)"
    );
  } catch (error) {
    // resume_templates may not exist yet on a brand-new DB; that's
    // fine — the ALTER_TABLE above is re-tried on every boot until
    // the templates table exists.
    console.warn('preferred_template_id migration skipped:', error.message);
  }

  // Fixed EEO / eligibility fields used by autofill (profile only, not AI).
  try {
    const eeoInfo = db.exec('PRAGMA table_info(candidate_profiles)');
    const eeoCols = eeoInfo[0]?.values.map((r) => r[1]) || [];
    const addEeo = (col) => {
      if (!eeoCols.includes(col)) {
        db.run(`ALTER TABLE candidate_profiles ADD COLUMN ${col} TEXT`);
        console.log(`Added ${col} column to candidate_profiles table`);
        saveDatabase();
      }
    };
    addEeo('gender');
    addEeo('work_authorization');
    addEeo('requires_sponsorship');
    addEeo('disability_status');
    addEeo('veteran_status');
    addEeo('race_ethnicity');
    addEeo('website_url');
    addEeo('portfolio_url');
    addEeo('preferred_name');
    addEeo('over_18');
    addEeo('hispanic_latino');
    addEeo('willing_to_relocate');
    addEeo('willing_to_travel');
    addEeo('earliest_start_date');
    addEeo('notice_period');
    addEeo('how_heard');
    addEeo('years_of_experience');
    addEeo('education_level');
    addEeo('security_clearance');
    addEeo('school');
    addEeo('degree');
    addEeo('discipline');
  } catch (error) {
    console.warn('candidate_profiles EEO columns migration skipped:', error.message);
  }

  // Hard lock: Disability Status = No for every profile (overrides prior Yes answers).
  try {
    db.run(
      `UPDATE candidate_profiles
          SET disability_status = 'No, I do not have a disability'
        WHERE disability_status IS NULL
           OR TRIM(disability_status) = ''
           OR disability_status NOT LIKE 'No, I do not have a disability'`
    );
    saveDatabase();
  } catch (error) {
    console.warn('disability_status No hard-lock migration skipped:', error.message);
  }

  // Migration: Add created_by column to users if it doesn't exist
  try {
    const tableInfo = db.exec("PRAGMA table_info(users)");
    const columns = tableInfo[0]?.values.map(row => row[1]) || [];
    if (!columns.includes('created_by')) {
      db.run("ALTER TABLE users ADD COLUMN created_by INTEGER");
      console.log('Added created_by column to users table');
      saveDatabase();
    }
  } catch (error) {
    // Table might not exist yet, ignore
  }

  // Migration: developer-profile fields (2026-07).
  // The developer dashboard now has a profile page where the
  // developer manages their own technical skills, availability,
  // resume, and contact channels (email, telegram are required;
  // whatsapp and phone are optional). All columns live on `users`
  // so the data lives with the account and there's no extra JOIN
  // at read time.
  try {
    const userInfo = db.exec("PRAGMA table_info(users)");
    const userCols = userInfo[0]?.values.map((row) => row[1]) || [];
    const addUserCol = (name, ddl, logName) => {
      if (!userCols.includes(name)) {
        db.run(`ALTER TABLE users ADD COLUMN ${ddl}`);
        console.log(`Added ${logName || name} to users`);
      }
    };
    addUserCol('technical_skills',  'technical_skills TEXT');
    addUserCol('availability',      'availability TEXT');
    addUserCol('developer_resume',  'developer_resume TEXT');
    addUserCol('contact_email',     'contact_email TEXT');
    addUserCol('contact_whatsapp',  'contact_whatsapp TEXT');
    addUserCol('contact_phone',     'contact_phone TEXT');
    addUserCol('contact_telegram',  'contact_telegram TEXT');
  } catch (error) {
    console.warn('developer-profile migration failed:', error.message);
  }

  // Migration: legacy callers → developer
  // -------------------------------------------------------------
  // The 2026-07 milestone workflow made 'developer' a first-class
  // role and split it out from 'caller'. Existing users that were
  // created with role='caller' should be promoted to 'developer' so
  // they (a) appear in the Admin Interview Requests developer
  // dropdown, (b) can complete milestones per the developer rules,
  // and (c) are no longer labelled "caller" in the User Management
  // table.
  //
  // This migration is idempotent — once a caller has been promoted
  // their primary role is 'developer' and the `WHERE role = 'caller'`
  // filter won't match them on subsequent boots.
  //
  // The same applies to additional roles stored in `user_roles`:
  // anyone with 'caller' as an additional role also gets 'developer'
  // added so the user_roles union view stays accurate.
  //
  // We use raw `db.run` here instead of `runQuery` because this code
  // runs inside `initDatabase` BEFORE the runQuery/getAll helpers are
  // declared below (they're hoisted only by `function` declarations,
  // and JS module top-level `function fn(){}` IS hoisted — but
  // helper functions that depend on closure state aren't safe to call
  // before initDatabase finishes).
  try {
    const promoted = db.run(
      `UPDATE users SET role = 'developer' WHERE role = 'caller'`
    );
    const promotedCount = (promoted && typeof promoted === 'object' && 'changes' in promoted)
      ? promoted.changes
      : (db.getRowsModified ? db.getRowsModified() : 0);
    if (promotedCount) {
      console.log(`Migrated ${promotedCount} legacy caller(s) → developer (primary role)`);
    }

    // Walk every user_roles row that still says 'caller' and add a
    // 'developer' row for the same user, then delete the 'caller'
    // row. INSERT OR IGNORE keeps the migration idempotent.
    const callerRoles = db.exec(
      `SELECT DISTINCT user_id FROM user_roles WHERE role = 'caller'`
    );
    const callerUserIds = (callerRoles && callerRoles[0] && callerRoles[0].values)
      ? callerRoles[0].values.map((r) => r[0])
      : [];
    for (const uid of callerUserIds) {
      db.run(
        `INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, 'developer')`,
        [uid]
      );
      db.run(
        `DELETE FROM user_roles WHERE user_id = ? AND role = 'caller'`,
        [uid]
      );
    }
    if (callerUserIds.length) {
      console.log(`Migrated ${callerUserIds.length} user_roles caller entries → developer (additional role)`);
      saveDatabase();
    }
  } catch (error) {
    console.warn('Legacy caller → developer migration failed:', error.message);
  }

  // Portable default accounts — always present with known passwords so anyone
  // can sign in after copying the repo (including a fresh or empty DB).
  const DEFAULT_ACCOUNTS = [
    { username: 'vincent', password: '123456', role: 'admin' },
    { username: 'admin', password: 'admin123', role: 'admin' },
    { username: 'bob', password: 'bob123', role: 'user' },
    { username: 'henry', password: 'mgr123', role: 'manager' }
  ];
  for (const acct of DEFAULT_ACCOUNTS) {
    const passwordHash = bcrypt.hashSync(acct.password, 10);
    let uid = null;
    try {
      const stmt = db.prepare('SELECT id FROM users WHERE username = ?');
      stmt.bind([acct.username]);
      if (stmt.step()) {
        uid = stmt.getAsObject().id;
      }
      stmt.free();
    } catch (_) {
      uid = null;
    }
    if (uid == null) {
      db.run(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [acct.username, passwordHash, acct.role]
      );
      try {
        const idStmt = db.prepare('SELECT id FROM users WHERE username = ?');
        idStmt.bind([acct.username]);
        if (idStmt.step()) uid = idStmt.getAsObject().id;
        idStmt.free();
      } catch (_) { /* ignore */ }
      console.log(`Default account created (${acct.username}/${acct.password} · ${acct.role})`);
    } else {
      db.run(
        'UPDATE users SET password_hash = ?, role = ? WHERE id = ?',
        [passwordHash, acct.role, uid]
      );
    }
    if (uid != null) {
      try {
        db.run('INSERT OR IGNORE INTO user_roles (user_id, role) VALUES (?, ?)', [uid, acct.role]);
      } catch (_) { /* older schemas */ }
    }
  }
  console.log('Default logins: vincent/123456 · admin/admin123 · bob/bob123 · henry/mgr123');

  saveDatabase();
  return db;
}

// Save database to file
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

/**
 * Re-read database.sqlite from disk into the active sql.js connection.
 * Use after running the seed script while the dev server is already up —
 * otherwise the server keeps serving stale in-memory data.
 */
function reloadDatabaseFromDisk() {
  if (!sqlFactory) {
    throw new Error('Database not initialized — call initDatabase() first');
  }
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database file not found: ${DB_PATH}`);
  }
  const buffer = fs.readFileSync(DB_PATH);
  if (db) {
    try { db.close(); } catch (_) { /* noop */ }
  }
  db = new sqlFactory.Database(buffer);
  const links = getOne('SELECT COUNT(*) AS n FROM job_links');
  return { job_links: links?.n || 0 };
}

// Database query helpers
function getDb() {
  return db;
}

function runQuery(sql, params = []) {
  try {
    db.run(sql, params);
    // In sql.js, `db.exec` does not reliably expose the last insert rowid
    // from the preceding `db.run`. Read it via a fresh prepared statement
    // against the same database handle to guarantee we get the correct id.
    let lastInsertRowid = 0;
    try {
      const stmt = db.prepare("SELECT last_insert_rowid() AS id");
      if (stmt.step()) {
        const row = stmt.getAsObject();
        lastInsertRowid = row.id || 0;
      }
      stmt.free();
    } catch (_) {
      // last_insert_rowid() is not a valid query in some drivers / older
      // sql.js builds. Fall back to the exec form.
      try {
        const execRes = db.exec("SELECT last_insert_rowid() AS id");
        if (execRes && execRes[0] && execRes[0].values && execRes[0].values[0]) {
          lastInsertRowid = execRes[0].values[0][0] || 0;
        }
      } catch (_) {
        // give up, leave as 0
      }
    }
    saveDatabase();
    return { lastInsertRowid, changes: db.getRowsModified() };
  } catch (error) {
    throw error;
  }
}

/**
 * Run a statement inside a transaction-bounded context. Skips
 * `saveDatabase()` (which calls `db.export()`) because that
 * breaks the transaction in sql.js — see the standalone
 * reproduction in tests/tx-test.js. The caller is responsible
 * for ensuring the DB is persisted AFTER the transaction
 * commits (see `withTransaction` in jobLinkScraper.js).
 *
 * Returns the same shape as `runQuery` for caller convenience.
 */
function txRunQuery(sql, params = []) {
  try {
    db.run(sql, params);
    let lastInsertRowid = 0;
    try {
      const stmt = db.prepare("SELECT last_insert_rowid() AS id");
      if (stmt.step()) {
        const row = stmt.getAsObject();
        lastInsertRowid = row.id || 0;
      }
      stmt.free();
    } catch (_) {
      // ignore — last_insert_rowid() not always available
    }
    return { lastInsertRowid, changes: db.getRowsModified() };
  } catch (error) {
    throw error;
  }
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

// =============================================================================
// Location flag (region) enum + auto-detect
// =============================================================================
//
// Closed enum of coarse regions the admin can assign per candidate
// profile or per job link. The set was picked with the user:
// "US (default), Brazil, EU, Asia, Other". Used downstream by
// filters, dashboards, and resume generation scoping.
//
// `LOCATION_FLAGS` is the canonical list. The CHECK constraint on
// `candidate_profiles.location_flag` and `job_links.location_flag`
// mirrors this list at the DB layer so a typo never lands in the
// table even if a route forgets to validate.
//
// `detectLocationFlag(text)` is a best-effort heuristic — when the
// admin pastes a job URL whose ATS scrape returns a free-text
// `location` like "Sao Paulo, Brazil" we map it to one of the
// enum values. The function never throws; it falls back to 'US'
// when the text is empty / unrecognised.
const LOCATION_FLAGS = ['US', 'Brazil', 'EU', 'Asia', 'Other'];

/** Region is always US for this product — ignore URL/city heuristics. */
function detectLocationFlag(_text) {
  return 'US';
}

module.exports = {
  initDatabase, reloadDatabaseFromDisk, getDb, runQuery, txRunQuery, getOne, getAll, saveDatabase,
  LOCATION_FLAGS, detectLocationFlag
};
