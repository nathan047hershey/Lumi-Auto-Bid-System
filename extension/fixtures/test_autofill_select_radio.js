'use strict';
/**
 * Select / radio / checkbox matching — mirrors extension/content/controlMatch.js
 * (Simplify / JobWizard patterns: negation-aware consent, short Yes/No, label preference).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
    path.join(__dirname, '../content/controlMatch.js'),
    'utf8'
);
const sandbox = { window: {}, document: { querySelector: () => null } };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const cm = sandbox.window.__lumiControlMatch;
assert.ok(cm, 'controlMatch must export window.__lumiControlMatch');

const consentYes = 'I consent to my interview recording being used for candidate evaluation.';
const consentNo = 'I do not consent to my interview recording being used for candidate evaluation.';

// Negation gate — the critical Simplify/JobWizard rule
assert.ok(cm.scoreChoice('Yes', consentYes) >= 90, 'Yes → consent');
assert.ok(cm.scoreChoice('Yes', consentNo) < 0, 'Yes must NOT pick do-not-consent');
assert.ok(cm.scoreChoice('No', consentNo) >= 90, 'No → do-not-consent');
assert.ok(cm.scoreChoice('No', consentYes) < 0 || cm.scoreChoice('No', consentYes) < 70, 'No must not prefer consent');

// Short Yes/No
assert.ok(cm.scoreChoice('Yes', 'Yes') >= 90);
assert.ok(cm.scoreChoice('No', 'No') >= 90);
assert.ok(cm.scoreChoice('No', 'None of the above') < 70);

// Prefer bare Yes over long Yes,…
assert.ok(
    cm.scoreChoice('Yes', 'Yes') >= cm.scoreChoice('Yes', 'Yes, I will require sponsorship'),
    'bare Yes preferred over long Yes'
);

// Long LLM answer → Yes/No polarity
assert.equal(cm.canonicalizeWant('I am legally authorized to work in the United States.'), 'Yes');
assert.equal(cm.canonicalizeWant('I do not require visa sponsorship now or in the future.'), 'No');
assert.ok(cm.scoreChoice(
    'I am legally authorized to work in the United States.',
    'Yes'
) >= 90, 'long auth → Yes');
assert.ok(cm.scoreChoice(
    'I will not need sponsorship for this role.',
    'No'
) >= 90, 'long no-sponsor → No');

// Native select match
const opts = [
    { text: 'Select...', value: '' },
    { text: 'Yes', value: '1' },
    { text: 'No', value: '0' },
    { text: 'Male', value: 'male' },
    { text: 'California', value: 'CA' },
    { text: consentYes, value: 'consent' },
    { text: consentNo, value: 'no_consent' }
];
assert.equal(cm.matchNativeOption(opts, 'Yes')?.text, 'Yes');
assert.equal(cm.matchNativeOption(opts, 'no')?.text, 'No');
assert.equal(cm.matchNativeOption(opts, 'Male')?.value, 'male');
assert.ok(!cm.isPlaceholderOption('Yes', '1'));
assert.ok(cm.isPlaceholderOption('Select...', ''));
const consentOnly = opts.filter((o) => /consent/i.test(o.text));
assert.equal(cm.matchNativeOption(consentOnly, 'Yes')?.value, 'consent');
assert.equal(cm.matchNativeOption(consentOnly, 'No')?.value, 'no_consent');
assert.equal(cm.matchNativeOption(consentOnly, 'I consent')?.value, 'consent');

// Prefer short Yes when long Yes also present
const yesNoise = [
    { text: 'Select...', value: '' },
    { text: 'Yes, I will require sponsorship for an employment visa', value: 'yes_long' },
    { text: 'Yes', value: 'yes' },
    { text: 'No', value: 'no' }
];
assert.equal(cm.matchNativeOption(yesNoise, 'Yes')?.value, 'yes');

// YoE band
assert.ok(cm.scoreChoice('10+ years', '10+ years') >= 90);
assert.ok(cm.scoreChoice('18', '10+') >= 85 || cm.scoreChoice('18', '10+ years') >= 85);

// Checkbox consent default ON
assert.equal(cm.wantCheckboxOn('', 'I agree to the terms'), true);
assert.equal(cm.wantCheckboxOn('No', 'I agree to the terms'), false);
assert.equal(cm.wantCheckboxOn('Yes', 'Newsletter'), true);
// Sponsorship checkbox OFF when No
assert.equal(cm.wantCheckboxOn('No', 'I require visa sponsorship'), false);
assert.equal(cm.wantCheckboxOn('Yes', 'I require visa sponsorship'), true);

// Gender synonym
assert.ok(cm.scoreChoice('Man', 'Male') >= 90);

/** Human select flow contract (open → see → match → choose). */
function humanSelectSteps() {
    return ['click_open', 'read_options', 'find_match', 'click_option', 'verify'];
}
assert.deepStrictEqual(humanSelectSteps(), [
    'click_open', 'read_options', 'find_match', 'click_option', 'verify'
]);
assert.ok(!humanSelectSteps().includes('set_value_blindly'));

assert.ok(cm.scoreChoice('Yes', 'I understand') >= 90, 'Yes → I understand');
assert.ok(cm.wantCheckboxOn('Yes', 'Do you consent … I understand'), 'consent understand on');
assert.ok(cm.wantCheckboxOn('', 'I understand SMS consent'), 'empty want + understand → on');

assert.ok(
    cm.scoreChoice('No, I do not have a disability', 'No, I do not have a disability') >= 90,
    'disability no exact'
);
assert.ok(
    cm.scoreChoice(
        'No, I do not have a disability',
        'Yes, I have a disability, or have had one in the past'
    ) < 0,
    'disability No must NEVER pick Yes (substring trap)'
);
assert.ok(
    cm.scoreChoice(
        'No, I do not have a disability',
        "No, I don't have a disability, and have not had one in the past"
    ) >= 90,
    'disability No matches Greenhouse long No'
);
assert.ok(
    cm.scoreChoice('I am not a protected veteran', 'I am not a protected veteran') >= 90,
    'veteran no exact'
);
assert.ok(
    cm.scoreChoice('Black or African American', 'Black or African American (Not Hispanic or Latino)') >= 90,
    'race black synonym'
);
assert.ok(
    cm.scoreChoice('Asian', 'Asian (Not Hispanic or Latino)') >= 90,
    'race asian synonym'
);

console.log('PASS controlMatch select/radio/checkbox (Simplify/JobWizard patterns)');
