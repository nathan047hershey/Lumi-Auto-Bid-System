/**
 * Unit-style checks for education parse + YoE buckets + classify (no browser).
 * Run: node extension/fixtures/test_education_fixed.js
 */
function parseEducationParts(profile) {
    if (!profile) return { school: '', degree: '', discipline: '' };
    let school = String(profile.school || '').trim();
    let degree = String(profile.degree || '').trim();
    let discipline = String(profile.discipline || '').trim();
    const firstLine = String(profile.education || '')
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0] || '';
    if (firstLine) {
        const m = firstLine.match(/^(.+?)\s+in\s+(.+?)\s+at\s+(.+?)(?:\s+in\s+[\d.]|\s*$)/i);
        if (m) {
            if (!degree) degree = m[1].trim();
            if (!discipline) discipline = m[2].trim();
            if (!school) school = m[3].trim();
        }
    }
    if (!degree && profile.education_level) {
        const map = { "Bachelor's": 'Bachelor of Science' };
        degree = map[profile.education_level] || profile.education_level;
    }
    return { school, degree, discipline };
}

function yearsExperienceFillValue(profile) {
    const raw = String(profile?.years_of_experience || '').trim();
    if (!raw) return '';
    if (/year/i.test(raw) || /[+]/.test(raw) || /-/.test(raw)) return raw;
    const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
    if (!Number.isFinite(n)) return raw;
    if (n < 5) return 'Less than 5 years';
    if (n <= 6) return '5-6 years';
    if (n <= 10) return '7-10 years';
    return '10+ years';
}

function classifyPersonal(label, name = '') {
    const hay = `${label} ${name}`.toLowerCase();
    if (/\b(github|public[\s_-]*portfolio)\b/.test(hay)
        || /\burl\b.*\b(github|portfolio)\b/.test(hay)) return 'github';
    if (/\b(working from this state|consistently be working|legal entity.{0,40}working)\b/.test(hay)) {
        return 'work_authorization';
    }
    if (/\b(able to work remotely|work remotely|free from distractions)\b/.test(hay)
        && !/\b(describe|explain)\b/.test(hay)) return 'work_authorization';
    if (/\b(currently reside|where do you currently reside)\b/.test(hay)) return 'city';
    if (/\b(state|province)\b/.test(hay)
        && !/\b(working from|employed in this role|legal entity)\b/.test(hay)) return 'state';
    if (/\b(country|nation)\b/.test(hay) && !/\b(sponsor|working from)\b/.test(hay)) return 'country';
    if (/\b(school|university)\b/.test(hay) && !/\bhigh[\s_-]*school\b/.test(hay)) return 'school';
    if (/\b(discipline|major)\b/.test(hay)) return 'discipline';
    if (/\b(degree)\b/.test(hay) && !/\bhighest\b/.test(hay)) return 'degree';
    if (/\byears?\b/.test(hay) && /\bexperience\b/.test(hay)
        && !/\b(describe|explain|provide)\b/.test(hay)) return 'years_of_experience';
    return 'question';
}

function isPlaceholderLabelText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    if (/^select(\.\.\.|…|:)?$/i.test(t)) return true;
    if (/^choose(\s+one)?(\.\.\.|…|:)?$/i.test(t)) return true;
    if (/^type to search|^start typing|^search(\.\.\.|…)?$/i.test(t)) return true;
    return false;
}
function cleanLabelText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().split('\n')[0].trim();
    if (!t || t.length > 500) return '';
    const stripped = t
        .replace(/\s+Select(\.\.\.|…|:)?$/i, '')
        .replace(/\s+Choose(\s+one)?(\.\.\.|…|:)?$/i, '')
        .trim();
    if (isPlaceholderLabelText(stripped)) return '';
    return stripped;
}

const edu = parseEducationParts({
    education: 'B.S. Honors degrees in Computer Science at Virginia Tech in 2004 - 2007'
});
const yoe = yearsExperienceFillValue({ years_of_experience: '18' });

const checks = [
    ['school', edu.school.includes('Virginia Tech')],
    ['discipline', edu.discipline.includes('Computer Science')],
    ['degree', /B\.S|Bachelor/i.test(edu.degree)],
    ['yoe18', yoe === '10+ years'],
    ['github label', classifyPersonal('Please provide a URL to your GitHub, public portfolio.') === 'github'],
    ['reside', classifyPersonal('Where do you currently reside?') === 'city'],
    ['state work', classifyPersonal('Will you consistently be working from this state while employed in this role?') === 'work_authorization'],
    ['legal entity state', classifyPersonal('If you reside in a US state where we have a legal entity, will you consistently be working from this state while employed in this role?') === 'work_authorization'],
    ['remote yesno', classifyPersonal('Are you able to work remotely and maintain a work environment that is free from distractions?') === 'work_authorization'],
    ['country', classifyPersonal('Country') === 'country'],
    ['not state picker', classifyPersonal('If you reside in a US state where we have a legal entity, will you consistently be working from this state while employed in this role?') !== 'state'],
    ['school label', classifyPersonal('School') === 'school'],
    ['yoe q', classifyPersonal('How many years of professional experience do you have as a full stack web developer (front end + back end)?') === 'years_of_experience'],
    ['reject Select... label', isPlaceholderLabelText('Select...') === true],
    ['clean Discipline Select', cleanLabelText('Discipline * Select...') === 'Discipline *'],
    ['discipline from cleaned', classifyPersonal(cleanLabelText('Discipline * Select...')) === 'discipline'],
    ['Select... not discipline', classifyPersonal('Select...') !== 'discipline'],
    ['Select... is question trap', classifyPersonal('Select...') === 'question']
];

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'OK' : 'FAIL', name, ok ? '' : '←');
    if (!ok) failed += 1;
}
console.log(JSON.stringify({ edu, yoe, failed }, null, 2));
process.exit(failed ? 1 : 0);
