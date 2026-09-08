/**
 * Unit: snap AI essays onto exact multiple-choice options.
 * Run: node extension/fixtures/test_snap_mcq_answers.js
 */
'use strict';

const path = require('path');
const { snapAnswerToOptions } = require(path.join(__dirname, '../../server/services/applicationAnswersService.js'));

const ownership = [
    'Yes — multiple systems',
    'Yes — at least one system',
    'No — I primarily contributed to parts of systems'
];
const langs = ['Golang', 'Python', 'Java', 'Ruby'];
const reliability = [
    "I've owned reliability, performance, and security concerns in production",
    "I've contributed but did not own these concerns",
    'Minimal exposure',
    'No experience'
];

const checks = [];
checks.push([
    'exact option',
    snapAnswerToOptions('Yes — multiple systems', ownership) === 'Yes — multiple systems'
]);
checks.push([
    'paraphrase ownership',
    /multiple systems/i.test(snapAnswerToOptions(
        'Yes I have owned multiple backend systems end to end in production.',
        ownership
    ))
]);
checks.push([
    'language python',
    snapAnswerToOptions('I primarily use Python in production backends.', langs) === 'Python'
]);
checks.push([
    'reliability owned',
    (() => {
        const got = snapAnswerToOptions(
            'I have owned reliability and performance in production.',
            reliability
        );
        const ok = /owned reliability/i.test(got);
        if (!ok) console.log('  got:', JSON.stringify(got));
        return ok;
    })()
]);
checks.push([
    'empty → strong yes',
    /Yes/i.test(snapAnswerToOptions('', ownership))
]);
checks.push([
    'Yes → I agree when no Yes in menu',
    snapAnswerToOptions('Yes', ['I agree', 'I do not agree']) === 'I agree'
]);
checks.push([
    'Yes with no agree/yes option → empty (never invent Yes)',
    snapAnswerToOptions('Yes', ['0', '1', '2', '3', '4', '5+']) === ''
]);
checks.push([
    'empty numeric menu → empty (not Yes)',
    snapAnswerToOptions('', ['0', '1', '2', '3']) === ''
]);
checks.push([
    'Above average → Top 25% when that is the menu',
    (() => {
        const opts = ['Top 5%', 'Top 25%', 'Average', 'Below average'];
        const got = snapAnswerToOptions('Above average', opts);
        return got === 'Top 25%' || got === 'Top 5%';
    })()
]);
checks.push([
    'I agree exact on consent menu',
    snapAnswerToOptions('I agree', ['I agree', 'I do not agree']) === 'I agree'
]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
