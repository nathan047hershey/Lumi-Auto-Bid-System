/**
 * Closed / expired ATS landing — form first, then URL / banner.
 * Run: node extension/fixtures/test_job_closed_page.js
 */
import {
    analyzeJobClosedPage,
    inspectJobClosedUrl,
    matchJobClosedPageText,
    pageLooksJobClosed
} from '../lib/jobClosedPage.js';

const checks = [];

checks.push([
    'greenhouse oneTrust banner',
    pageLooksJobClosed('The job you are looking for is no longer open. Current Openings at OneTrust.')
]);
checks.push([
    'apply form present wins over banner',
    analyzeJobClosedPage({
        text: 'The job you are looking for is no longer open.',
        formReady: true,
        fieldCount: 8
    }).closed === false
]);
checks.push([
    'JD boilerplate is not closed',
    pageLooksJobClosed(
        'Apply for this job. We will contact you if the position has been filled. First name. Submit application.'
    ) === false
]);
checks.push([
    'sponsorship closed-to is not expired',
    pageLooksJobClosed('This job is closed to candidates who require visa sponsorship. First name.') === false
]);
checks.push([
    'other-job card later on the page is ignored',
    pageLooksJobClosed(
        `${'Apply now. Company. Role. '.repeat(80)} This job is no longer available.`
    ) === false
]);
checks.push([
    'listing chrome is not expired',
    analyzeJobClosedPage({
        text: 'Search. 12 jobs found. Filter by department.',
        url: 'https://wd1.myworkdayjobs.com/en-US/careers'
    }).closed === false
    && analyzeJobClosedPage({
        text: 'Search. 12 jobs found. Filter by department.',
        url: 'https://wd1.myworkdayjobs.com/en-US/careers'
    }).reason === 'listing_page'
]);
checks.push([
    'greenhouse error=true is expired without form',
    analyzeJobClosedPage({
        text: 'Current Openings at OneTrust. 92 jobs.',
        url: 'https://job-boards.greenhouse.io/onetrust/embed/job_board?error=true'
    }).via === 'greenhouse_error_url'
]);
checks.push([
    'greenhouse error=true ignored when form present',
    analyzeJobClosedPage({
        url: 'https://job-boards.greenhouse.io/onetrust/embed/job_app?error=true&token=abc',
        formReady: true,
        fieldCount: 6
    }).closed === false
]);
checks.push([
    'lever apply 404 is expired',
    analyzeJobClosedPage({
        url: 'https://jobs.lever.co/acme/uuid',
        httpStatus: 404
    }).via === 'lever_http'
]);
checks.push([
    'api.lever.co 404 is ignored',
    analyzeJobClosedPage({
        url: 'https://api.lever.co/v0/postings/acme',
        httpStatus: 404
    }).reason === 'lever_api_ignored'
]);
checks.push([
    'workday missing page banner',
    analyzeJobClosedPage({
        text: "The page you are looking for doesn't exist.",
        url: 'https://company.wd1.myworkdayjobs.com/en-US/careers/job/gone'
    }).closed === true
]);
checks.push([
    'successfactors sap copy',
    pageLooksJobClosed(
        'This job cannot be viewed at this time. It has either been deleted or is no longer available for application.'
    )
]);
checks.push([
    'ashby job not found heading',
    analyzeJobClosedPage({
        headingText: 'Job not found',
        url: 'https://jobs.ashbyhq.com/acme/uuid'
    }).via === 'heading'
]);
checks.push([
    'ashby job not found in body only is ignored',
    analyzeJobClosedPage({
        text: 'If job not found, try search. Apply for this role.',
        url: 'https://jobs.ashbyhq.com/acme/uuid'
    }).closed === false
]);
checks.push([
    'inspect greenhouse error url',
    inspectJobClosedUrl('https://boards.greenhouse.io/acme/embed/job_board?error=true').ghError === true
]);
checks.push([
    'snippet includes banner',
    /no longer open/i.test(matchJobClosedPageText('The job you are looking for is no longer open.')?.snippet || '')
]);

let failed = 0;
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
    if (!ok) failed += 1;
}
if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} job-closed page checks passed.`);
