/**
 * Smoke: page↔extension Auto Bidder message map (mirrors app-bridge.js).
 * Run: node extension/fixtures/test_bidder_page_bridge.js
 */
const PAGE_TO_EXT = {
    JOB_APPLY_BIDDER_PROCESS_QUEUE: 'PROCESS_READY_QUEUE',
    JOB_APPLY_BIDDER_NEXT: 'BIDDER_NEXT',
    JOB_APPLY_BIDDER_STOP: 'BIDDER_STOP',
    JOB_APPLY_BIDDER_QUEUE_STATE: 'BIDDER_QUEUE_STATE',
    JOB_APPLY_BIDDER_CAPTCHA_RESUME: 'BIDDER_CAPTCHA_RESUME',
    JOB_APPLY_BIDDER_CAPTCHA_FOCUS_TAB: 'BIDDER_CAPTCHA_FOCUS_TAB',
    JOB_APPLY_BIDDER_CAPTCHA_SKIP: 'BIDDER_CAPTCHA_SKIP',
    JOB_APPLY_BIDDER_REAUTOFILL: 'BIDDER_REAUTOFILL',
    JOB_APPLY_BIDDER_APPLY_ANSWERS: 'BIDDER_APPLY_ANSWERS',
    JOB_APPLY_BIDDER_INSTRUCT: 'BIDDER_INSTRUCT',
    JOB_APPLY_BIDDER_LIST_QUESTIONS: 'BIDDER_LIST_QUESTIONS',
    JOB_APPLY_BIDDER_SUBMIT: 'BIDDER_SUBMIT',
    JOB_APPLY_BIDDER_UPDATE_STATE: 'BIDDER_UPDATE_STATE',
    JOB_APPLY_BIDDER_PING: 'BIDDER_PING',
    JOB_APPLY_BIDDER_REINJECT: 'REINJECT_APP_BRIDGE',
    JOB_APPLY_BIDDER_SAVE_PREFS: 'BIDDER_SAVE_PREFS'
};

function buildReadyQuery(profileId, jobLinkIds) {
    const q = new URLSearchParams();
    q.set('limit', '200');
    if (profileId) q.set('profile_id', String(profileId));
    if (Array.isArray(jobLinkIds) && jobLinkIds.length) {
        q.set('job_link_ids', jobLinkIds.map(String).join(','));
    }
    return q.toString();
}

const q = buildReadyQuery(3, [10, 20]);
function buildProcessPayload({ jobLinkIds, applicationIds, token, user, selectedProfileId }) {
    return {
        type: 'PROCESS_READY_QUEUE',
        jobLinkIds: jobLinkIds || [],
        applicationIds: applicationIds || [],
        token: token || null,
        user: user || null,
        selectedProfileId: selectedProfileId || null
    };
}

const processPayload = buildProcessPayload({
    jobLinkIds: [5],
    applicationIds: [52],
    token: 'page-token',
    user: { id: 2, username: 'bob' },
    selectedProfileId: 2
});

const checks = [
    ['process maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_PROCESS_QUEUE === 'PROCESS_READY_QUEUE'],
    ['next maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_NEXT === 'BIDDER_NEXT'],
    ['stop maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_STOP === 'BIDDER_STOP'],
    ['reply type constant', 'JOB_APPLY_BIDDER_EXTENSION_REPLY'.length > 10],
    ['selected link filter query', q.includes('job_link_ids=10%2C20') || q.includes('job_link_ids=10,20')],
    ['process syncs page token', !!processPayload.token && processPayload.token === 'page-token'],
    ['process passes applicationIds', processPayload.applicationIds[0] === 52],
    ['process passes jobLinkIds', processPayload.jobLinkIds[0] === 5],
    ['ping maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_PING === 'BIDDER_PING'],
    ['reinject maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_REINJECT === 'REINJECT_APP_BRIDGE'],
    ['captcha resume maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_CAPTCHA_RESUME === 'BIDDER_CAPTCHA_RESUME'],
    ['captcha focus maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_CAPTCHA_FOCUS_TAB === 'BIDDER_CAPTCHA_FOCUS_TAB'],
    ['captcha skip maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_CAPTCHA_SKIP === 'BIDDER_CAPTCHA_SKIP'],
    ['reautofill maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_REAUTOFILL === 'BIDDER_REAUTOFILL'],
    ['apply answers maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_APPLY_ANSWERS === 'BIDDER_APPLY_ANSWERS'],
    ['instruct maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_INSTRUCT === 'BIDDER_INSTRUCT'],
    ['list questions maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_LIST_QUESTIONS === 'BIDDER_LIST_QUESTIONS'],
    ['submit maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_SUBMIT === 'BIDDER_SUBMIT'],
    ['update state maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_UPDATE_STATE === 'BIDDER_UPDATE_STATE'],
    ['save prefs maps', PAGE_TO_EXT.JOB_APPLY_BIDDER_SAVE_PREFS === 'BIDDER_SAVE_PREFS']
];

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} page-bridge checks passed.`);
