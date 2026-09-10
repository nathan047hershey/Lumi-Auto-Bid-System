/**
 * Regression: YoE must pick 10+ for seniors; disability No; answer reuse; Yes≠5+.
 * Run: node extension/fixtures/test_yoe_disability_reuse.js
 */
'use strict';

const path = require('path');
const {
    snapAnswerToOptions
} = require(path.join(__dirname, '../../server/services/applicationAnswersService.js'));
const brain = require(path.join(__dirname, '../../server/services/bidderBrainService.js'));

const yoeOpts = [
    '0-2 years of relevant professional experience',
    '2-4 years of relevant professional experience',
    '5-8 years of relevant professional experience',
    '8-10 years of relevant professional experience',
    '10+ years of relevant professional experience'
];
const disOpts = [
    'Yes, I have a disability, or have had one in the past',
    'No, I do not have a disability and have not had one in the past',
    'I do not want to answer'
];

const checks = [];
checks.push(['18 → 10+', /10\+/.test(snapAnswerToOptions('18', yoeOpts))]);
checks.push(['15 → 10+', /10\+/.test(snapAnswerToOptions('15', yoeOpts))]);
checks.push(['10+ years → 10+', /10\+/.test(snapAnswerToOptions('10+ years', yoeOpts))]);
checks.push(['empty YoE not 0-2', snapAnswerToOptions('', yoeOpts) === '']);
checks.push([
    'disability No',
    /^no\b/i.test(snapAnswerToOptions('No, I do not have a disability', disOpts))
]);
checks.push([
    'empty disability → No',
    /^no\b|do not have/i.test(snapAnswerToOptions('', disOpts))
]);
checks.push([
    'Yes on employer count → empty',
    snapAnswerToOptions('Yes', ['0', '1', '2', '3', '4', '5+']) === ''
]);
checks.push([
    'empty employer count → empty',
    snapAnswerToOptions('', ['0', '1', '2', '3']) === ''
]);

const saved = [
    { id: 'a', label: 'How many years?*', answer: '10+ years of relevant professional experience' },
    { id: 'd', label: 'Disability Status', answer: 'No, I do not have a disability and have not had one in the past' }
];
const qs = [
    { id: 'a', label: 'How many years of relevant professional experience do you have?*' },
    { id: 'd', label: 'Disability Status' },
    { id: 'n', label: 'Do you have Helm experience?' }
];
const mapped = brain.mapSavedAnswersToQuestions(saved, qs);
checks.push(['reuse hits 2', mapped.reused.length === 2]);
checks.push(['reuse misses 1', mapped.missing.length === 1 && mapped.missing[0].id === 'n']);
checks.push(['reuse YoE text', /10\+/.test(mapped.reused.find((a) => a.id === 'a')?.answer || '')]);
checks.push(['reuse disability No', /^no\b/i.test(mapped.reused.find((a) => a.id === 'd')?.answer || '')]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`\nAll ${checks.length} yoe/disability/reuse checks passed.`);
