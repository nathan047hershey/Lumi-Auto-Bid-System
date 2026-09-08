/**
 * Apply-gate unit checks.
 * Run: node extension/fixtures/test_apply_gate.js
 */
'use strict';

async function main() {
    const mod = await import('../lib/applyGate.js');
    const {
        isApplyButtonLabel,
        scoreApplyLabel,
        looksLikeCreateAccountPage,
        generateAtsPassword,
        upsertApplyLesson,
        lessonsForHost
    } = mod;

    const checks = [];
    checks.push(['Apply', isApplyButtonLabel('Apply') === true]);
    checks.push(['Apply now', isApplyButtonLabel('Apply now') === true]);
    checks.push(['Apply for this job', isApplyButtonLabel('Apply for this job') === true]);
    checks.push(['Apply for this job online', isApplyButtonLabel('Apply for this job online') === true]);
    checks.push(['Apply online', isApplyButtonLabel('Apply online') === true]);
    checks.push(['Start application', isApplyButtonLabel('Start application') === true]);
    checks.push(['Withdraw reject', isApplyButtonLabel('Withdraw application') === false]);
    checks.push(['Sign in reject', isApplyButtonLabel('Sign in') === false]);
    checks.push(['online scores highest', scoreApplyLabel('Apply for this job online') > scoreApplyLabel('Apply')]);

    checks.push(['create account page', looksLikeCreateAccountPage('Create an account to apply. Set a password.') === true]);
    checks.push(['jd not create account', looksLikeCreateAccountPage('Apply for this job online Responsibilities') === false]);

    const pw = generateAtsPassword('boards.greenhouse.io');
    checks.push(['password has upper', /[A-Z]/.test(pw)]);
    checks.push(['password has digit', /\d/.test(pw)]);
    checks.push(['password has symbol', /[!@$%*]/.test(pw)]);

    let lessons = [];
    lessons = upsertApplyLesson(lessons, {
        host: 'boards.greenhouse.io',
        label: 'Apply for this job online',
        selector: 'a#apply_button',
        outcome: 'form_ok'
    });
    lessons = upsertApplyLesson(lessons, {
        host: 'boards.greenhouse.io',
        label: 'Apply for this job online',
        selector: 'a#apply_button',
        outcome: 'form_ok'
    });
    const gh = lessonsForHost(lessons, 'www.boards.greenhouse.io');
    checks.push(['lesson stored', gh.length === 1]);
    checks.push(['lesson hits 2', gh[0].hits === 2]);

    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
        if (!ok) failed += 1;
    }
    if (failed) {
        console.error(`\n${failed} failed`);
        process.exit(1);
    }
    console.log(`\nAll ${checks.length} apply-gate checks passed.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
