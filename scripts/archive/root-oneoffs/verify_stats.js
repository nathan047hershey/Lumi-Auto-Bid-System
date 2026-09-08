const vm = require('vm');
const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/statsService.js';
try {
    const code = fs.readFileSync(p, 'utf8');
    vm.createScript(code);
    console.log('statsService.js syntax OK');
} catch (e) {
    console.error('Syntax error:', e.message);
    process.exit(1);
}
