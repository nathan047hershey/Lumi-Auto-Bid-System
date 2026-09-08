const vm = require('vm');
const fs = require('fs');

const files = [
    'd:/Projects/job-apply-master/job-apply-master/server/services/jobLinkScraper.js',
    'd:/Projects/job-apply-master/job-apply-master/server/services/statsService.js',
    'd:/Projects/job-apply-master/job-apply-master/server/services/jobDetailFetchService.js',
    'd:/Projects/job-apply-master/job-apply-master/server/routes/admin.js'
];

for (const f of files) {
    try {
        const code = fs.readFileSync(f, 'utf8');
        vm.createScript(code);
        console.log(`✓ ${f.split('/').pop()} - Syntax OK`);
    } catch (e) {
        console.error(`✗ ${f.split('/').pop()} - Syntax error: ${e.message}`);
    }
}
