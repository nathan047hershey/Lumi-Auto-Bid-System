'use strict';
global.window = {};
require('../extension/content/controlMatch.js');
const api = global.window.__lumiControlMatch;

const cases = [
    ['No', 'Yes', 'sponsor-short', -1],
    ['No', 'No', 'sponsor-short-no', 100],
    ['No', 'Yes, I require sponsorship', 'sponsor-long', -1],
    ['No', 'No, I do not require sponsorship', 'sponsor-long-no', 99],
    ['No, I do not have a disability', 'Yes, I have a disability, or previously had a disability', 'dis', -1],
    ['No, I do not have a disability', 'No, I do not have a disability and have not had one in the past', 'dis', 99],
    ['No', 'Yes', 'former-short', -1],
    ['No', 'No', 'former-short-no', 100],
    ['No', 'Yes, I am a former employee', 'former-long', -1]
];

for (const [want, opt, tag, expectMin] of cases) {
    const score = api.scoreChoice(want, opt, '');
    const ok = expectMin < 0 ? score < 0 : score >= expectMin;
    console.log(ok ? 'OK' : 'FAIL', { tag, want: want.slice(0, 24), opt: opt.slice(0, 28), score, expectMin });
}
