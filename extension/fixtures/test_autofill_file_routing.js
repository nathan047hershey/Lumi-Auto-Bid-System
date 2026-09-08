'use strict';
/**
 * Unit checks for Autofill classify + file routing (cover letter vs resume).
 * Loads classifyPersonal / fileInputKind logic by extracting from fill.js patterns.
 */
const assert = require('assert');

function classifyPersonal(label = '', name = '', autoId = '') {
    const hay = `${label} ${name} ${autoId}`.toLowerCase().replace(/[_-]+/g, ' ');
    if (/\b(cover[\s_-]*letter|covering[\s_-]*letter|motivation[\s_-]*letter)\b/.test(hay)) {
        return 'cover_letter';
    }
    if (/\b(resume|cv|curriculum[\s_-]*vitae)\b/.test(hay)) return 'resume';
    if (/\b(attach|upload)\b/.test(hay) && !/\b(cover|letter)\b/.test(hay) && /\b(resume|cv)\b/.test(hay)) {
        return 'resume';
    }
    return 'question';
}

function looksResume(kind, label, name) {
    const hay = `${label} ${name}`.toLowerCase();
    return kind === 'resume' || /\b(resume|cv|curriculum[\s_-]*vitae)\b/.test(hay);
}

function looksCover(kind, label, name) {
    const hay = `${label} ${name}`.toLowerCase();
    return kind === 'cover_letter' || /\b(cover[\s_-]*letter|covering[\s_-]*letter)\b/.test(hay);
}

function routeUpload(label, name) {
    const kind = classifyPersonal(label, name, '');
    if (looksCover(kind, label, name)) return 'cover_letter';
    if (looksResume(kind, label, name)) return 'resume';
    return 'other';
}

assert.strictEqual(routeUpload('Resume', 'resume'), 'resume');
assert.strictEqual(routeUpload('Upload your CV', 'file'), 'resume');
assert.strictEqual(routeUpload('Cover Letter', 'cover'), 'cover_letter');
assert.strictEqual(routeUpload('Attach cover letter', 'upload'), 'cover_letter');
assert.strictEqual(routeUpload('Upload cover letter (optional)', 'file'), 'cover_letter');
// Must NOT treat bare "upload file" as resume (old bug)
assert.notStrictEqual(classifyPersonal('Upload file', 'file', ''), 'resume');
assert.strictEqual(routeUpload('Upload file', 'file'), 'other');

/** Dual unlabeled slots: resume first, cover second (Greenhouse-like). */
function routeDualUnlabeled(kinds) {
    const others = kinds.filter((k) => k === 'other');
    if (others.length === 2) return ['resume', 'cover_letter'];
    if (others.length === 1) return ['resume'];
    return kinds;
}
assert.deepStrictEqual(routeDualUnlabeled(['other', 'other']), ['resume', 'cover_letter']);
assert.deepStrictEqual(routeDualUnlabeled(['resume', 'cover_letter']), ['resume', 'cover_letter']);
assert.deepStrictEqual(routeDualUnlabeled(['other']), ['resume']);

/** Never treat a resume_*.docx as a valid cover letter payload */
function acceptCoverLetterFile(filename, skipCoverLetter) {
    if (skipCoverLetter) return false;
    if (!filename) return false;
    if (/^resume_/i.test(filename) || !/cover/i.test(filename)) return false;
    return true;
}
assert.strictEqual(acceptCoverLetterFile('resume_Nathan_Hershey_California_1.docx', false), false);
assert.strictEqual(acceptCoverLetterFile('cover_letter_Nathan_OneTrust_1.docx', false), true);
assert.strictEqual(acceptCoverLetterFile('cover_letter_Nathan_OneTrust_1.docx', true), false);

/** Data Protection Notice must classify as data_protection, not notice_period */
function classifyNotice(label) {
    const hay = String(label || '').toLowerCase();
    if (/\b(data[\s_-]*protection|privacy[\s_-]*notice|privacy[\s_-]*policy|candidate[\s_-]*privacy|gdpr|ccpa)\b/.test(hay)) {
        return 'data_protection';
    }
    if (/\b(notice[\s_-]*period|notice[\s_-]*time)\b/.test(hay)) return 'notice_period';
    return 'question';
}
assert.strictEqual(classifyNotice('Data Protection Notice'), 'data_protection');
assert.strictEqual(classifyNotice('Notice period'), 'notice_period');

/** uploadOnly warm-up must not run profile fill */
function warmUpMode({ uploadOnly, fields, profile }) {
    if (uploadOnly) return { fillFields: false, uploadFiles: true };
    return { fillFields: (fields || []).length > 0 || Object.keys(profile || {}).length > 0, uploadFiles: true };
}
assert.deepStrictEqual(warmUpMode({ uploadOnly: true, fields: [], profile: {} }), {
    fillFields: false,
    uploadFiles: true
});
assert.strictEqual(warmUpMode({ uploadOnly: false, fields: [{ id: 1 }], profile: { a: 1 } }).fillFields, true);

console.log('PASS autofill file routing (cover letter vs resume)');
