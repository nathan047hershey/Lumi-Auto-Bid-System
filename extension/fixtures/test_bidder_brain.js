/**
 * Unit checks for bidder brain (loads real sqlite via initDatabase).
 * Run: node extension/fixtures/test_bidder_brain.js
 */
const path = require('path');

async function main() {
    const { initDatabase } = require(path.join(__dirname, '../../server/config/database'));
    await initDatabase();
    const brain = require(path.join(__dirname, '../../server/services/bidderBrainService'));

    const checks = [];

    checks.push(['engine version', brain.ENGINE_VERSION === 'bidder-engine-v1.1']);

    const qaOk = brain.assessCvQuality({
        draftHtml: 'python react node engineer experience '.repeat(40),
        jobDescription: 'We need a python react node engineer',
        resumeFilename: 'cv.docx'
    });
    checks.push(['cv qa ok when keywords present', qaOk.ok === true]);

    const qaBad = brain.assessCvQuality({
        draftHtml: 'hello',
        jobDescription: 'python react typescript kubernetes',
        resumeFilename: ''
    });
    checks.push(['cv qa fails short+missing file', qaBad.shouldRegenerate === true]);

    const extras = brain.buildBidderPromptExtras({
        jobDescription: 'Looking for React and Python experts at a startup',
        resumeHtml: 'Worked at Acme Corp with React',
        workExperience: 'Acme Corp',
        companyName: 'TestCo',
        jobRole: 'Engineer'
    });
    checks.push(['extras has rules', /BIDDER ENGINE RULES/i.test(extras.extrasBlock)]);
    checks.push(['keywords extracted', extras.keywords.length > 0]);

    brain.ensureFieldAttemptTable();
    brain.logFieldAttempt({
        application_id: 1,
        field_id: 'email',
        field_label: 'Email',
        wanted: 'a@b.com',
        chosen: 'a@b.com',
        ok: true,
        strategy: 'native',
        attempt_n: 1
    });
    const attempts = brain.listFieldAttempts(1, 5);
    checks.push(['field attempt logged', attempts.length >= 1]);

    const failed = checks.filter(([, ok]) => !ok);
    for (const [name, ok] of checks) {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    }
    if (failed.length) {
        process.exit(1);
    }
    console.log(`\nAll ${checks.length} bidder-brain checks passed.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
