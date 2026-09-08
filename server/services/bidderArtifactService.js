/**
 * Persist bid-course packages under DATA_ROOT/bidder (default <repo>/database/bidder).
 */
const fs = require('fs');
const path = require('path');
const { BIDDER_DIR } = require('../config/paths');

const DEFAULT_ROOT = BIDDER_DIR;
const FALLBACK_ROOT = path.join(__dirname, '..', 'uploads', 'bidder');

function resolveRoot() {
    const preferred = process.env.BIDDER_ARTIFACT_ROOT
        ? String(process.env.BIDDER_ARTIFACT_ROOT).trim()
        : BIDDER_DIR;
    try {
        if (!fs.existsSync(preferred)) {
            fs.mkdirSync(preferred, { recursive: true });
        }
        const probe = path.join(preferred, '.write_test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return { root: preferred, fallback: false };
    } catch (err) {
        console.warn('[bidderArtifact] preferred root unavailable, using fallback:', err.message);
        if (!fs.existsSync(FALLBACK_ROOT)) {
            fs.mkdirSync(FALLBACK_ROOT, { recursive: true });
        }
        return { root: FALLBACK_ROOT, fallback: true };
    }
}

function courseDir(applicationId) {
    const { root, fallback } = resolveRoot();
    const dir = path.join(root, String(applicationId));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const shots = path.join(dir, 'screenshots');
    if (!fs.existsSync(shots)) fs.mkdirSync(shots, { recursive: true });
    const cv = path.join(dir, 'cv');
    if (!fs.existsSync(cv)) fs.mkdirSync(cv, { recursive: true });
    return { dir, shots, cv, root, fallback };
}

function writeText(applicationId, filename, content) {
    const { dir, fallback } = courseDir(applicationId);
    const fp = path.join(dir, filename);
    fs.writeFileSync(fp, content == null ? '' : String(content), 'utf8');
    return { path: fp, fallback };
}

function writeJson(applicationId, filename, obj) {
    return writeText(applicationId, filename, JSON.stringify(obj, null, 2));
}

function saveScreenshot(applicationId, stage, base64OrBuffer) {
    const { shots, fallback } = courseDir(applicationId);
    const safe = String(stage || 'shot').replace(/[^\w.-]+/g, '_').slice(0, 64);
    const fp = path.join(shots, `${safe}.png`);
    let buf;
    if (Buffer.isBuffer(base64OrBuffer)) {
        buf = base64OrBuffer;
    } else {
        let b64 = String(base64OrBuffer || '');
        const m = b64.match(/^data:image\/\w+;base64,(.+)$/);
        if (m) b64 = m[1];
        buf = Buffer.from(b64, 'base64');
    }
    fs.writeFileSync(fp, buf);
    return { path: fp, relative: `screenshots/${safe}.png`, fallback };
}

function copyResume(applicationId, resumeFilename, resumesDir) {
    if (!resumeFilename) return null;
    const { cv, fallback } = courseDir(applicationId);
    const src = path.join(resumesDir, path.basename(resumeFilename));
    if (!fs.existsSync(src)) return { error: 'resume_missing', fallback };
    const dest = path.join(cv, path.basename(resumeFilename));
    fs.copyFileSync(src, dest);
    return { path: dest, relative: `cv/${path.basename(resumeFilename)}`, fallback };
}

function saveCoursePackage(applicationId, {
    jd,
    answers,
    meta,
    resumeFilename,
    resumesDir
} = {}) {
    const { dir, fallback } = courseDir(applicationId);
    if (jd != null) writeText(applicationId, 'jd.txt', jd);
    if (answers != null) writeJson(applicationId, 'answers.json', answers);
    if (meta != null) writeJson(applicationId, 'meta.json', meta);
    let cvCopy = null;
    if (resumeFilename && resumesDir) {
        cvCopy = copyResume(applicationId, resumeFilename, resumesDir);
    }
    return { dir, fallback, cvCopy };
}

function listScreenshots(applicationId) {
    try {
        const { shots } = courseDir(applicationId);
        return fs.readdirSync(shots)
            .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
            .map((f) => ({
                stage: f.replace(/\.[^.]+$/, ''),
                filename: f,
                absolute: path.join(shots, f)
            }));
    } catch {
        return [];
    }
}

function readScreenshotFile(applicationId, filename) {
    const safe = path.basename(filename);
    const roots = [];
    try {
        const { root } = resolveRoot();
        roots.push(root);
    } catch (_) { /* ignore */ }
    roots.push(DEFAULT_ROOT, FALLBACK_ROOT);
    const seen = new Set();
    for (const root of roots) {
        if (!root || seen.has(root)) continue;
        seen.add(root);
        const fp = path.join(root, String(applicationId), 'screenshots', safe);
        if (fs.existsSync(fp)) return fp;
    }
    return null;
}

module.exports = {
    resolveRoot,
    courseDir,
    writeText,
    writeJson,
    saveScreenshot,
    copyResume,
    saveCoursePackage,
    listScreenshots,
    readScreenshotFile,
    DEFAULT_ROOT,
    FALLBACK_ROOT
};
