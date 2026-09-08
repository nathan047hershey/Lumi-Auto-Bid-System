/**
 * Studying Engine golden fixtures — lane classify + memory match (Jaccard).
 * Run from repo root: node extension/fixtures/test_studying_engine.js
 */
const path = require('path');

const root = path.resolve(__dirname, '../..');
process.chdir(root);

async function main() {
    const { initDatabase } = require('../../server/config/database');
    await initDatabase();

    const {
        classifyAnswerLane,
        textSimilarity,
        enforceUniqueAnswer,
        FIXED_CONSTANT_VALUE
    } = require('../../server/services/applicationAnswersService');
    const qm = require('../../server/services/questionMemoryService');

    const checks = [];
    function check(name, ok, detail) {
        checks.push([name, !!ok, detail || '']);
    }

    check(
        'disability → policy knockout',
        classifyAnswerLane({ label: 'Do you have a disability?' }).lane === 'policy'
            && classifyAnswerLane({ label: 'Do you have a disability?' }).knockout === true
    );
    check(
        'disability insurance → not disability policy',
        classifyAnswerLane({ label: 'Disability insurance coverage preference' }).kind !== 'disability_status'
    );
    check(
        'sponsorship → policy/profile',
        ['policy', 'profile'].includes(
            classifyAnswerLane({ label: 'Will you require visa sponsorship?' }).lane
        )
    );
    check(
        'salary comfort → policy',
        classifyAnswerLane({ label: 'Are you comfortable with the salary outlined?' }).lane === 'policy'
    );
    check(
        'salary amount → salary',
        classifyAnswerLane({ label: 'What is your expected salary?' }).lane === 'salary'
    );
    check(
        'why interested → unique',
        classifyAnswerLane({ label: 'Why are you interested in this role?' }).lane === 'unique'
    );
    check(
        'behavioral → unique behavioral',
        classifyAnswerLane({ label: 'Tell us about a time you led a project' }).unique_subtype === 'behavioral'
    );
    check(
        'skill YoE → written not profile YoE',
        classifyAnswerLane({ label: 'Years of experience with React' }).lane === 'written'
    );
    check(
        'background check → Yes constant',
        classifyAnswerLane({ label: 'Willing to undergo a background check?' }).kind === 'background_check_yes'
            && FIXED_CONSTANT_VALUE.background_check_yes === 'Yes'
    );
    check(
        'non-compete → No constant',
        classifyAnswerLane({ label: 'Are you subject to a non-compete?' }).kind === 'non_compete_no'
            && FIXED_CONSTANT_VALUE.non_compete_no === 'No'
    );

    const similar = enforceUniqueAnswer(
        'I am interested in this company because it matches my background in shipping production APIs.',
        ['I am interested in this company because it matches my background in shipping production APIs and platforms.']
    );
    check(
        'unique high sim detected',
        similar.unique_similarity >= 0.5 || similar.unique_regenerated === true
    );
    check('textSimilarity self ~1', textSimilarity('hello world foo', 'hello world foo') > 0.9);

    qm.ensureQuestionMemoryTable();
    const seed = qm.seedIfEmpty();
    check('seed loads or exists', seed.seeded > 0 || seed.existed === true);

    const hit = await qm.matchQuestion('Please indicate if you have a disability under the ADA');
    check('memory disability hit', hit.hit === true && /no/i.test(String(hit.answer || '')), hit.reason || '');

    const hard = await qm.matchQuestion('Disability insurance coverage preference');
    check(
        'hard-neg or miss on insurance',
        !hard.hit || hard.kind !== 'disability_status',
        hard.reason || hard.kind || ''
    );

    const why = await qm.matchQuestion('Why are you interested in this role at Acme?');
    check('why-us not policy memory', !why.hit, why.kind || why.reason || '');

    const upsert = qm.upsertMemory({
        userId: 1,
        kind: 'requires_sponsorship',
        questionText: 'Will you need H-1B sponsorship for this position?',
        answerText: 'No',
        source: 'instruct'
    });
    check('upsert sponsorship', upsert.ok === true);

    const essayReject = qm.upsertMemory({
        userId: 1,
        kind: 'disability_status',
        questionText: 'Why are you interested in this role?',
        answerText: 'A'.repeat(200),
        source: 'instruct'
    });
    check('reject essay upsert', essayReject.ok === false);

    let failed = 0;
    for (const [name, ok, detail] of checks) {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
        if (!ok) failed += 1;
    }
    console.log(`\n${checks.length - failed}/${checks.length} passed`);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
