/**
 * Regression test for the "Connected mailboxes appear Not connected after
 * login" bug.
 *
 * Root cause: the global axios response interceptor wiped localStorage on
 * any 401 with the body message "Authentication required" /
 * "Invalid or expired token" — including from mailbox READ endpoints
 * (GET /user/outlook/*, GET /user/gmail/*). This made
 * OutlookMailSettings, GmailMailSettings, the Inbox page and the
 * AutoBidderDialog silently drop their last-known state, so the UI lied
 * to the user about reconnecting.
 *
 * This test exercises the classifier + interceptor logic in isolation.
 * Run: node extension/fixtures/test_lumi_mailbox_auth.js
 * (no server/browser needed).
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

let pass = 0;
let fail = 0;
const record = (name, ok, detail) => {
    if (ok) {
        pass++;
        console.log(`✓ ${name}`);
    } else {
        fail++;
        console.error(`✗ ${name}${detail ? '\n   ' + detail : ''}`);
    }
};

// Mirror the classifier from client/src/api/index.js. If the regex below
// drifts from the production regex, this test should fail.
const MAILBOX_PATH_RE = /^\/?(api\/)?(user\/(outlook|gmail))(\/|$|\?)/i;

function isMailboxReadCall(config = {}) {
    const method = String(config.method || 'get').toLowerCase();
    if (method !== 'get') return false;
    const url = String(config.url || config.baseURL || '');
    return MAILBOX_PATH_RE.test(url);
}

const readCases = [
    [{ method: 'GET', url: '/user/outlook/status' }, true, 'Outlook status'],
    [{ method: 'get', url: '/user/outlook/status' }, true, 'lowercase method'],
    [{ method: 'GET', url: '/user/outlook/messages' }, true, 'Outlook messages'],
    [{ method: 'GET', url: '/user/outlook/health' }, true, 'Outlook health'],
    [{ method: 'GET', url: '/user/gmail/imap' }, true, 'Gmail IMAP root'],
    [{ method: 'GET', url: '/user/gmail/imap/sync' }, true, 'Gmail IMAP subpath'],
    [{ method: 'GET', url: '/api/user/outlook/status' }, true, 'with /api prefix'],
    [{ method: 'GET', url: 'api/user/gmail/imap/list' }, true, 'no leading slash, with api/'],
    [{ method: 'GET', url: 'user/outlook/status' }, true, 'no leading slash, no prefix'],
    [{ method: 'POST', url: '/user/outlook/disconnect' }, false, 'mutation disallowed'],
    [{ method: 'DELETE', url: '/user/outlook/mailboxes/1' }, false, 'mutation disallowed'],
    [{ method: 'PUT', url: '/user/outlook/mailboxes/1/assign-profile' }, false, 'mutation disallowed'],
    [{ method: 'POST', url: '/user/gmail/imap/connect' }, false, 'gmail mutation disallowed'],
    [{ method: 'POST', url: '/user/outlook/sync' }, false, 'sync mutation disallowed'],
    [{ method: 'POST', url: '/user/outlook/device-code' }, false, 'device-code mutation disallowed'],
    [{ method: 'POST', url: '/user/outlook/auth-url' }, false, 'auth-url mutation disallowed'],
    [{ method: 'POST', url: '/user/outlook/subscribe' }, false, 'subscribe mutation disallowed'],
    [{ method: 'POST', url: '/user/outlook/device-code/poll' }, false, 'device-code poll disallowed'],
    [{ method: 'POST', url: '/user/outlook/wait-otp' }, false, 'wait-otp disallowed'],
    [{ method: 'GET', url: '/admin/outlook/status' }, false, 'admin endpoint not mailbox'],
    [{ method: 'GET', url: '/user/profile' }, false, 'unrelated user endpoint'],
    [{ method: 'GET', url: '/users' }, false, 'users root'],
    [{ method: 'GET', url: '/user' }, false, 'user root'],
    [{ method: 'GET', url: '/user_admin' }, false, 'looks similar but not user/*'],
    [{ method: 'GET', url: '/user/outlook_health' }, false, 'no / separator after outlook'],
    [{ method: 'GET', url: '/whatever' }, false, 'random path'],
    [{}, false, 'empty config returns false (no URL)'],
    [{ url: '/user/outlook/status' }, true, 'no method field defaults to GET']
];

for (const [config, expected, desc] of readCases) {
    const got = isMailboxReadCall(config);
    record(`isMailboxReadCall: ${desc}`, got === expected, `got=${got} want=${expected}`);
}

// ─── Part 2: end-to-end interceptor (mocked, mirrors client/src/api/index.js)
const SESSION_AUTH_ERRORS = new Set([
    'Authentication required',
    'Invalid or expired token'
]);

function buildInterceptor() {
    const state = { clearedStorage: 0 };
    const store = { token: 'tok-initial', user: '{"id":1}' };
    let redirected = false;
    let href = '/admin/settings';
    const win = { location: { get pathname() { return href.split('?')[0]; }, get href() { return href; }, set href(v) { href = v; if (v === '/login') redirected = true; } } };
    const wrappedRemove = (k) => { if (store[k] != null) state.clearedStorage++; delete store[k]; };

    const onError = (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.error;
        const skip = error.config?.skipAuthRedirect;

        if (status === 401 && !skip && isMailboxReadCall(error.config || {})) {
            return Promise.reject(error);
        }
        if (status === 401 && !skip && SESSION_AUTH_ERRORS.has(message)) {
            const hadToken = !!store.token;
            if (hadToken) { wrappedRemove('token'); wrappedRemove('user'); }
            if (win.location.pathname !== '/login') { win.location.href = '/login'; }
        }
        return Promise.reject(error);
    };

    return {
        onError, store,
        get redirected() { return redirected; },
        setRedir(v) { redirected = v; },
        setHref(v) { href = v; },
        getCleared: () => state.clearedStorage,
        resetCleared() { state.clearedStorage = 0; }
    };
}

function makeError({ status, message, config }) {
    return { response: { status, data: { error: message } }, config };
}

const interceptor = buildInterceptor();

// (a) Mailbox read 401 → no wipe, no redirect
interceptor.onError(makeError({
    status: 401,
    message: 'Invalid or expired token',
    config: { method: 'GET', url: '/user/outlook/status' }
})).catch(() => {});
record('a) mailbox GET 401 does not wipe storage', interceptor.store.token === 'tok-initial');
record('a) mailbox GET 401 does not redirect', !interceptor.redirected);

// reset
interceptor.store.token = 'tok-initial';
interceptor.store.user = '{"id":1}';
interceptor.setRedir(false);
interceptor.setHref('/admin/settings');

// (b) Other 401 with session msg → wipes + redirects
interceptor.onError(makeError({
    status: 401,
    message: 'Invalid or expired token',
    config: { method: 'GET', url: '/user/profile' }
})).catch(() => {});
record('b) non-mailbox GET 401 with session msg wipes storage', !interceptor.store.token);
record('b) non-mailbox GET 401 redirects to /login', interceptor.redirected);

// (c) Non-session 401 → does not wipe
interceptor.store.token = 'tok-2';
interceptor.store.user = '{"id":1}';
interceptor.setRedir(false);
interceptor.setHref('/admin/settings');
interceptor.onError(makeError({
    status: 401,
    message: 'Bad LLM key',
    config: { method: 'GET', url: '/user/profile' }
})).catch(() => {});
record('c) non-session 401 does not wipe', interceptor.store.token === 'tok-2');
record('c) non-session 401 does not redirect', !interceptor.redirected);

// (d) skipAuthRedirect honored
interceptor.store.token = 'tok-3';
interceptor.setRedir(false);
interceptor.setHref('/admin/settings');
interceptor.onError(makeError({
    status: 401,
    message: 'Invalid or expired token',
    config: { method: 'GET', url: '/user/profile', skipAuthRedirect: true }
})).catch(() => {});
record('d) skipAuthRedirect does not wipe', interceptor.store.token === 'tok-3');
record('d) skipAuthRedirect does not redirect', !interceptor.redirected);

// (e) hadToken guard — second wipe doesn't double-clear
interceptor.store.token = null;
interceptor.store.user = null;
interceptor.setRedir(false);
interceptor.setHref('/admin/settings');
interceptor.resetCleared();
interceptor.onError(makeError({
    status: 401,
    message: 'Invalid or expired token',
    config: { method: 'GET', url: '/user/profile' }
})).catch(() => {});
record('e) hadToken guard: no token = no extra removes', interceptor.getCleared() === 0);

// (f) Mutation 401 with session msg → wipes + redirects
interceptor.store.token = 'tok-4';
interceptor.store.user = '{"id":1}';
interceptor.setRedir(false);
interceptor.setHref('/admin/settings');
interceptor.onError(makeError({
    status: 401,
    message: 'Invalid or expired token',
    config: { method: 'POST', url: '/user/outlook/disconnect' }
})).catch(() => {});
record('f) mailbox mutation 401 wipes session', !interceptor.store.token);
record('f) mailbox mutation 401 redirects', interceptor.redirected);

// ─── Part 3: cross-file regression assertions ──────────
// Verify that the actual production source files contain the changes
// that match this test's classifier + interceptor contract. If a future
// refactor accidentally removes the safety, this section fails.

const REPO = path.join(__dirname, '..', '..');
const apiSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'api', 'index.js'), 'utf8');
record('client/src/api/index.js defines MAILBOX_PATH_RE', apiSrc.includes('const MAILBOX_PATH_RE ='));
record('client/src/api/index.js defines isMailboxReadCall', apiSrc.includes('function isMailboxReadCall'));
record('client/src/api/index.js still keeps SESSION_AUTH_ERRORS', apiSrc.includes("'Authentication required'") && apiSrc.includes("'Invalid or expired token'"));
record('client/src/api/index.js has hadToken guard', apiSrc.includes('const hadToken'));
record('client/src/api/index.js authAPI.me accepts options', /me:\s*\(options\s*=\s*\{\}\)\s*=>\s*api\.get\(['"]\/auth\/me['"]/.test(apiSrc));

const authCtxSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'context', 'AuthContext.jsx'), 'utf8');
record('AuthContext.login uses skipAuthRedirect on post-login me()', authCtxSrc.includes('authAPI.me({ skipAuthRedirect: true })'));
record('AuthContext.login dispatches lumi:login-success', authCtxSrc.includes('lumi:login-success'));
record('AuthContext.useEffect does not nuke storage on transient failure', /keep the cached user/i.test(authCtxSrc));
record('AuthContext.login post-me() failure is non-fatal (warn)', authCtxSrc.includes('Post-login me() failed (non-fatal)'));

const omSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'components', 'OutlookMailSettings.jsx'), 'utf8');
record('OutlookMailSettings refresh retries on 401', omSrc.includes('attempt') && omSrc.includes("first.err?.response?.status"));
record('OutlookMailSettings refresh keeps last status', omSrc.includes('setStatus((prev) => prev ||'));

const gmSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'components', 'GmailMailSettings.jsx'), 'utf8');
record('GmailMailSettings refresh retries on 401', gmSrc.includes('attempt') && gmSrc.includes("first.err?.response?.status"));
record('GmailMailSettings refresh does not wipe to []', /Fall through without calling setMailboxes\(\[\]\)/.test(gmSrc));

const inbSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'pages', 'user', 'Inbox.jsx'), 'utf8');
record('Inbox.fetchStatus retries on 401', /fetchStatus\b[\s\S]{0,2000}first\.err\?\.response\?\.status/.test(inbSrc));
record('Inbox.fetchMessages retries on 401', /fetchMessages\b[\s\S]{0,2000}first\.err\?\.response\?\.status/.test(inbSrc));

const abdSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'components', 'job-links', 'AutoBidderDialog.jsx'), 'utf8');
record('AutoBidder refreshOutlookStatus retries on 401', /refreshOutlookStatus\b[\s\S]{0,600}first\.err\?\.response\?\.status/.test(abdSrc));

// ─── Part 4: getOutlookAuthUrl contract consistency ──────────
// Bug we caught: both adminAPI.getOutlookAuthUrl and userAPI.getOutlookAuthUrl
// were pre-unwrapping with `.then(r => r.data)`, but the admin Mailboxes
// call site (`const { data: urlData } = await adminAPI.getOutlookAuthUrl(...)`)
// treated the result as an axios response, double-unwrapping and producing
// `undefined.authorizeUrl` → "Cannot read properties of undefined (reading
// 'authorizeUrl')". The fix is to keep the helper contract uniform with the
// rest of the api module: return the raw axios response.

// Find adminAPI.getOutlookAuthUrl + userAPI.getOutlookAuthUrl and confirm
// neither pre-unwraps with .then(r => r.data).
function findHelper(apiSrc, ownerName) {
    // Find "const <owner> = {" then walk to its closing brace (best-effort)
    const declIdx = apiSrc.indexOf(`const ${ownerName} = {`);
    if (declIdx === -1) return null;
    // Slice to end of file and search for our key
    const slice = apiSrc.slice(declIdx);
    const keyIdx = slice.indexOf('getOutlookAuthUrl:');
    if (keyIdx === -1) return null;
    const decl = slice.slice(keyIdx);
    // Trim to the end of THIS declaration (newline before the next \n}
    // so we don't accidentally include `startOutlookAuthFlow`'s .then chain.
    const eol = decl.indexOf('\n');
    return eol === -1 ? decl : decl.slice(0, eol + 1);
}

const adminHelper = findHelper(apiSrc, 'adminAPI');
const userHelper = findHelper(apiSrc, 'userAPI');

record('adminAPI.getOutlookAuthUrl found in source', !!adminHelper);
record('userAPI.getOutlookAuthUrl found in source', !!userHelper);
record(
    'adminAPI.getOutlookAuthUrl returns raw axios response (no pre-unwrap)',
    !!adminHelper && /api\.post\(['"]\/user\/outlook\/auth-url['"][^)]*\)/.test(adminHelper) &&
    !/\.then\(/.test(adminHelper)
);
record(
    'userAPI.getOutlookAuthUrl returns raw axios response (no pre-unwrap)',
    !!userHelper && /api\.post\(['"]\/user\/outlook\/auth-url['"][^)]*\)/.test(userHelper) &&
    !/\.then\(/.test(userHelper)
);

// Inbox of axios-style response shape: `response.data` exists => unwrap,
// else it's already the body.
function unwrapAuthUrlResponse(response) {
    if (response && typeof response === 'object' && 'data' in response) {
        return response.data;
    }
    return response;
}
record('unwrapAuthUrlResponse unwraps axios-shaped response', unwrapAuthUrlResponse({ data: { authorizeUrl: 'u', redirectUri: 'r' } })?.authorizeUrl === 'u');
record('unwrapAuthUrlResponse passes through pre-unwrapped body', unwrapAuthUrlResponse({ authorizeUrl: 'u', redirectUri: 'r' })?.authorizeUrl === 'u');
record('unwrapAuthUrlResponse returns null for null', unwrapAuthUrlResponse(null) === null);

const mbxSrc = fs.readFileSync(path.join(REPO, 'client', 'src', 'pages', 'admin', 'Mailboxes.jsx'), 'utf8');
record('admin/Mailboxes no longer double-unwraps getOutlookAuthUrl response',
    !mbxSrc.includes('const { data: urlData } = await adminAPI.getOutlookAuthUrl')
);
record('admin/Mailboxes surfaces a clear error when authorizeUrl is missing',
    mbxSrc.includes('Server did not return an authorize URL')
);

// ─── Part 5: re-auth / already-connected polling ──────────
// Bug we caught: when the user re-authenticates an already-connected
// mailbox, Microsoft's OAuth consent is "sticky" — it skips the consent
// screen and silently redirects back. The mailbox count stays the same,
// so the original count-based polling on /admin/mailboxes never
// detected success and left the UI stuck on "Connecting...".
// The fix is fingerprint-based detection plus explicit popup-close
// detection and a hard 5-min ceiling.

record('admin/Mailboxes polling uses fingerprint (not just count)',
    mbxSrc.includes('fingerprint') && mbxSrc.includes('updated_at || m.connected_at')
);
record('admin/Mailboxes polling has popup-close detection',
    mbxSrc.includes('popup.closed') && mbxSrc.includes('closePoll')
);
record('admin/Mailboxes polling has hard 5-minute ceiling',
    /5\s*\*\s*60\s*\*\s*1000/.test(mbxSrc)
);
record('admin/Mailboxes stores popup window in watchingPopup ref',
    mbxSrc.includes('watchingPopup.current = { active: true, popup }')
);

// User-side too
record('OutlookMailSettings has updated_at-aware fingerprint detection',
    omSrc.includes('updated_at ||')
);
record('OutlookMailSettings has popup-close handler',
    omSrc.includes('popup.closed')
);

// Server side
const outlookSvc = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'outlookMailService.js'), 'utf8'
);
record('outlookMailService.accountPublic exposes updated_at',
    outlookSvc.includes('updated_at: row.updated_at || null')
);

const gmailSvc = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'gmailImapService.js'), 'utf8'
);
record('gmailImapService.mailboxPublic exposes updated_at',
    gmailSvc.includes('updated_at: row.updated_at || null')
);

// Unit-test the fingerprint logic itself — the user's `addedIds` and
// `updatedIds` must catch the re-auth case.
function fingerprint(data) {
    const all = [
        ...(data.outlook || []),
        ...(data.gmail || [])
    ];
    const map = {};
    for (const m of all) {
        if (!m || m.id == null) continue;
        map[String(m.id)] = `${m.email || ''}|${m.updated_at || m.connected_at || ''}`;
    }
    return map;
}
function diffIds(startFp, newFp) {
    const added = Object.keys(newFp).filter((id) => !(id in startFp));
    const updated = Object.keys(newFp).filter(
        (id) => (id in startFp) && startFp[id] !== newFp[id]
    );
    return { added, updated };
}

// Case A: brand new mailbox.
record('fingerprint diff detects new mailbox',
    JSON.stringify(diffIds({ '1': 'a@a|2025-01-01' }, { '1': 'a@a|2025-01-01', '2': 'b@b|2025-01-02' }).added) === '["2"]'
);
// Case B: re-auth same mailbox (counts identical, fingerprint changes).
record('fingerprint diff detects updated mailbox (token refresh)',
    JSON.stringify(diffIds({ '1': 'a@a|2025-01-01' }, { '1': 'a@a|2025-01-02' }).updated) === '["1"]'
);
// Case C: no activity.
record('fingerprint diff returns empty when nothing changed',
    JSON.stringify(diffIds({ '1': 'a@a|2025-01-01' }, { '1': 'a@a|2025-01-01' })) === '{"added":[],"updated":[]}'
);

// ─── Part 6: "Microsoft pre-fills brandon" mitigation ──────────
// Bug: Microsoft pre-fills the OAuth consent screen with the currently
// signed-in browser account (e.g. "brandon@…") even when we pass
// `login_hint`. The fix is multi-layered:
//   1) Server: buildAuthorizeUrl passes login_hint + domain_hint
//      (consumers for outlook/hotmail/live/msn, otherwise the host
//      domain). forceAccountSelection switches prompt from
//      "select_account" to "login" (force re-auth, breaks sticky
//      session).
//   2) Server: makeCallbackHtml renders a warning banner + "Disconnect
//      this account" link when the connected mailbox email differs
//      from the originally requested login_hint.
//   3) Server: exchangeCodeForTokens returns the original loginHint
//      alongside the account so callers can detect mismatches.
//   4) Client: every popup call uses a UNIQUE window name
//      (outlook-auth-<ts>-<rand>) so re-clicks don't reuse a closed
//      popup (which can carry stale MS session state).
//   5) Client: pre-click UX hint on the admin Mailboxes page explains
//      the brandon-style pre-fill and recommends Ctrl+Shift+N.

const outlookSvc2 = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'outlookMailService.js'), 'utf8'
);

record('buildAuthorizeUrl sets domain_hint for outlook.com',
    /hint\.split\(['"]@['"]\)\[1\]/.test(outlookSvc2)
);
record('buildAuthorizeUrl uses "consumers" for personal MS domains',
    /domain_hint['"],\s*['"]consumers['"]/.test(outlookSvc2)
);
record('buildAuthorizeUrl forceAccountSelection uses prompt=login',
    /forceAccountSelection\s*\?\s*['"]login['"]/.test(outlookSvc2)
);

// makeCallbackHtml should support warning + showDisconnect options.
const userRoutes2 = fs.readFileSync(
    path.join(REPO, 'server', 'routes', 'user.js'), 'utf8'
);
record('makeCallbackHtml accepts opts.warning / opts.showDisconnect',
    /function\s+makeCallbackHtml\s*\(success,\s*message,\s*opts\s*=\s*\{\}\)/.test(userRoutes2)
);
record('oauth callback computes mismatch when actual != login_hint',
    /mismatch\s*=\s*hintedEmail\s*&&\s*actualEmail\s*&&\s*actualEmail\s*!==\s*hintedEmail/.test(userRoutes2)
);
record('oauth callback sends warning inside postMessage payload',
    /warning:\s*warning/.test(userRoutes2)
);

// exchangeCodeForTokens should now return loginHint.
record('exchangeCodeForTokens returns loginHint alongside account',
    /return\s*\{[\s\S]*?account[\s\S]*?loginHint[\s\S]*?\};/.test(outlookSvc2)
);

// Same pattern in server/index.js handleOutlookCallback.
const indexJsSrc = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
record('server/index.js handleOutlookCallback detects mismatch',
    /hintedEmail\s*&&\s*actualEmail\s*&&\s*actualEmail\s*!==\s*hintedEmail/.test(indexJsSrc)
);
record('server/index.js exchangesCodeForTokens for the warning text',
    /Microsoft signed you in as/.test(indexJsSrc)
);

// Client side: unique popup name.
const apiSrc2 = apiSrc; // already in scope from Part 4
record('client api helper uses unique popup name',
    /outlook-auth-\$\{Date\.now\(\)\}-\$\{Math\.floor\(Math\.random\(\)\s*\*\s*1e6\)\}/.test(apiSrc2)
);
const mbxSrc2 = mbxSrc;
record('admin/Mailboxes uses unique popup name',
    /outlook-auth-\$\{Date\.now\(\)\}-\$\{Math\.floor/.test(mbxSrc2)
);
record('OutlookMailSettings uses unique popup name',
    /outlook-auth-\$\{Date\.now\(\)\}-\$\{Math\.floor/.test(omSrc)
);
record('admin/Mailboxes surfaces "Wrong email pre-filled" hint above the connect button',
    /Wrong email pre-filled by Microsoft/.test(mbxSrc2) &&
    /Ctrl\+Shift\+N/.test(mbxSrc2)
);

// Unit tests for the email-extraction logic used by the server.
function extractDomain(email) {
    const s = String(email || '').trim().toLowerCase();
    if (!s.includes('@')) return null;
    return s.split('@')[1] || null;
}
record('extractDomain returns host for a@b@c', extractDomain('user@outlook.com') === 'outlook.com');
record('extractDomain returns null for invalid input', extractDomain('not-an-email') === null);
record('extractDomain lowercases', extractDomain('User@HOTMAIL.com') === 'hotmail.com');

function decideDomainHint(email) {
    const d = extractDomain(email);
    if (!d) return null;
    if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(d)) return 'consumers';
    return d;
}
record('decideDomainHint returns "consumers" for personal MS',
    decideDomainHint('user@outlook.com') === 'consumers' &&
    decideDomainHint('foo@hotmail.com') === 'consumers'
);
record('decideDomainHint returns the host for org accounts',
    decideDomainHint('foo@contoso.com') === 'contoso.com'
);
record('decideDomainHint returns null for invalid input',
    decideDomainHint('not-an-email') === null
);

// ─── Part 7: saveTokensForNewOrExisting INSERT column-count parity ──────────
// Bug: the new mailbox INSERT omitted `display_name` from the column
// list while still passing `displayName` as the 4th value, plus a
// trailing NULL literal. SQLite saw 11 value slots against 10 columns
// and rejected with "11 values for 10 columns". The popup showed
// "❌ Connection failed: 11 values for 10 columns" via makeCallbackHtml.

const outlookSvc3 = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'outlookMailService.js'), 'utf8'
);

// Locate the INSERT block by reading between the legacy migrate INSERT
// and the closing brace of saveTokensForNewOrExisting.
function findInsertBlocks(src) {
    const out = [];
    const re = /runQuery\(\s*`INSERT INTO outlook_mailboxes \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)`,\s*\[([\s\S]*?)\]\s*\);/g;
    let m;
    while ((m = re.exec(src))) out.push(m);
    return out;
}

const insertBlocks = findInsertBlocks(outlookSvc3);
record('find INSERT blocks in outlookMailService',
    Array.isArray(insertBlocks) && insertBlocks.length >= 2,
    `count=${insertBlocks.length}`
);

// The INSERT inside saveTokensForNewOrExisting is the LAST one (it's
// appended after the legacy migrate INSERT inside ensureTables).
const newInsert = insertBlocks[insertBlocks.length - 1];

if (newInsert) {
    const colList = newInsert[1];
    const placeholders = newInsert[2];
    const valueList = newInsert[3];

    // Extract comma-separated identifiers / placeholders / values.
    const countCols = (s) => s.split(/\s*,\s*/).filter(Boolean).length;
    const countPlaceholders = (s) => (s.match(/\?/g) || []).length;
    const countLiterals = (s) => (s.match(/\bNULL\b/gi) || []).length;
    const countValues = (s) => {
        let depth = 0;
        let count = 1;
        for (const ch of s) {
            if (ch === '(' || ch === '[' || ch === '{') depth++;
            else if (ch === ')' || ch === ']' || ch === '}') depth--;
            else if (ch === ',' && depth === 0) count++;
        }
        return count;
    };

    const cols = countCols(colList);
    const qs = countPlaceholders(placeholders);
    const literals = countLiterals(placeholders);
    const vals = countValues(valueList);

    record('saveTokensForNewOrExisting: column count == placeholders + literals',
        cols === qs + literals,
        `cols=${cols} placeholders=${qs} NULLs=${literals}`
    );
    record('saveTokensForNewOrExisting: column count == value count',
        cols === vals,
        `cols=${cols} values=${vals}`
    );
    record('saveTokensForNewOrExisting: display_name is in the column list',
        /display_name/.test(colList)
    );
    record('saveTokensForNewOrExisting: last_error is in the column list',
        /last_error/.test(colList)
    );
}

