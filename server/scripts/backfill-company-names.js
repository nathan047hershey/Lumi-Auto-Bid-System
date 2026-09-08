#!/usr/bin/env node
/**
 * One-shot backfill: re-extract the company name from each job application's
 * stored job_description, then update company_name + resume_filename in the DB
 * and rename the corresponding files in /server/resumes/.
 *
 * Usage:
 *   node server/scripts/backfill-company-names.js --dry-run
 *   node server/scripts/backfill-company-names.js
 *   node server/scripts/backfill-company-names.js --limit 100
 *
 * Idempotent: re-running after a successful pass finds nothing to change.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAll, runQuery, initDatabase } = require('../config/database');
const { extractCompanyName, sanitizeForFilename } = require('../services/resumeService');

const RESUMES_DIR = path.join(__dirname, '..', 'resumes');
const DRY_RUN = process.argv.includes('--dry-run');
const NO_LLM = process.argv.includes('--no-llm');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

function log(...args) { console.log(...args); }

function safeRename(oldPath, newPath) {
    if (oldPath === newPath) return 'same';
    if (!fs.existsSync(oldPath)) return 'missing';
    if (fs.existsSync(newPath)) return 'collision';
    fs.renameSync(oldPath, newPath);
    return 'renamed';
}

function shortHash(input) {
    return crypto.createHash('sha1').update(String(input)).digest('hex').substring(0, 6);
}

// Parse an old filename like "resume_Vinh_ Ly_Appfire_1781230921074.docx" into
// {prefix, firstLast, ts}. The firstLast segment may contain spaces (e.g. "Vinh_ Ly"),
// so we anchor on the trailing 10+ digit timestamp and on the known prefix,
// and treat the LAST remaining underscore-separated token as the old company
// (which we discard and rebuild with the new name).
function parseOldFilename(oldFname) {
    if (!oldFname) return null;
    const dot = oldFname.lastIndexOf('.');
    if (dot === -1) return null;
    const base = oldFname.substring(0, dot);
    const m = base.match(/^(.+)_([0-9]{10,})$/);
    if (!m) return null;
    const withoutTs = m[1];
    const ts = m[2];

    let prefix, nameAndCompany;
    if (withoutTs.startsWith('cover_letter_')) {
        prefix = 'cover_letter';
        nameAndCompany = withoutTs.substring('cover_letter_'.length);
    } else if (withoutTs.startsWith('resume_')) {
        prefix = 'resume';
        nameAndCompany = withoutTs.substring('resume_'.length);
    } else {
        return null;
    }

    const lastUnderscore = nameAndCompany.lastIndexOf('_');
    if (lastUnderscore === -1) return null;
    const firstLast = nameAndCompany.substring(0, lastUnderscore);
    return { prefix, firstLast, ts };
}

function buildNewFilename(prefix, firstLast, companyToken, ts, idForHash) {
    let filename = `${prefix}_${firstLast}_${companyToken}_${ts}.docx`;
    let filepath = path.join(RESUMES_DIR, filename);
    if (fs.existsSync(filepath)) {
        filename = `${prefix}_${firstLast}_${companyToken}_${ts}_${shortHash(idForHash)}.docx`;
        filepath = path.join(RESUMES_DIR, filename);
    }
    return { filename, filepath };
}

(async () => {
    log(`\n=== Backfill company names (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===`);
    log(`Resumes dir: ${RESUMES_DIR}`);
    log(`Limit: ${LIMIT === null ? 'none' : LIMIT}\n`);

    await initDatabase();
    log('Database initialized.\n');

    // Pull all rows whose company_name looks like a failed extraction.
    // "Unknown", empty, or anything with non-alpha characters (junk like "LLC", "com").
    const baseSql = `
        SELECT id, profile_id, company_name, resume_filename, job_description
        FROM job_applications
        WHERE company_name IS NULL
           OR company_name = ''
           OR company_name = 'Unknown'
           OR length(company_name) > 60
           OR company_name GLOB '*[^A-Za-z0-9 &.,''-]*'
        ORDER BY id DESC
    `;
    const rows = LIMIT
        ? getAll(baseSql + ` LIMIT ?`, [LIMIT])
        : getAll(baseSql);

    log(`Found ${rows.length} row(s) to evaluate.\n`);

    let renamed = 0, updated = 0, keptUnknown = 0, errors = 0;
    const sample = [];

    for (const row of rows) {
        const oldCompany = row.company_name || '';
        let newCompany;
        try {
            newCompany = await extractCompanyName(row.job_description || '', { useLlm: !NO_LLM });
        } catch (e) {
            errors++;
            log(`[id=${row.id}] ERROR extracting: ${e.message}`);
            continue;
        }

        if (!newCompany || newCompany === 'Unknown') {
            keptUnknown++;
            if (sample.length < 5) sample.push(`[id=${row.id}] kept Unknown (old="${oldCompany}")`);
            continue;
        }

        if (newCompany === oldCompany) {
            continue; // Nothing to do.
        }

        // Compute new resume filename.
        const oldFname = row.resume_filename || '';
        const parsed = parseOldFilename(oldFname);
        let prefix = 'resume';
        let firstLast = `profile_${row.profile_id}`;
        let ts = String(Date.now());
        if (parsed) {
            prefix = parsed.prefix;
            firstLast = parsed.firstLast;
            ts = parsed.ts;
        }

        const companyToken = sanitizeForFilename(newCompany);
        const { filename: finalFname, filepath: finalPath } = buildNewFilename(prefix, firstLast, companyToken, ts, row.id);

        const oldPath = oldFname ? path.join(RESUMES_DIR, oldFname) : null;

        if (DRY_RUN) {
            log(`[id=${row.id}] would update: company "${oldCompany}" → "${newCompany}"; file "${oldFname || '(none)'}" → "${finalFname}"`);
        } else {
            let fileRenameResult = 'skipped';
            if (oldPath) {
                fileRenameResult = safeRename(oldPath, finalPath);
                if (fileRenameResult === 'renamed') {
                    renamed++;
                } else if (fileRenameResult === 'collision') {
                    // Hash-disambiguated build should have prevented this; log if it still happens.
                    log(`[id=${row.id}] rename collision: ${oldFname} → ${finalFname}`);
                } else if (fileRenameResult !== 'same' && fileRenameResult !== 'missing') {
                    log(`[id=${row.id}] resume not renamed (${fileRenameResult}): ${oldFname}`);
                }
            }

            // Only update resume_filename if the rename actually succeeded or the file
            // was already in place.
            const newResumeFilename = (fileRenameResult === 'renamed' || fileRenameResult === 'same') ? finalFname : row.resume_filename;
            runQuery(
                `UPDATE job_applications SET company_name = ?, resume_filename = ? WHERE id = ?`,
                [newCompany, newResumeFilename, row.id]
            );
            updated++;
            log(`[id=${row.id}] updated: "${oldCompany}" → "${newCompany}"; file [${fileRenameResult}] → ${newResumeFilename}`);
        }
    }

    log(`\n=== Summary ===`);
    log(`Rows evaluated:  ${rows.length}`);
    log(`DB updates:      ${updated}`);
    log(`Files renamed:   ${renamed}`);
    log(`Kept Unknown:    ${keptUnknown}`);
    log(`Errors:          ${errors}`);
    if (sample.length) {
        log(`\nKept-Unknown samples:`);
        sample.forEach(s => log('  ' + s));
    }
    if (DRY_RUN) log(`\n(DRY RUN — no changes written.)`);
})().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
