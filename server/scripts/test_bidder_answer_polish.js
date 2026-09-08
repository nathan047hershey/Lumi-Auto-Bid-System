/**
 * Smoke tests for bidder answer polish + compound-question detection.
 * Run: node server/scripts/test_bidder_answer_polish.js
 */
'use strict';

const {
    polishWrittenAnswer,
    looksLikeCompoundQuestion
} = require('../services/applicationAnswersService');

let failed = 0;
function assert(cond, msg) {
    if (!cond) {
        failed += 1;
        console.error('FAIL:', msg);
    } else {
        console.log('ok:', msg);
    }
}

assert(
    looksLikeCompoundQuestion('Do you have Kubernetes experience? If yes, please describe.'),
    'detects If yes compound'
);
assert(
    looksLikeCompoundQuestion('Why this role, and what would you bring?'),
    'detects and + what compound'
);
assert(
    !looksLikeCompoundQuestion('Are you authorized to work in the United States?'),
    'simple binary is not compound'
);

const cleaned = polishWrittenAnswer(
    'I am drawn to your mission because the reliability work matches my background.',
    { companyName: 'Acme', jobRole: 'SRE', shortForm: true }
);
assert(!/^I am drawn/i.test(cleaned), 'strips AI opener');
assert(cleaned.length > 10, 'keeps substance after opener strip');

const long = polishWrittenAnswer(
    'First sentence about tooling. Second sentence about the JD. Third sentence of padding. Fourth more padding.',
    { shortForm: true }
);
const sentenceCount = long.split(/(?<=[.!?])\s+/).filter(Boolean).length;
assert(sentenceCount <= 2, `shortForm collapses to <=2 sentences (got ${sentenceCount})`);

if (failed) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
}
console.log('\nAll polish smoke tests passed');
