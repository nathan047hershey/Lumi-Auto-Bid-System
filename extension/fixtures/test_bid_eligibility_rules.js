/**
 * Run: node extension/fixtures/test_bid_eligibility_rules.js
 */
'use strict';

const {
    evaluateBidEligibility,
    normalizeCompany,
    normalizeJd,
    COMPANY_COOLDOWN_DAYS
} = require('../../server/services/bidEligibilityRules');

const now = Date.parse('2026-09-09T12:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

const checks = [];

checks.push(['normalize company strips LLC', normalizeCompany('Acme Technologies LLC') === 'acme']);
checks.push(['normalize JD collapses space', normalizeJd('Hello   <b>World</b>') === 'hello world']);

const baseCand = {
    id: 10,
    profile_id: 1,
    company_name: 'Acme Inc',
    job_role: 'Backend Engineer',
    job_description: 'Build APIs in Python',
    core_skills: 'python'
};

const priorPython = {
    id: 1,
    company_name: 'Acme LLC',
    job_role: 'Data Engineer',
    job_description: 'Different JD for data pipelines',
    core_skills: 'python',
    updated_at: new Date(now - 10 * day).toISOString()
};

const priorJava = {
    ...priorPython,
    id: 2,
    core_skills: 'java',
    job_description: 'Java services'
};

checks.push([
    'allow same stack different JD after cooldown',
    evaluateBidEligibility(baseCand, [priorPython], { now }).ok === true
]);

checks.push([
    'block different stack same company',
    evaluateBidEligibility(baseCand, [priorJava], { now }).code === 'different_stack'
]);

const sameJob = {
    id: 3,
    company_name: 'Acme',
    job_role: 'Backend Engineer',
    job_description: 'Build APIs in Python',
    core_skills: 'python',
    updated_at: new Date(now - 30 * day).toISOString()
};
checks.push([
    'block identical title+JD',
    evaluateBidEligibility(baseCand, [sameJob], { now }).code === 'same_job'
]);

const recent = {
    ...priorPython,
    id: 4,
    updated_at: new Date(now - 1 * day).toISOString()
};
checks.push([
    'block same company within cooldown',
    evaluateBidEligibility(baseCand, [recent], { now }).code === 'company_cooldown'
]);

checks.push([
    'cooldown days is 3',
    COMPANY_COOLDOWN_DAYS === 3
]);

checks.push([
    'no priors → ok',
    evaluateBidEligibility(baseCand, [], { now }).ok === true
]);

// Other profile / other user: priors are only passed for *this* profile.
// If Profile B's applied history is never loaded into Profile A's check, A is free.
checks.push([
    'other profile history is not considered unless passed in',
    evaluateBidEligibility(
        { ...baseCand, profile_id: 99 },
        [], // Profile 99 has no priors — Profile 1's Acme apply must not appear here
        { now }
    ).ok === true
]);

const otherProfilePriorsWouldBlockIfWronglyShared = [recent];
checks.push([
    'same profile recent apply still blocks',
    evaluateBidEligibility(baseCand, otherProfilePriorsWouldBlockIfWronglyShared, { now }).code === 'company_cooldown'
]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`\nAll ${checks.length} bid-eligibility checks passed.`);
