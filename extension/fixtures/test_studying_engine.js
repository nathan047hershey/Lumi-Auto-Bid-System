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
        isNewQuestionType,
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
        'written unclassified → new type (Groq)',
        isNewQuestionType({ ...classifyAnswerLane({ label: 'Years of experience with React' }), type: 'text' })
    );
    check(
        'why unique → not new type (MiniMax first)',
        !isNewQuestionType({ ...classifyAnswerLane({ label: 'Why are you interested in this role?' }), type: 'textarea' })
    );
    check(
        'exotic date field → new type (Groq)',
        isNewQuestionType({ lane: 'written', kind: null, type: 'date' })
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

    const taught = await qm.teachAndCheck({
        userId: 1,
        question: 'Will you require visa sponsorship for this role?',
        answer: 'No',
        checkQuestion: 'Do you need H-1B sponsorship?',
        save: true
    });
    check('teach from course saves', taught.ok === true && taught.saved?.ok === true, taught.reason || '');
    check('teach rematch hits', taught.match?.hit === true && /no/i.test(String(taught.match?.answer || '')), taught.match?.reason || '');
    check(
        'check-again similar wording',
        taught.check_again?.hit === true || taught.check_ok === true,
        taught.check_again?.reason || ''
    );
    const updatedAll = await qm.teachAndCheck({
        userId: 1,
        question: 'Will you require visa sponsorship for this role?',
        answer: 'No',
        save: true,
        updateAll: true,
        isAdmin: true
    });
    check(
        'update all returns counts',
        updatedAll.ok === true && updatedAll.update_all
            && Number(updatedAll.update_all.memory_updated || 0) >= 1,
        JSON.stringify(updatedAll.update_all || {})
    );
    const allInOne = await qm.teachAndCheck({
        userId: 1,
        question: 'Will you require visa sponsorship for this role?',
        answer: 'No',
        checkQuestion: 'Do you need H-1B sponsorship?',
        save: true,
        updateAll: true,
        checkAllSites: true,
        isAdmin: true
    });
    check(
        'all pipeline',
        allInOne.ok === true
            && allInOne.saved?.ok === true
            && allInOne.update_all
            && allInOne.sites
            && Number.isFinite(Number(allInOne.sites.site_count)),
        JSON.stringify({
            saved: allInOne.saved?.ok,
            update: allInOne.update_all,
            sites: allInOne.sites?.site_count
        })
    );
    const sitesCheck = await qm.teachAndCheck({
        userId: 1,
        question: 'Will you require visa sponsorship for this role?',
        answer: 'No',
        save: false,
        checkAllSites: true
    });
    check(
        'check all sites shape',
        sitesCheck.ok === true
            && sitesCheck.sites
            && Number.isFinite(Number(sitesCheck.sites.site_count)),
        JSON.stringify(sitesCheck.sites || {})
    );
    const parsed = qm.parseTeachInstruction('always pick No for sponsorship');
    check(
        'parse instruct',
        /sponsor/i.test(parsed.question || '') && /no/i.test(parsed.answer || ''),
        `${parsed.question} => ${parsed.answer}`
    );

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
