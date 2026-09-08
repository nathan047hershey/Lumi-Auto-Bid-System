// PASS 1 test: contact line integrity
function applyPass1(html) {
    const isContactLine = (text) =>
        /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)
        || /(\+?\d[\d\s().-]{7,}\d)/.test(text)
        || /(https?:\/\/|www\.)/i.test(text)
        || /\b(?:Remote|Hybrid|On-?site)\b/i.test(text);
    return html.replace(/<p>([\s\S]*?)<\/p>/gi, (m, inner) => {
        if (!isContactLine(inner)) return m;
        const flat = inner.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
        return '<p>' + flat + '</p>';
    });
}
let pass = 0, fail = 0;
function test(name, got, want) {
    if (got === want) { pass++; console.log('OK ' + name); }
    else { fail++; console.log('FAIL ' + name + '\n  want: ' + want + '\n  got:  ' + got); }
}
test('email on single line',
    applyPass1('<h1>Sarah Chen</h1>\n<p>Sarah Chen\n| sarah.chen@example.com | +1-555-0102 | https://linkedin.com/in/sarahchen</p>'),
    '<h1>Sarah Chen</h1>\n<p>Sarah Chen | sarah.chen@example.com | +1-555-0102 | https://linkedin.com/in/sarahchen</p>');
test('non-contact paragraph unchanged',
    applyPass1('<p>This is a long paragraph\nthat wraps onto a second line.</p>'),
    '<p>This is a long paragraph\nthat wraps onto a second line.</p>');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
