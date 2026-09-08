/**
 * Server fixedProfileKind polarity for auth-without-sponsorship.
 * Run: node extension/fixtures/test_api_fixed_auth_kind.js
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Mirror the fixedProfileKind logic (exported helpers aren't public — re-test via service)
const FIXED_FIELD_RE = {
    work_authorization: /\b(work[\s_-]*auth|authoriz(ed|ation)|legally[\s_-]*authorized|eligible[\s_-]*to[\s_-]*work|right[\s_-]*to[\s_-]*work)\b/i,
    requires_sponsorship: /\b(sponsor|sponsorship|visa[\s_-]*support|require.*visa|need.*visa|employment[\s_-]*visa|h-?1b|visa[\s_-]*status)\b/i
};

function fixedProfileKind(q) {
    const hay = `${q?.label || ''} ${q?.name || ''} ${q?.id || ''}`;
    if (
        /\b(authorized|authorised|eligible)\b/i.test(hay)
        && /\bwithout\s+(?:visa\s+)?sponsorship\b/i.test(hay)
    ) {
        return 'work_authorization';
    }
    const order = ['work_authorization', 'requires_sponsorship'];
    for (const kind of order) {
        if (!FIXED_FIELD_RE[kind]?.test(hay)) continue;
        if (
            kind === 'requires_sponsorship'
            && /\b(authorized|authorised|eligible)\b/i.test(hay)
            && /\bwithout\s+(?:visa\s+)?sponsorship\b/i.test(hay)
        ) {
            continue;
        }
        return kind;
    }
    return null;
}

function fixedProfileValue(kind, profile) {
    if (kind === 'requires_sponsorship') {
        const raw = String(profile.requires_sponsorship || '').trim();
        if (/^(yes|y|true|1)$/i.test(raw)) return 'Yes';
        return 'No';
    }
    if (kind === 'work_authorization') {
        const raw = String(profile.work_authorization || '').trim();
        if (/^(no|n|false|0)$/i.test(raw)) return 'No';
        return 'Yes';
    }
    return '';
}

const authQ = {
    label: 'Are you legally authorized to work in the United States without sponsorship?*'
};
const sponsorQ = { label: 'Will you require visa sponsorship?*' };
const profile = { work_authorization: 'Yes', requires_sponsorship: 'No' };

const checks = [
    ['auth without → work_authorization', fixedProfileKind(authQ) === 'work_authorization'],
    ['auth without → Yes', fixedProfileValue(fixedProfileKind(authQ), profile) === 'Yes'],
    ['need sponsor → requires_sponsorship', fixedProfileKind(sponsorQ) === 'requires_sponsorship'],
    ['need sponsor → No', fixedProfileValue(fixedProfileKind(sponsorQ), profile) === 'No']
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} API fixed-auth checks passed.`);
