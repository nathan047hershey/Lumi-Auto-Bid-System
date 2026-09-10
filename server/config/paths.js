/**
 * Central data paths — DB / resumes / bidder artifacts travel with the repo.
 *
 * Default: <repo-root>/database
 *   (repo-root = folder that contains server/, client/, extension/, database/)
 *
 * Optional override in server/local.env (prefer relative — portable to any PC):
 *   LUMI_DATA_ROOT=database
 *
 * Do not hardcode drive letters or a specific folder name — copy the whole
 * repo root anywhere and paths still resolve from this tree.
 */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const PROJECT_ROOT = path.join(SERVER_DIR, '..');
const DEFAULT_DATA_ROOT = path.join(PROJECT_ROOT, 'database');
const LEGACY_DB = path.join(SERVER_DIR, 'database.sqlite');
const LEGACY_RESUMES = path.join(SERVER_DIR, 'resumes');
/** Old standalone folder (this machine only). Used for one-time migrate, never as live root. */
const LEGACY_STANDALONE = 'E:\\database';

function tryEnsureDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.write_test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (_) {
        return false;
    }
}

/** Resolve LUMI_DATA_ROOT: absolute as-is; relative → under project root. */
function resolveConfiguredRoot(raw) {
    const trimmed = String(raw || '').trim().replace(/^["']|["']$/g, '');
    if (!trimmed) return null;
    if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
    return path.normalize(path.join(PROJECT_ROOT, trimmed));
}

function resolveDataRoot() {
    const fromEnv = resolveConfiguredRoot(
        process.env.LUMI_DATA_ROOT || process.env.JOB_APPLY_DATA_ROOT || ''
    );
    const candidates = [
        fromEnv,
        DEFAULT_DATA_ROOT,
        path.join(SERVER_DIR, 'data')
    ].filter(Boolean);

    for (const root of candidates) {
        if (tryEnsureDir(root)) {
            return root;
        }
    }
    return SERVER_DIR;
}

const DATA_ROOT = resolveDataRoot();
const DB_PATH = path.join(DATA_ROOT, 'database.sqlite');
const RESUMES_DIR = path.join(DATA_ROOT, 'resumes');
/** Clean upload copies: First_Last.docx (overwritten per profile on generate). */
const RESUMES_READY_DIR = path.join(RESUMES_DIR, 'ready');
/** Per-download unique folders: Company__FullName__Title__time/First_Last.docx */
const RESUMES_PACKAGES_DIR = path.join(RESUMES_DIR, 'packages');
const BIDDER_DIR = path.join(DATA_ROOT, 'bidder');
const TMP_DIR = path.join(DATA_ROOT, 'tmp');

for (const dir of [RESUMES_DIR, RESUMES_READY_DIR, RESUMES_PACKAGES_DIR, BIDDER_DIR, TMP_DIR]) {
    tryEnsureDir(dir);
}

function pickRicherDb(currentPath, candidatePath) {
    if (!fs.existsSync(candidatePath)) return false;
    if (!fs.existsSync(currentPath)) {
        fs.copyFileSync(candidatePath, currentPath);
        return true;
    }
    try {
        const curSize = fs.statSync(currentPath).size;
        const srcSize = fs.statSync(candidatePath).size;
        if (srcSize > curSize * 2 && curSize < 512 * 1024) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backup = `${currentPath}.empty-backup-${stamp}`;
            fs.copyFileSync(currentPath, backup);
            fs.copyFileSync(candidatePath, currentPath);
            console.log('[paths] Restored populated DB from', candidatePath, '(empty backup →', backup + ')');
            return true;
        }
    } catch (inner) {
        console.warn('[paths] richer-db check skipped:', inner.message);
    }
    return false;
}

/** One-time copy from old locations into portable DATA_ROOT. */
function migrateLegacyIfNeeded() {
    try {
        const legacyDataDirDb = path.join(SERVER_DIR, 'data', 'database.sqlite');
        const standaloneDb = path.join(LEGACY_STANDALONE, 'database.sqlite');
        const sources = [LEGACY_DB, legacyDataDirDb, standaloneDb].filter((p) => fs.existsSync(p));

        if (!fs.existsSync(DB_PATH) && sources.length) {
            fs.copyFileSync(sources[0], DB_PATH);
            console.log('[paths] Migrated database.sqlite →', DB_PATH);
        } else {
            for (const src of sources) {
                if (pickRicherDb(DB_PATH, src)) break;
            }
        }

        const resumeSources = [LEGACY_RESUMES, path.join(LEGACY_STANDALONE, 'resumes')]
            .filter((d) => fs.existsSync(d));
        if (resumeSources.length && tryEnsureDir(RESUMES_DIR)) {
            let n = 0;
            for (const srcDir of resumeSources) {
                for (const name of fs.readdirSync(srcDir)) {
                    const src = path.join(srcDir, name);
                    const dest = path.join(RESUMES_DIR, name);
                    if (!fs.statSync(src).isFile()) continue;
                    if (fs.existsSync(dest)) continue;
                    fs.copyFileSync(src, dest);
                    n += 1;
                }
            }
            if (n) console.log(`[paths] Migrated ${n} resume file(s) →`, RESUMES_DIR);
        }
    } catch (err) {
        console.warn('[paths] legacy migrate skipped:', err.message);
    }
}

migrateLegacyIfNeeded();

console.log('[paths] DATA_ROOT =', DATA_ROOT);
console.log('[paths] DB_PATH   =', DB_PATH);

module.exports = {
    DATA_ROOT,
    DB_PATH,
    RESUMES_DIR,
    RESUMES_READY_DIR,
    RESUMES_PACKAGES_DIR,
    BIDDER_DIR,
    TMP_DIR,
    SERVER_DIR,
    PROJECT_ROOT,
    DEFAULT_DATA_ROOT,
    /** @deprecated use DEFAULT_DATA_ROOT */
    DEFAULT_E_ROOT: DEFAULT_DATA_ROOT
};
