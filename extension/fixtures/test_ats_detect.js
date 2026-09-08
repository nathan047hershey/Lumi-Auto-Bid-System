/**
 * ATS URL routing checks for Auto Bidder.
 * Run: node extension/fixtures/test_ats_detect.js
 */
import {
    detectAtsFromUrl,
    isGreenhouseUrl,
    resolveBidderAts,
    isAshbyJobDescriptionUrl,
    ashbyApplicationUrl
} from '../lib/atsDetect.js';

const checks = [];
const oracleUrl = 'https://eihu.fa.us8.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/12345/apply';
const ashbyJd = 'https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ashbyApp = 'https://jobs.ashbyhq.com/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/application';

checks.push(['oracle host', detectAtsFromUrl(oracleUrl).id === 'oracle']);
checks.push(['greenhouse host', detectAtsFromUrl('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1').id === 'greenhouse']);
checks.push(['oracle not greenhouse', !isGreenhouseUrl(oracleUrl)]);
checks.push([
    'oracle url wins over dom greenhouse',
    resolveBidderAts({ applyUrl: oracleUrl, tabUrl: oracleUrl, formAts: 'greenhouse' }) === 'oracle'
]);
checks.push([
    'generic when unknown url and dom greenhouse',
    resolveBidderAts({ applyUrl: 'https://careers.example.com/apply', tabUrl: 'https://careers.example.com/apply', formAts: 'greenhouse' }) === 'generic'
]);
checks.push([
    'greenhouse url uses greenhouse engine',
    resolveBidderAts({
        applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        tabUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        formAts: 'generic'
    }) === 'greenhouse'
]);

checks.push(['ashby host', detectAtsFromUrl(ashbyJd).id === 'ashby']);
checks.push(['lever host', detectAtsFromUrl('https://jobs.lever.co/acme/abc').id === 'lever']);
checks.push(['workday host', detectAtsFromUrl('https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/1').id === 'workday']);
checks.push(['icims host', detectAtsFromUrl('https://careers-acme.icims.com/jobs/123/apply').id === 'icims']);
checks.push(['bamboohr host', detectAtsFromUrl('https://acme.bamboohr.com/careers/12').id === 'bamboohr']);
checks.push(['smartrecruiters host', detectAtsFromUrl('https://jobs.smartrecruiters.com/Acme/123').id === 'smartrecruiters']);
checks.push(['linkedin host', detectAtsFromUrl('https://www.linkedin.com/jobs/view/123').id === 'linkedin']);

checks.push([
    'linkedin always wins',
    resolveBidderAts({
        applyUrl: 'https://www.linkedin.com/jobs/view/1',
        tabUrl: 'https://www.linkedin.com/jobs/view/1',
        formAts: 'greenhouse'
    }) === 'linkedin'
]);
checks.push([
    'ashby url wins over greenhouse dom',
    resolveBidderAts({ applyUrl: ashbyApp, tabUrl: ashbyApp, formAts: 'greenhouse' }) === 'ashby'
]);
checks.push([
    'workday url wins over greenhouse dom',
    resolveBidderAts({
        applyUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers',
        tabUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers',
        formAts: 'greenhouse'
    }) === 'workday'
]);

checks.push(['ashby JD url detected', isAshbyJobDescriptionUrl(ashbyJd) === true]);
checks.push(['ashby application not JD', isAshbyJobDescriptionUrl(ashbyApp) === false]);
checks.push(['ashbyApplicationUrl appends /application', ashbyApplicationUrl(ashbyJd) === ashbyApp]);
checks.push([
    'ashbyApplicationUrl idempotent',
    ashbyApplicationUrl(ashbyApp).replace(/\/$/, '') === ashbyApp.replace(/\/$/, '')
]);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} ats-detect checks passed.`);