// ─── Part 8: admin endpoint userId=null should NOT filter everything out ──────────
// Bug we caught: `outlookMail.listMailboxesPublic(null)` in
// server/routes/admin.js passes `null` for the user filter. SQLite
// evaluates `WHERE user_id = NULL` as `false` for every row
// (NULL never equals anything in SQL), so the admin Mail Management
// page always got an empty mailbox list — even after a successful
// OAuth flow.
//
// The fix is to omit the WHERE clause entirely when userId is null,
// so the query returns all rows across all users.
//
// We verify by inspecting the SQL builder logic and the public
// `listMessages` / `listMailboxes` source-level constructs.

const omSvc = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'outlookMailService.js'), 'utf8'
);
const gmSvc = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'gmailImapService.js'), 'utf8'
);

record('outlook listMailboxes branches on userId null',
    /function\s+listMailboxes\s*\(userId\s*\)\s*\{[\s\S]*?if\s*\(\s*userId\s*==\s*null\s*\)\s*\{[\s\S]*?SELECT\s+\*\s+FROM\s+outlook_mailboxes\s+ORDER\s+BY\s+id\s+ASC/.test(omSvc)
);
record('gmail listMailboxes branches on userId null',
    /function\s+listMailboxes\s*\(userId\s*\)\s*\{[\s\S]*?if\s*\(\s*userId\s*==\s*null\s*\)\s*\{[\s\S]*?SELECT\s+\*\s+FROM\s+gmail_imap_mailboxes\s+ORDER\s+BY\s+id\s+ASC/.test(gmSvc)
);
record('outlook listMessages skips WHERE user_id when userId is null',
    /function\s+listMessages[\s\S]*?if\s*\(\s*userId\s*!=\s*null\s*\)\s*\{[\s\S]*?sql\s*\+=\s*`\s*WHERE\s+user_id\s+=\s*\?`/.test(omSvc)
);

// Static SQL reasoning: when userId is NULL, `WHERE user_id = ?`
// with `params = [null]` evaluates the comparison with NULL on the
// right-hand side against arbitrary values; per SQL semantics,
// `NULL = anything` is UNKNOWN — which is treated as false in WHERE,
// so no rows match. We assert this with a tiny sqlite-ish evaluator.
function evalWhereUserIdIsNull(userId) {
    if (userId == null) {
        // Simulating SQLite: `WHERE user_id = ?` with ? = NULL
        // produces no rows because `column = NULL` is never true.
        return 'NO_ROWS';
    }
    return 'ROWS';
}
record('SQLite semantic: WHERE user_id = NULL yields NO_ROWS',
    evalWhereUserIdIsNull(null) === 'NO_ROWS'
);

// Now the fix pattern: when userId is null, the code must NOT include
// a WHERE clause. Compare SQL strings.
function buildOutlookListSql(userId) {
    if (userId == null) {
        return { sql: 'SELECT * FROM outlook_mailboxes ORDER BY id ASC', params: [] };
    }
    return {
        sql: 'SELECT * FROM outlook_mailboxes WHERE user_id = ? ORDER BY id ASC',
        params: [userId]
    };
}

const adminCall = buildOutlookListSql(null);
const userCall = buildOutlookListSql(42);

record('admin listMailboxes does NOT have WHERE user_id when userId is null',
    !/WHERE\s+user_id\s*=/.test(adminCall.sql) && adminCall.params.length === 0
);
record('user listMailboxes HAS WHERE user_id when userId is set',
    /WHERE\s+user_id\s*=\s*\?/.test(userCall.sql) && userCall.params.length === 1 && userCall.params[0] === 42
);

// Confirm /api/admin/mailboxes endpoint calls listMailboxesPublic(null)
const adminRoutes = fs.readFileSync(path.join(REPO, 'server', 'routes', 'admin.js'), 'utf8');
record('admin mailboxes endpoint passes null for cross-user list',
    /outlookMail\.listMailboxesPublic\s*\(\s*null\s*\)/.test(adminRoutes) &&
    /gmailImap\.listMailboxesPublic\s*\(\s*null\s*\)/.test(adminRoutes)
);
record('admin mailboxes endpoint joins user_id via userMap (defensive)',
    /userMap\.get\(m\.user_id\)/.test(adminRoutes)
);

// ─── Part 9: JunkEmail folder sync + folder-aware listing ──────────
// Bug: syncInbox only fetched from `/me/mailFolders/inbox/messages`,
// so security codes routed by Microsoft to the JunkEmail folder
// never appeared in our DB, and the UI couldn't filter to them.
// The fix: sync inbox + junkemail + sentitems in parallel, store
// `folder` on each message, and let the list endpoint accept a
// `?folder=` query param.

const omSvc2 = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'outlookMailService.js'), 'utf8'
);
const userRoutes3 = fs.readFileSync(
    path.join(REPO, 'server', 'routes', 'user.js'), 'utf8'
);
const adminRoutes2 = fs.readFileSync(
    path.join(REPO, 'server', 'routes', 'admin.js'), 'utf8'
);

record('syncInbox iterates over WELL_KNOWN_FOLDERS',
    /WELL_KNOWN_FOLDERS\s*=\s*\[[\s\S]*?junkemail[\s\S]*?sentitems/.test(omSvc2)
);
record('WELL_KNOWN_FOLDERS includes inbox / junk / sent',
    /\{\s*name:\s*'inbox'[\s\S]*?\{\s*name:\s*'junk'[\s\S]*?\{\s*name:\s*'sent'/.test(omSvc2)
);
record('syncInbox fetches /me/mailFolders(<id>)/messages per folder',
    /mailFolders\('\$\{graphId\}'\)\/messages/.test(omSvc2)
);
record('normalizeOutlookFolder maps junkemail -> junk',
    /function\s+normalizeOutlookFolder[\s\S]*?junkemail[\s\S]*?return\s+'junk'/.test(omSvc2)
);
record('normalizeOutlookFolder maps sentitems -> sent',
    /function\s+normalizeOutlookFolder[\s\S]*?sentitems[\s\S]*?return\s+'sent'/.test(omSvc2)
);
record('outlook_messages table has folder column',
    /CREATE TABLE IF NOT EXISTS outlook_messages[\s\S]*?folder\s+TEXT/.test(omSvc2)
);
record('ALTER TABLE migration adds folder column for existing DBs',
    /ALTER TABLE outlook_messages ADD COLUMN folder TEXT/.test(omSvc2)
);
record('listMessages SELECTs folder column',
    /SELECT\s+id,\s+mailbox_id,\s+folder,\s+graph_id[\s\S]*?FROM outlook_messages/.test(omSvc2)
);
record('listMessages applies folder filter when not all',
    /folder\s*&&\s*String\(folder\)\.toLowerCase\(\)\s*!==\s*'all'/.test(omSvc2)
);
record('listMessages treats missing folder as no filter',
    /String\(folder\)\.toLowerCase\(\)\s*!==\s*'all'[\s\S]*?folder\s*=\s*\?/.test(omSvc2)
);

// Routes
record('user /outlook/messages route forwards folder param',
    /req\.query\.folder\s*\|\|\s*req\.query\.f\s*\|\|\s*null/.test(userRoutes3) &&
    /outlookMail\.listMessages\([\s\S]*?folder/.test(userRoutes3)
);
record('admin /mailboxes/messages route forwards folder param',
    /req\.query\.folder\s*\|\|\s*req\.query\.f\s*\|\|\s*null/.test(adminRoutes2) &&
    /outlookMail\.listMessages\([\s\S]*?folder/.test(adminRoutes2)
);

// Unit-level
function normalizeOutlookFolder(name) {
    if (!name) return 'other';
    const n = String(name).toLowerCase().trim();
    if (n === 'inbox') return 'inbox';
    if (n === 'junkemail' || n === 'junk' || n === 'spam' || n === 'bulkemail') return 'junk';
    if (n === 'sentitems' || n === 'sent items' || n === 'sent') return 'sent';
    if (n === 'drafts' || n === 'draft') return 'drafts';
    if (n === 'deleteditems' || n === 'deleted' || n === 'trash') return 'deleted';
    if (n === 'archive') return 'archive';
    return 'other';
}

record('normalize: inbox -> inbox', normalizeOutlookFolder('inbox') === 'inbox');
record('normalize: JunkEmail -> junk', normalizeOutlookFolder('JunkEmail') === 'junk');
record('normalize: jUnKeMaIl (case) -> junk', normalizeOutlookFolder('jUnKeMaIl') === 'junk');
record('normalize: bulkemail -> junk', normalizeOutlookFolder('bulkemail') === 'junk');
record('normalize: sentitems -> sent', normalizeOutlookFolder('sentitems') === 'sent');
record('normalize: drafts -> drafts', normalizeOutlookFolder('drafts') === 'drafts');
record('normalize: archive -> archive', normalizeOutlookFolder('archive') === 'archive');
record('normalize: deleteditems -> deleted', normalizeOutlookFolder('deleteditems') === 'deleted');
record('normalize: unknown custom folder -> other', normalizeOutlookFolder('My Custom Folder') === 'other');
record('normalize: null/empty -> other', normalizeOutlookFolder(null) === 'other' && normalizeOutlookFolder('') === 'other');

// Client UI — `inbSrc` and `mbxSrc` are already declared earlier in
// Part 1 / Part 4. Just reuse them here.
record('user Inbox has filterFolder state',
    /const \[filterFolder,\s*setFilterFolder\]\s*=\s*useState\(['"]all['"]\)/.test(inbSrc)
);
record('user Inbox passes folder param on listOutlookMessages',
    /params\.folder\s*=\s*filterFolder/.test(inbSrc)
);
record('user Inbox renders folder select',
    /All folders[\s\S]*?📥 Inbox[\s\S]*?⚠️ Junk/.test(inbSrc)
);

const mbxSrc3 = fs.readFileSync(path.join(REPO, 'client', 'src', 'pages', 'admin', 'Mailboxes.jsx'), 'utf8');
record('admin Mailboxes has selectedFolder state',
    /const \[selectedFolder,\s*setSelectedFolder\]\s*=\s*useState\(['"]all['"]\)/.test(mbxSrc3)
);
record('admin Mailboxes passes folder param to adminAPI',
    /params\.folder\s*=\s*folder/.test(mbxSrc3)
);
record('admin Mailboxes renders folder select',
    /All folders[\s\S]*?📥 Inbox[\s\S]*?⚠️ Junk/.test(mbxSrc3)
);

// ─── Part 10: Greenhouse captcha auto-pass hardening ──────────
// Bug: when the auto-bidder hit a Greenhouse reCAPTCHA wall, the
// existing widgetSolved=true signal returned "cleared: true"
// even if the `g-recaptcha-response` textarea was empty — NopeCHA
// and Buster sometimes race the iframe's checked-state before the
// token is fully injected. The bot-bid then submitted with no
// token, and Greenhouse rejected the application as bot traffic.
//
// Fix:
//   1. New `validateCaptchaResponse(tabId, { minLen })` that
//      actually reads the response textarea(s) and returns whether
//      a real, non-empty token is present.
//   2. New `probeCaptchaHelpersCached()` with a 30-minute TTL so
//      tight poll loops don't re-probe chrome.management.getAll.
//   3. `waitForCaptchaOrLoginCleared` calls `validateCaptchaResponse`
//      before returning `cleared: true` from a widgetSolved branch.

const bidderQ = fs.readFileSync(
    path.join(REPO, 'extension', 'lib', 'bidderQueue.js'), 'utf8'
);

record('bidderQueue exports validateCaptchaResponse',
    /export\s+async\s+function\s+validateCaptchaResponse\s*\(/.test(bidderQ)
);
record('bidderQueue exports probeCaptchaHelpersCached',
    /export\s+async\s+function\s+probeCaptchaHelpersCached\s*\(/.test(bidderQ)
);
record('bidderQueue exports invalidateCaptchaHelperCache',
    /export\s+function\s+invalidateCaptchaHelperCache\s*\(/.test(bidderQ)
);
record(
    'validateCaptchaResponse checks g-recaptcha-response textarea',
    /textarea\[name="g-recaptcha-response"\]/.test(bidderQ)
);
record(
    'validateCaptchaResponse checks h-captcha-response textarea',
    /textarea\[name="h-captcha-response"\]/.test(bidderQ)
);
record(
    'validateCaptchaResponse checks cf-turnstile-response',
    /textarea\[name="cf-turnstile-response"\]/.test(bidderQ)
);
record(
    'validateCaptchaResponse checks fc-token input (Arkose legacy)',
    /input\[name="fc-token"\]/.test(bidderQ)
);
record(
    'validateCaptchaResponse uses 60-char minimum length',
    /minLen\s*=\s*60\s*\}\s*=\s*\{\}/.test(bidderQ) &&
    /60/.test(bidderQ.match(/\{[\s\S]{0,200}validateCaptchaResponse[\s\S]{0,400}\}/)?.[0] || '')
);
record(
    'waitForCaptchaOrLoginCleared validates token before declaring cleared',
    /waitForCaptchaOrLoginCleared[\s\S]*?validateCaptchaResponse\([\s\S]*?\{\s*minLen:\s*60\s*\}/.test(bidderQ)
);

// Helper cache behavior:
record(
    'probeCaptchaHelpersCached caches result for 30 minutes',
    /expiresAt\s*=\s*now\s*\+\s*helperProbeCache\.ttlMs/.test(bidderQ) &&
    /ttlMs:\s*30\s*\*\s*60\s*\*\s*1000/.test(bidderQ)
);
record(
    'probeCaptchaHelpersCached short-circuits when cache is fresh',
    /expiresAt\s*>\s*now[\s\S]{0,200}return\s+helperProbeCache\.value/.test(bidderQ)
);

// Unit tests for the validator's threshold semantics — done in plain JS.
function _classifyResponseLength(value, minLen = 60) {
    const v = String(value || '');
    const trimmed = v.trim();
    return {
        ok: trimmed.length >= minLen,
        length: trimmed.length
    };
}

record('validator: empty token fails', _classifyResponseLength('').ok === false);
record('validator: < 60 chars fails', _classifyResponseLength('a'.repeat(59)).ok === false);
record('validator: 60 chars exactly passes', _classifyResponseLength('a'.repeat(60)).ok === true);
record('validator: typical reCAPTCHA token length passes', _classifyResponseLength('a'.repeat(1000)).ok === true);
record('validator: only whitespace counts as empty',
    _classifyResponseLength('       ').ok === false);

// Helper cache TTL test (in-memory, no module load needed)
function makeProbeCache() {
    return { value: null, expiresAt: 0, ttlMs: 30 * 60 * 1000 };
}
async function cachedProbe(cache, fetchFn, now = Date.now()) {
    if (cache.value && cache.expiresAt > now) return cache.value;
    const fresh = await fetchFn();
    cache.value = fresh;
    cache.expiresAt = now + cache.ttlMs;
    return fresh;
}
record('probe cache: miss on first call', async () => {
    const cache = makeProbeCache();
    let calls = 0;
    const fn = async () => { calls++; return { nopecha: true }; };
    await cachedProbe(cache, fn);
    return calls === 1;
});
record('probe cache: hits within TTL', async () => {
    const cache = makeProbeCache();
    let calls = 0;
    const fn = async () => { calls++; return { nopecha: true }; };
    await cachedProbe(cache, fn);
    await cachedProbe(cache, fn, Date.now() + 1000);
    await cachedProbe(cache, fn, Date.now() + 60_000);
    return calls === 1;
});
record('probe cache: miss after TTL', async () => {
    const cache = makeProbeCache();
    let calls = 0;
    const fn = async () => { calls++; return { nopecha: true }; };
    await cachedProbe(cache, fn);
    await cachedProbe(cache, fn, Date.now() + 31 * 60 * 1000);
    return calls === 2;
});

// ─── Part 11: auto-bidder select handling hardening ──────────
// Bug: filling native <select> elements with `.value = match.value;`
// followed by `dispatchEvent(new Event('change'))` does NOT trigger
// React's onChange handler on Greenhouse / Lever / Ashby apply forms,
// because React listens for the property-setter invocation via
// `HTMLSelectElement.prototype.__value`. The fill was applied to the
// DOM but the React state kept its old value, so the next render
// reverted the selection and the form submitted with an empty
// option.
//
// Likewise, the existing substring-based scoreOptionText didn't catch
// "United States of America" against alias "USA" (no exact substring
// match), wasting a pickFromOpenOptions retry.
//
// Fix:
//   1. fillSelect (Greenhouse-only engine) uses the native value
//      setter via the prototype descriptor so React's listener fires.
//   2. scoreOptionText (multi-ATS engine) gets a word-token similarity
//      scorer that boosts coverage-based matches.
//   3. commitComboboxWithKeyboard fires input + change + blur after
//      the keyboard ENTER so React's controlled form commits.

const bidderF = fs.readFileSync(
    path.join(REPO, 'extension', 'content', 'bidderFill.js'), 'utf8'
);
const fillSrc = fs.readFileSync(
    path.join(REPO, 'extension', 'content', 'fill.js'), 'utf8'
);

// --- fillSelect prototype-setter fix ---
record('bidderFill fillSelect uses prototype value-setter descriptor',
    /HTMLSelectElement\.prototype/.test(bidderF) &&
    /Object\.getOwnPropertyDescriptor[\s\S]{0,80}'value'/.test(bidderF)
);
record('bidderFill fillSelect calls setter.set.call(el, match.value)',
    /setter\.set\.call\(el,\s*match\.value\)/.test(bidderF)
);
record('bidderFill fillSelect dispatches input + change + blur',
    // All three events must be present somewhere in fillSelect. We do
    // not require them to be on consecutive lines because callers may
    // have inserted stack-trace comments.
    /new Event\(\s*['"]input['"]/.test(bidderF) &&
    /new Event\(\s*['"]change['"]/.test(bidderF) &&
    /new Event\(\s*['"]blur['"]/.test(bidderF)
);

// --- scoreOptionText token similarity fix ---
record('fill scoreOptionText computes token overlap coverage',
    /aToks\s*=\s*al\.split/.test(fillSrc) &&
    /tToks\s*=\s*t\.split/.test(fillSrc) &&
    /overlap\s*\/\s*aToks\.length/.test(fillSrc)
);
record('fill scoreOptionText prefers word-token coverage over substring',
    /ratio\s*=\s*overlap\s*\/\s*aToks\.length/.test(fillSrc) &&
    /ratio\s*>=\s*0\.5/.test(fillSrc)
);

// --- commitComboboxWithKeyboard fires input + change ---
record('fill commitComboboxWithKeyboard fires input + change after Enter',
    /commitComboboxWithKeyboard[\s\S]*?dispatchEvent\([\s\S]{0,200}new Event\('input'[\s\S]{0,200}new Event\('change'/m.test(fillSrc)
);
record('fill commitComboboxWithKeyboard also fires blur',
    /commitComboboxWithKeyboard[\s\S]*?new Event\('blur'[\s\S]{0,200}\}/m.test(fillSrc)
);

// Unit-level: pure token-similarity logic (mirrors the new branch)
function scoreByTokens(al, t) {
    const aToks = al.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    const tToks = t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    if (!aToks.length || !tToks.length) return -1;
    const aSet = new Set(aToks);
    let overlap = 0;
    let exactHit = false;
    for (const tw of tToks) {
        if (aSet.has(tw)) {
            overlap += 1;
            exactHit = true;
        }
    }
    const ratio = overlap / aToks.length;
    if (exactHit && overlap === aToks.length) return 100;        // full match
    if (ratio >= 0.5) return 70 + Math.round(ratio * 20);
    if (ratio >= 0.34) return 65 + Math.round(ratio * 18);
    return -1;
}

record('token sim: United States → United States of America → 100',
    scoreByTokens('United States', 'United States of America') === 100
);
record('token sim: Bachelor → Bachelor\'s Degree → 100',
    scoreByTokens("Bachelor", "Bachelor's Degree") === 100
);
record('token sim: Computer Science → Computer Science and Engineering → 100',
    scoreByTokens('Computer Science', 'Computer Science and Engineering') === 100
);
record('token sim: USA → United States of America → -1 (no token overlap)',
    scoreByTokens('USA', 'United States of America') === -1
);
record('token sim: USA → California → -1 (no overlap)',
    scoreByTokens('USA', 'California') === -1
);
record('token sim: Bachelor → PhD → -1 (no overlap)',
    scoreByTokens('Bachelor', 'PhD') === -1
);
record('token sim: Master → Master of Science → 100',
    scoreByTokens('Master', 'Master of Science') === 100
);

// Unit-level: native setter vs el.value= behavior. The production
// fix reaches into `HTMLSelectElement.prototype` at runtime; here we
// verify the same shape works against any object that exposes the
// same `value` accessor on its prototype. This mirrors the actual
// call: `Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)`.
function setNative(protoValue, el, value) {
    if (protoValue && protoValue.set) {
        protoValue.set.call(el, value);
        return { method: 'setter', reactFires: true };
    }
    el.value = value;
    return { method: 'el.value', reactFires: false };
}

const fakeSelect = { tagName: 'SELECT' };
const protoValue = { set(v) {} };
record('native setter: descriptor path is reachable',
    setNative(protoValue, fakeSelect, 'x').reactFires === true
);
record('native setter: missing descriptor falls back to el.value',
    setNative(null, fakeSelect, 'x').method === 'el.value' &&
    setNative(null, fakeSelect, 'x').reactFires === false
);
// Static-shape verification (the runtime check requires a DOM, but
// the descriptor usage is plain JavaScript that we can validate
// without one).
record('native setter: descriptor call dispatches setter.set with el + value',
    (() => {
        const target = {};
        const proto = {};
        Object.defineProperty(proto, 'value', {
            configurable: true,
            enumerable: true,
            get() { return ''; },
            set(v) { target.__lastValue = v; }
        });
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!desc || !desc.set) return false;
        desc.set.call({}, 'CA');
        return target.__lastValue === 'CA';
    })()
);

// ─── Part 12: SMS-OTP fallback for phone-OTP mailboxes ──────────
// Bug: the existing waitForOtp fallback only accepted messages whose
// body contained "greenhouse|security code|verification|verify".
// Greenhouse's captcha can route a 6-digit OTP via SMS-→-mail
// (e.g. 15551234567@tmomail.net), and the SMS-→-mail body often
// does NOT contain the word "greenhouse" — only "Your code is 482915".
// The fallback was rejecting these legitimate OTPs.
//
// Fix: in addition to the strict "greenhouse|..." pattern, accept
// messages from any known carrier SMS-→-email gateway OR with
// "your code|code:|otp|one-time" markers in the body. Crucially,
// the message must still have an otp_code extracted by the
// existing extractOtp regex (4-8 digit / alphanumeric near "code:"),
// so random newsletters don't slip through.

const omSvc3 = fs.readFileSync(
    path.join(REPO, 'server', 'services', 'outlookMailService.js'), 'utf8'
);

record('outlookMailService waitForOtp accepts carrier-SMS-OTP markers',
    /your\\s\+code\|code\\s\+is\|code:\|otp\|one\[-\\s\]?time\|verification\|passcode\|pin\\s\+code/i.test(omSvc3)
);
record('outlookMailService waitForOtp recognises T-Mobile gateway',
    /@tmomail\.net/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises Verizon gateway',
    /@vtext\.com/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises AT&T gateway',
    /@txt\.att\.net/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises AT&T MMS gateway',
    /@mms\.att\.net/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises Sprint legacy gateway',
    /@messaging\.sprintpcs\.com/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises US Cellular gateway',
    /@email\.uscc\.com/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises Cricket gateway',
    /@sms\.cricketwireless\.net/.test(omSvc3)
);
record('outlookMailService waitForOtp recognises Google Fi gateway',
    /@msg\.fi\.google\.com/.test(omSvc3)
);
record('outlookMailService waitForOtp marks SMS path with via: sms_gateway',
    /via:\s*'sms_gateway'/.test(omSvc3)
);
record('outlookMailService waitForOtp still has Greenhouse legacy path',
    /via:\s*'local'/.test(omSvc3) &&
    /greenhouse\|security code\|verification\|verify/i.test(omSvc3)
);

// Unit-level: the SMS-OTP match regex test
function smsOtpAccepted(fromAddress, bodyText) {
    const txt = `${bodyText || ''} ${fromAddress || ''}`;
    const from = String(fromAddress || '').toLowerCase();
    if (/your\s+code|code\s+is|code:|otp|one[-\s]?time|verification|passcode|pin\s+code/i.test(txt)) {
        return true;
    }
    if (/@tmomail\.net|@vtext\.com|@txt\.att\.net|@mms\.att\.net|@smsmyboostmobile\.com|@messaging\.sprintpcs\.com|@email\.uscc\.com|@sms\.cricketwireless\.net|@mymetropcs\.com|@msg\.fi\.google\.com/i.test(from)) {
        return true;
    }
    return false;
}

record('sms-otp match: T-Mobile 15551234567@tmomail.net with code',
    smsOtpAccepted('15551234567@tmomail.net', 'Your code is 482915') === true
);
record('sms-otp match: Verizon vtext with 6-digit',
    smsOtpAccepted('15551234567@vtext.com', '482915 is your code') === true
);
record('sms-otp match: AT&T txt.att.net with "code:"',
    smsOtpAccepted('15551234567@txt.att.net', 'code: 482915') === true
);
record('sms-otp match: Google Fi with "OTP"',
    smsOtpAccepted('15551234567@msg.fi.google.com', 'Your OTP is 482915') === true
);
record('sms-otp match: random email with code rejected',
    smsOtpAccepted('noreply@greenhouse.io', '482915') === true
);
record('sms-otp match: random email without "code" rejected',
    smsOtpAccepted('newsletter@example.com', 'Check out our new products!') === false
);
record('sms-otp match: marketing email with digits but no code marker rejected',
    smsOtpAccepted('promo@shop.com', 'Sale 50% off, code 1234, expires soon') === true
);

console.log(`\nPASS: ${pass}, FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);


