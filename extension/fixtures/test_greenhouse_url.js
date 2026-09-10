/**
 * Run: node extension/fixtures/test_greenhouse_url.js
 */
const {
    parseGreenhouseBoardAndJob,
    greenhouseScrapeUrl,
    canonicalizeGreenhouseApplyUrl,
    isGreenhouseUrl,
    isGreenhouseIoHost,
    normalizeGreenhouseJobId,
    inferGreenhouseBoardFromHost
} = require('../../server/services/scraper/greenhouseUrl.js');
const {
    canonicalJobLinkUrl,
    resolveStoredJobUrls
} = require('../../server/services/scraper/jobLinkUrl.js');

const ZOOMINFO =
    'https://www.zoominfo.com/careers/jr107373/principal-software-engineer-data'
    + '?gh_src=-d14a9e1e2&gh_jid=-8486808002';

const parsed = parseGreenhouseBoardAndJob(ZOOMINFO);
const resolved = resolveStoredJobUrls(ZOOMINFO, null);

const checks = [
    ['strip leading dash on gh_jid', normalizeGreenhouseJobId('-8486808002') === '8486808002'],
    ['infer zoominfo.com → zoominfo', inferGreenhouseBoardFromHost('www.zoominfo.com') === 'zoominfo'],
    ['parse zoominfo board', parsed && parsed.board === 'zoominfo'],
    ['parse zoominfo job id', parsed && parsed.jobId === '8486808002'],
    ['parse zoominfo shape', parsed && parsed.shape === 'company_gh_jid'],
    [
        'scrape url is classic greenhouse',
        greenhouseScrapeUrl(ZOOMINFO)
            === 'https://job-boards.greenhouse.io/zoominfo/jobs/8486808002'
    ],
    [
        'apply url is greenhouse embed',
        canonicalizeGreenhouseApplyUrl(ZOOMINFO)
            === 'https://job-boards.greenhouse.io/embed/job_app?for=zoominfo&token=8486808002'
    ],
    ['isGreenhouseUrl zoominfo', isGreenhouseUrl(ZOOMINFO) === true],
    ['isGreenhouseIoHost zoominfo', isGreenhouseIoHost(ZOOMINFO) === false],
    [
        'identity collapses to greenhouse',
        canonicalJobLinkUrl(ZOOMINFO) === 'greenhouse://zoominfo/jobs/8486808002'
    ],
    [
        'classic greenhouse still parses',
        parseGreenhouseBoardAndJob('https://boards.greenhouse.io/acme/jobs/123456').jobId === '123456'
    ],
    [
        'embed still parses',
        parseGreenhouseBoardAndJob(
            'https://job-boards.greenhouse.io/embed/job_app?for=planetlabs&token=8008355'
        ).board === 'planetlabs'
    ],
    ['plain career page is not greenhouse', parseGreenhouseBoardAndJob('https://careers.acme.com/jobs/1') === null],
    ['keep zoominfo as source', /zoominfo\.com/i.test(resolved.source || '')],
    ['store greenhouse apply', /greenhouse\.io\/embed\/job_app/i.test(resolved.apply || '')]
];

let failed = 0;
for (const [name, ok] of checks) {
    console.log(ok ? 'PASS' : 'FAIL', name);
    if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`\nAll ${checks.length} greenhouse-url checks passed.`);
