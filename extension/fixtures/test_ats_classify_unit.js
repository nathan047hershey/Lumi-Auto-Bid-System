/**
 * Unit tests for ATS detection + classification (no browser).
 * Run: node extension/fixtures/test_ats_classify_unit.js
 */

function detectAts({ host = '', href = '', has = () => false } = {}) {
    host = host.toLowerCase();
    href = href.toLowerCase();
    if (host.includes('linkedin.com') || href.includes('linkedin.com/jobs')) return 'linkedin';
    if (host.includes('greenhouse.io') || host.includes('boards.greenhouse') || host.includes('job-boards.greenhouse')) {
        return 'greenhouse';
    }
    if (host.includes('lever.co') || host.includes('jobs.lever.co')) return 'lever';
    if (host.includes('ashbyhq.com') || host.includes('jobs.ashbyhq.com')) return 'ashby';
    if (host.includes('myworkdayjobs.com') || host.includes('workdayjobs.com') || host.includes('wd1.myworkdayjobs')) {
        return 'workday';
    }
    if (host.includes('smartrecruiters.com')) return 'smartrecruiters';
    if (host.includes('icims.com')) return 'icims';
    if (host.includes('bamboohr.com')) return 'bamboohr';
    if (host.includes('rippling.com') || host.includes('ats.rippling')) return 'rippling';
    if (has('#application_form')) return 'greenhouse';
    if (has('form.application-form')) return 'lever';
    if (has('[class*="ashby"]')) return 'ashby';
    if (has('[data-automation-id="jobPostingPage"]')) return 'workday';
    if (has('.jobapp-form')) return 'smartrecruiters';
    if (has('.iCIMS_Forms')) return 'icims';
    // Must NOT treat random data-automation-id as Workday
    if (has('[data-automation-id]')) return 'generic-not-workday';
    return 'generic';
}

