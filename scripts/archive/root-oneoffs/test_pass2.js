// PASS 2 test: compound word repair (updated with JOIN_TIGHT for *.js)
function applyPass2(html) {
    const JOIN_WITH_SPACE = [
        /\bSpring\s+Boot\b/g,
        /\bSpring\s+Cloud\b/g,
        /\bReact\s+Native\b/g,
        /\bReact\s+Hooks?\b/g,
        /\bVisual\s+Studio\b/g,
        /\bVisual\s+Studio\s+Code\b/g,
        /\bMachine\s+Learning\b/g,
        /\bApache\s+Kafka\b/g,
        /\bFull[\s-]Stack\b/g
    ];
    const JOIN_TIGHT = [
        /\bNode[\s\S]*?\.?\s?js\b/gi,
        /\bNext[\s\S]*?\.?\s?js\b/gi,
        /\bVue[\s\S]*?\.?\s?js\b/gi,
        /\bExpress[\s\S]*?\.?\s?js\b/gi
    ];
    for (const re of JOIN_WITH_SPACE) {
        html = html.replace(re, (match) => match.replace(/\s+/g, ' '));
    }
    for (const re of JOIN_TIGHT) {
        html = html.replace(re, (match) => match.replace(/\s+/g, ''));
    }
    return html;
}
let pass = 0, fail = 0;
function test(name, got, want) {
    if (got === want) { pass++; console.log('OK ' + name); }
    else { fail++; console.log('FAIL ' + name + '\n  want: ' + want + '\n  got:  ' + got); }
}
test('Spring Boot split',
    applyPass2('<li>Built with Spring\nBoot microservices.</li>'),
    '<li>Built with Spring Boot microservices.</li>');
test('Node.js split (tight)',
    applyPass2('<p>Server-side stack: Node\n.js + Express.</p>'),
    '<p>Server-side stack: Node.js + Express.</p>');
test('React Native split',
    applyPass2('<li>Built a React\nNative app.</li>'),
    '<li>Built a React Native app.</li>');
test('Visual Studio Code split',
    applyPass2('<li>IDE: Visual\nStudio\nCode</li>'),
    '<li>IDE: Visual Studio Code</li>');
test('Full Stack split',
    applyPass2('<li>Full\nStack engineer.</li>'),
    '<li>Full Stack engineer.</li>');
test('clean no change',
    applyPass2('<li>Built Spring Boot apps.</li>'),
    '<li>Built Spring Boot apps.</li>');
test('Express.js split (tight)',
    applyPass2('<li>Built APIs with Express\n.js on Node.</li>'),
    '<li>Built APIs with Express.js on Node.</li>');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
