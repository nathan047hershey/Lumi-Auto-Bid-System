/**
 * Location waive + "authorized without sponsorship" polarity.
 * Run: node extension/fixtures/test_location_waive_and_auth.js
 */

function isLocationSubmitWaived(_el, label = '', nearby = '') {
    const blob = `${label} ${nearby}`.toLowerCase();
    return /location service is temporarily unavailable/.test(blob)
        || /you can submit(?:\s+\w+){0,6}\s+without\s+a\s+location/.test(blob)
        || /submit your application without a location/.test(blob)
        || (/without a location\b/.test(blob) && /unavailable|optional|not required|skip/.test(blob));
}

function labelLooksLikeAuthorizedWithoutSponsorship(label) {
    const lab = String(label || '').toLowerCase();
    return /\b(authorized|authorised|eligible)\b/.test(lab)
        && /\bwithout\s+(?:visa\s+)?sponsorship\b/.test(lab);
}

function labelLooksLikeSponsorship(label) {
    if (labelLooksLikeAuthorizedWithoutSponsorship(label)) return false;
    const lab = String(label || '').toLowerCase();
    return /\b(sponsor|sponsorship|visa[\s_-]*support|require.*visa|need.*visa|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/.test(lab)
        || /\bwill you.{0,60}\b(require|need).{0,40}\b(sponsor|visa)\b/.test(lab);
}

function answerForLabel(label, profile) {
    if (labelLooksLikeAuthorizedWithoutSponsorship(label)) {
        const raw = String(profile?.work_authorization || '').trim();
        if (/^(no|n)\b/i.test(raw) || /not authorized|unauthorized/i.test(raw)) return 'No';
        return 'Yes';
    }
    if (labelLooksLikeSponsorship(label)) {
        const raw = String(profile?.requires_sponsorship || '').trim();
        if (/^(yes|y|true|1)$/i.test(raw)) return 'Yes';
        return 'No';
    }
    return '';
}

const checks = [];

checks.push([
    'location waive message',
    isLocationSubmitWaived(
        null,
        'Location (City) *',
        'Our location service is temporarily unavailable. You can submit your application without a location.'
    ) === true
]);

checks.push([
    'location without waive stays required',
    isLocationSubmitWaived(null, 'Location (City) *', 'Enter your city') === false
]);

const authQ = 'Are you legally authorized to work in the United States without sponsorship?*';
checks.push(['auth without sponsor detects', labelLooksLikeAuthorizedWithoutSponsorship(authQ) === true]);
checks.push(['auth without sponsor not sponsorship label', labelLooksLikeSponsorship(authQ) === false]);
checks.push([
    'auth without sponsor → Yes',
    answerForLabel(authQ, { work_authorization: 'Yes', requires_sponsorship: 'No' }) === 'Yes'
]);
checks.push([
    'need sponsorship still No',
    answerForLabel('Will you require visa sponsorship?*', { requires_sponsorship: 'No' }) === 'No'
]);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} location/auth checks passed.`);