function classifyPersonal(label, name = '', autoId = '') {
    const autoExpanded = String(autoId || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ');
    const hay = `${label} ${name} ${autoId} ${autoExpanded}`.toLowerCase();
    if (/\b(first[\s_-]*name|given[\s_-]*name|fname|legal[\s_-]*first)\b/.test(hay)) return 'first_name';
    if (/\b(last[\s_-]*name|surname|family[\s_-]*name|lname|legal[\s_-]*last)\b/.test(hay)) return 'last_name';
    if (/\b(full[\s_-]*name|your[\s_-]*name)\b/.test(hay) && !/\b(first|last)\b/.test(hay)) return 'full_name';
    if (/\b(e-?mail)\b/.test(hay)) return 'email';
    if (/\b(phone|mobile|tel)\b/.test(hay)) return 'phone';
    if (/\blinkedin\b/.test(hay)) return 'linkedin';
    if (/\b(github|public[\s_-]*portfolio)\b/.test(hay) || /\b(website|portfolio).*\bgithub\b|\bgithub\b.*\b(website|portfolio)\b/.test(hay)) {
        return 'github';
    }
    // Yes/No "reside in US" before city ("Where do you currently reside?")
    if (
        (/\b(do you|are you)\b/.test(hay) && /\breside\b/.test(hay) && !/\bwhere\b/.test(hay))
        || (/\breside\b/.test(hay) && /\b(united states|u\.?\s*s\.?\s*a?\.?|u\.s\b)\b/.test(hay))
        || /\blegal(?:ly)?\s+resid|\bpermanent\s+residenc/.test(hay)
    ) {
        return 'work_authorization';
    }
    if (/\b(city|location\s*\(city\)|where do you currently reside|currently reside)\b/.test(hay)
        && !/\b(united states)\b/.test(hay)
        && !( /\b(do you|are you)\b/.test(hay) && !/\bwhere\b/.test(hay) )) {
        return 'city';
    }
    if (/\b(working from this state|consistently be working|able to work remotely|free from distractions)\b/.test(hay)) {
        return 'work_authorization';
    }
    if (/\b(sponsor|sponsorship|visa[\s_-]*support|require.*visa)\b/.test(hay)) return 'requires_sponsorship';
    if (/\bwork[\s_-]*auth/.test(hay) && /\b(sponsor|visa|require)\b/.test(hay)) return 'requires_sponsorship';
    if (/\b(work[\s_-]*auth|authoriz(ed|ation)|eligible[\s_-]*to[\s_-]*work|where this job is located)\b/.test(hay)) {
        return 'work_authorization';
    }
    if (/\b(country|nation)\b/.test(hay) && !/\b(sponsor|authoriz|job is located)\b/.test(hay)) return 'country';
    if (/\b(salary|compensation|desired\s*salary)\b/.test(hay)) return 'salary';
    if (
        /\b(data[\s_-]*protection|privacy|gdpr|nda|non[\s_-]*disclosure|acknowledg|consent|ai[\s_-]*note|note[\s_-]*tak)\b/.test(hay)
        && !/\b(describe|explain)\b/.test(hay)
    ) {
        return 'data_protection';
    }
    if (/\b(relocat\w*|willing[\s_-]*to[\s_-]*move)\b/.test(hay)) return 'willing_to_relocate';
    if (/\byears?\b/.test(hay) && /\bexperience\b/.test(hay) && !/\b(describe|explain|provide)\b/.test(hay)) {
        return 'years_of_experience';
    }
    return 'question';
}

const checks = [
    ['gh host', detectAts({ host: 'boards.greenhouse.io' }) === 'greenhouse'],
    ['rippling host', detectAts({ host: 'ats.rippling.com' }) === 'rippling'],
    ['lever host', detectAts({ host: 'jobs.lever.co' }) === 'lever'],
    ['ashby host', detectAts({ host: 'jobs.ashbyhq.com' }) === 'ashby'],
    ['workday host', detectAts({ host: 'company.wd1.myworkdayjobs.com' }) === 'workday'],
    ['sr host', detectAts({ host: 'jobs.smartrecruiters.com' }) === 'smartrecruiters'],
    ['ashby before workday attr', detectAts({
        host: 'jobs.ashbyhq.com',
        has: (s) => s.includes('ashby') || s.includes('data-automation-id')
    }) === 'ashby'],
    ['random automation-id not workday', detectAts({
        host: 'example.com',
        has: (s) => s === '[data-automation-id]'
    }) === 'generic-not-workday'],
    ['wd firstName autoId', classifyPersonal('', '', 'legalNameSection--firstName') === 'first_name'],
    ['wd lastName autoId', classifyPersonal('', '', 'legalNameSection--lastName') === 'last_name'],
    ['wd work auth label', classifyPersonal('Are you legally authorized to work in the country where this job is located?') === 'work_authorization'],
    ['lever full name', classifyPersonal('Full name *') === 'full_name'],
    ['ashby sponsor', classifyPersonal('Do you require visa sponsorship?') === 'requires_sponsorship'],
    ['gh portfolio', classifyPersonal('Website / Portfolio / GitHub') === 'github'],
    ['city reside', classifyPersonal('Where do you currently reside?') === 'city'],
    ['us reside yesno', classifyPersonal('Do you currently reside in the United States?') === 'work_authorization'],
    ['yoe', classifyPersonal('How many years of professional experience do you have?') === 'years_of_experience'],
    ['relocate', classifyPersonal('Are you willing to relocate?') === 'willing_to_relocate'],
    ['host first workday', detectAts({ host: 'acme.wd1.myworkdayjobs.com', has: (s) => s.includes('ashby') }) === 'workday'],
    ['visa sponsor full', classifyPersonal('Do you currently, or will you in the future, require visa sponsorship to work here? Work Authorization') === 'requires_sponsorship'],
    ['desired salary', classifyPersonal('What are your salary expectations for this role? Desired salary') === 'salary'],
    ['nda acknowledge', classifyPersonal('I acknowledge my right to refrain from disclosing any confidential information in accordance with the Non-Disclosure Agreement NDA') === 'data_protection'],
    ['ai note consent', classifyPersonal('I consent to the use of AI-powered note-taking tools during the interview process AI Note taker') === 'data_protection']
];

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'OK' : 'FAIL', name);
    if (!ok) failed += 1;
}
console.log(JSON.stringify({ failed, total: checks.length }, null, 2));
process.exit(failed ? 1 : 0);
