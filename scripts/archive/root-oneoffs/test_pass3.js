// PASS 3 test: spelled-out numbers to digits
function applyPass3(html) {
    const NUMBER_WORDS = {
        'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
        'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
        'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
        'fourteen': 14, 'fifteen': 15, 'sixteen': 16,
        'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
        'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
        'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90
    };
    const UNIT_PATTERN = '(?:years?|yrs?|%+|percent|x|ms|s|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|projects?|bugs?|tests?|KB|MB|GB|TB|\\$|USD|uptime|core_skills?)';
    const numberWordRegex = new RegExp('\\b(' + Object.keys(NUMBER_WORDS).join('|') + ')\\s+(' + UNIT_PATTERN + ')\\b', 'gi');
    const compoundRegex = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\s+(years?|engineers?|developers?|services?|microservices?|requests?|QPS|RPS|users?|customers?|projects?|KB|MB|GB|%|percent|ms|s|x)\b/gi;
    html = html.replace(compoundRegex, (match, tens, ones, unit) => {
        const t = NUMBER_WORDS[tens.toLowerCase()] || 0;
        const o = NUMBER_WORDS[ones.toLowerCase()] || 0;
        return (t + o) + ' ' + unit;
    });
    html = html.replace(numberWordRegex, (match, word, unit) => {
        const n = NUMBER_WORDS[word.toLowerCase()];
        if (n == null) return match;
        return n + ' ' + unit;
    });
    return html;
}
let pass = 0, fail = 0;
function test(name, got, want) {
    if (got === want) { pass++; console.log('OK ' + name); }
    else { fail++; console.log('FAIL ' + name + '\n  want: ' + want + '\n  got:  ' + got); }
}
test('six years',
    applyPass3('<p>Engineer with six years of experience.</p>'),
    '<p>Engineer with 6 years of experience.</p>');
test('twelve microservices',
    applyPass3('<li>Built twelve microservices in Go.</li>'),
    '<li>Built 12 microservices in Go.</li>');
test('forty engineers',
    applyPass3('<p>Team of forty engineers across 3 timezones.</p>'),
    '<p>Team of 40 engineers across 3 timezones.</p>');
test('eighty percent',
    applyPass3('<li>Improved coverage to eighty percent.</li>'),
    '<li>Improved coverage to 80 percent.</li>');
test('compound twenty five APIs (years/projects/etc)',
    applyPass3('<li>Built twenty five projects.</li>'),
    '<li>Built 25 projects.</li>');
test('clean digits no change',
    applyPass3('<li>Built 6 microservices.</li>'),
    '<li>Built 6 microservices.</li>');
test('word with no ATS unit no change',
    applyPass3('<p>Talked for six minutes about design.</p>'),
    '<p>Talked for six minutes about design.</p>');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
