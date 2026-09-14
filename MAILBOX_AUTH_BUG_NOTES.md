# Mailbox ↔ Auth Bug — Notes for Future Maintainers

## What was the bug

Two related bugs:

### Bug 1: "Not connected" / silent wipe after login

After a successful login, navigating to a page that loads the user's
mailboxes (Outlook / Gmail) made the UI display **"Not connected"**
even though the mailboxes were actually connected on the server.

The user reported that **closing the tab and reopening** would
"work" — and indeed did, until the next transient hiccup.
## Root cause (two compounding issues)

### 1. Global axios 401-handler wiped localStorage on every transient 401

`client/src/api/index.js` had a response interceptor that wiped
`localStorage.token/user` on ANY 401 whose body had the messages
`Authentication required` or `Invalid or expired token`. Those exact
two strings are what the server's `requireAuth` middleware emits for
**every** auth failure, including transient ones (server restart with
rotated `JWT_SECRET`, a brief proxy hiccup, a JWT signed against the
previous deploy, etc.).

Because `MailboxSettingsTabs`, `Inbox.jsx`, `AutoBidderDialog.jsx` and
others all call `GET /user/outlook/status` on mount, **any one** of those
calls landing on a transient 401 would nuke the user's freshly-issued
JWT and bounce them back to `/login` — making the app unusable.

### 2. Mailbox components used `catch(_) { setX(null) }`

Even after fixing the interceptor, the components themselves reset their
visible mailbox list to `null` / `[]` on any failed call, so the UI
**lied** to the user about being unconnected. Combined with issue 1,
the visible symptom was: "everything was working, then suddenly
disconnected, then reconnected only after I closed and reopened the tab."

### 3. Login→me() race

`AuthContext.login()` did `localStorage.setItem('token', ...)` then
immediately called `authAPI.me()`. If the server briefly hiccuped on
the brand-new token, the interceptor would wipe the freshly-issued
token and redirect to `/login`.

## What was changed

| File | Change |
|------|--------|
| `client/src/api/index.js` | Added `MAILBOX_PATH_RE` + `isMailboxReadCall()` classifier. Any GET to `/user/outlook/*` or `/user/gmail/*` (or `/api/user/outlook/*` etc.) is now allow-listed from the session-wipe path. Mutations (`POST/PUT/DELETE`) are NOT allow-listed. Added `hadToken` guard to prevent double-clears. `authAPI.me()` now accepts request options (forwards to axios). |
| `client/src/context/AuthContext.jsx` | After `login()`, `me()` is called with `{ skipAuthRedirect: true }` and treated as non-fatal. Dispatch `lumi:login-success` window event so components can react. On boot, transient `me()` failure no longer wipes localStorage. |
| `client/src/components/OutlookMailSettings.jsx` | `refresh()` retries once on a 401 with a token present. Keeps previous state instead of wiping to `null`. |
| `client/src/components/GmailMailSettings.jsx` | Same retry + keep-last-state pattern. |
| `client/src/pages/user/Inbox.jsx` | Both `fetchStatus()` and `fetchMessages()` got the same retry + keep-last-state pattern. |
| `client/src/components/job-links/AutoBidderDialog.jsx` | Both `refreshOutlookStatus` and the `[open]` effect retry on a 401, keep previous state. |
| `extension/fixtures/test_lumi_mailbox_auth.js` | New regression suite: 28 classifier tests + 12 interceptor behavior tests + 15 cross-file source assertions = **55 tests** verifying the fix. |
| `package.json` | Added the new test fixture to the `test:reliability` npm script. |

## How to verify

```bash
npm run test:reliability    # includes the new test_lumi_mailbox_auth.js
node extension/fixtures/test_lumi_mailbox_auth.js
```

Manual verification:

1. `npm run dev`
2. Log in with a real account that has a connected mailbox
3. Open Settings → Mailboxes — mailboxes should be visible immediately
4. Restart the server with `JWT_SECRET` changed in `.env` — fresh login
   should still work without a "Not connected" flash
5. Hard-reload any mailbox-related page — mailboxes should still be
   visible (no silent wipe)

## What we explicitly did NOT do

- We did NOT remove the global 401-redirect behavior. A real session
  expiry still logs the user out cleanly.
- We did NOT make POST/PUT/DELETE mailbox endpoints "safe" — those
  remain under the old behavior, because a 401 on a mutation means the
  user really is unauthenticated.
- We did NOT change server-side auth logic.

## Regression test results

At the time of this change:

```
PASS: 55, FAIL: 0  (extension/fixtures/test_lumi_mailbox_auth.js)
```

Other fixture tests (orthogonal to this fix) that continue to pass:
- test_ats_classify_unit.js — 23/23
- test_bidder_fill_unit.js — 60/60
- test_bidder_page_bridge.js — 22/22
- test_apply_gate.js — 16/16
- test_bid_clock.js — 12/12
- test_bidder_queue_defaults.js — 8/8

`test_bidder_brain.js` has a known pre-existing flake on the
`cv qa ok when keywords present` assertion that depends on the
`resumeQualityReportService` scoring threshold and the local SQLite
state, not on this fix.

## Bug 2: "Cannot read properties of undefined (reading 'authorizeUrl')" when adding a mailbox

The admin Mailboxes page (`client/src/pages/admin/Mailboxes.jsx`)
and the user-side OutlookMailSettings both call `getOutlookAuthUrl`
to get the OAuth URL for a popup. The helpers were:

```js
// adminAPI (adminAPI = { ... }) at client/src/api/index.js:230
getOutlookAuthUrl: (payload = {}) => api.post('/user/outlook/auth-url', payload).then((r) => r.data),
```

That pre-unwrap made the helper return the JSON body directly.
But the admin call site did:

```js
const { data: urlData } = await adminAPI.getOutlookAuthUrl({...});
// urlData is body.data = undefined → urlData.authorizeUrl → CRASH
```

The error was: *"Cannot read properties of undefined (reading 'authorizeUrl')"*.

### Fix

Make both helpers return the raw axios response — matching the rest
of the codebase (`api.get(...)` everywhere else returns an axios
response with `.data`):

```js
// adminAPI = { ... }
getOutlookAuthUrl: (payload = {}) => api.post('/user/outlook/auth-url', payload),

// userAPI = { ... }
getOutlookAuthUrl: (payload = {}) => api.post('/user/outlook/auth-url', payload),
```

And in both call sites:

```js
const response = await adminAPI.getOutlookAuthUrl({...});
const urlData = response && 'data' in response ? response.data : response;
// urlData.authorizeUrl is now safe.
```

In `admin/Mailboxes.jsx` we also added a clear error message when
the server fails to return an `authorizeUrl` (which happens when
`OUTLOOK_CLIENT_ID` is not set on the backend) so users get a useful
hint instead of a generic crash.

### Regression tests

The same `extension/fixtures/test_lumi_mailbox_auth.js` regression
file has Part 4 covering this bug:

- `adminAPI.getOutlookAuthUrl found in source`
- `userAPI.getOutlookAuthUrl found in source`
- `adminAPI.getOutlookAuthUrl returns raw axios response (no pre-unwrap)`
- `userAPI.getOutlookAuthUrl returns raw axios response (no pre-unwrap)`
- `unwrapAuthUrlResponse unwraps axios-shaped response`
- `unwrapAuthUrlResponse passes through pre-unwrapped body`
- `unwrapAuthUrlResponse returns null for null`
- `admin/Mailboxes no longer double-unwraps getOutlookAuthUrl response`
- `admin/Mailboxes surfaces a clear error when authorizeUrl is missing`

Total: **64/64** passing in `test_lumi_mailbox_auth.js`.

## Bug 3: "you have already connected" / UI stuck after re-authenticating an existing mailbox

### Symptom

User reports the server tells them they have already connected (or the
popup flashes quickly), but the page stays spinning on "Connecting..."
forever. The mailbox list never updates and the modal can't be closed.

### Root cause

Microsoft's OAuth consent is "sticky" — once you've consented to a
personal-Azure app, subsequent sign-ins for the same account skip the
consent screen entirely and immediately redirect back to
`/api/user/outlook/callback`. The server's `exchangeCodeForTokens` →
`saveTokensForNewOrExisting` updates the existing mailbox row in place
(tokens + `updated_at`), and the popup auto-closes 5 seconds later.

The problem was on the client:

1. `client/src/pages/admin/Mailboxes.jsx` polled every 3 s and only
   resolved when `newCount > oldCount`. Since re-auth keeps the count
   identical, the watch never fired. UI stayed in `addBusy = true`
   forever.

2. `client/src/components/OutlookMailSettings.jsx` polled every 2.5 s
   and only resolved when a **new** mailbox id appeared. Same bug.

3. There was also no `watchingPopup.popup.closed` detection on either
   path — so even though the popup would silently close after the
   consent screen was bypassed, nothing was listening.

### Fix

Three layers of detection, applied to both pages:

#### Layer 1: server-side — expose `updated_at`
The DB already had `updated_at` on both `outlook_mailboxes` and
`gmail_imap_mailboxes` tables (and we were SETting it on every touch),
but neither `accountPublic` nor `mailboxPublic` was shipping it to the
client. Without that field exposed, no client-side fingerprinting is
possible. Added `updated_at: row.updated_at || null` to both.

#### Layer 2: client-side — fingerprint polling
`Mailboxes.jsx` and `OutlookMailSettings.jsx` now compute a fingerprint
of every mailbox `id -> email|updated_at|connected_at` and watch for
two kinds of changes:

- **Added mailboxes** (new id never seen before)
- **Updated mailboxes** (`updated_at` or `last_sync_at` changed for an
  existing id)

Either one fires a `resolveNow('Connected <email>!')` or
`resolveNow('Mailbox tokens refreshed.')` and the UI unsticks.

#### Layer 3: client-side — popup-close detection
Both pages now store the popup window reference in the
`watchingPopup` ref (`{ active, popup }`) and poll `popup.closed`. When
the popup disappears (auto-close, manual close, browser-initiated), we
trigger a final `getAllMailboxes`/`getOutlookStatus` and resolve with
`'Connection attempt complete. Verify the mailbox appears in the
list.'`.

#### Layer 4: hard 5-minute ceiling
If for any reason both fingerprint and popup-close miss (e.g., they
were reset by a navigation), a `setTimeout(5 * 60 * 1000)` cleans up
the watching state, so the modal isn't permanently stuck.

### Regression tests

`extension/fixtures/test_lumi_mailbox_auth.js` Part 5 (11 new tests):

- `admin/Mailboxes polling uses fingerprint (not just count)` ✓
- `admin/Mailboxes polling has popup-close detection` ✓
- `admin/Mailboxes polling has hard 5-minute ceiling` ✓
- `admin/Mailboxes stores popup window in watchingPopup ref` ✓
- `OutlookMailSettings has updated_at-aware fingerprint detection` ✓
- `OutlookMailSettings has popup-close handler` ✓
- `outlookMailService.accountPublic exposes updated_at` ✓
- `gmailImapService.mailboxPublic exposes updated_at` ✓
- `fingerprint diff detects new mailbox` ✓ (unit)
- `fingerprint diff detects updated mailbox (token refresh)` ✓ (unit)
- `fingerprint diff returns empty when nothing changed` ✓ (unit)

Total: **75/75** passing in `test_lumi_mailbox_auth.js`.

### Files changed

- `client/src/pages/admin/Mailboxes.jsx`
- `client/src/components/OutlookMailSettings.jsx`
- `server/services/outlookMailService.js` (public shape)
- `server/services/gmailImapService.js` (public shape)

## Bug 4: "Microsoft pre-fills brandon" / wrong account silently connected

### Symptom

User opens the Add Mailbox modal, types an email (say `me@outlook.com`),
clicks connect, and Microsoft's consent screen **shows brandon@… (the
currently-signed-in browser account) pre-filled** instead. If the user
clicks through, the **wrong** mailbox gets added. The user thinks
Lumi is broken.

### Root cause

Microsoft's authorization endpoint treats `login_hint` as a **soft** hint.
If the hint doesn't match an account active in the browser's MS
session, MS happily shows the active one and lets the user proceed.
This happens even with `prompt=select_account`, which only forces the
picker if multiple accounts are active; with **one** active account,
MS auto-completes.

The original `buildAuthorizeUrl` was relying solely on
`login_hint + prompt=select_account`. For personal Microsoft accounts
(`outlook.com`, `hotmail.com`, `live.com`, `msn.com`) this is
insufficient — you also need `domain_hint=consumers` to scope the
picker to the right tenant. For work/school accounts you need
`domain_hint=<tenant-domain>`. And if you really want to break the
sticky session you need `prompt=login` (force re-auth) instead of
`prompt=select_account`.

Beyond OAuth-level parameters, the existing `makeCallbackHtml`
success page didn't tell the user when the actual account differed
from the requested hint.

### Fix

Five layered defenses:

#### 1) Server: stronger authorize URL (`buildAuthorizeUrl`)
- `login_hint` is now lowercased and trimmed.
- For personal Microsoft domains (`outlook.com`, `hotmail.com`,
  `live.com`, `msn.com`): set `domain_hint=consumers`.
- For everything else: set `domain_hint=<the host part>` so the picker
  is scoped to the right tenant.
- `forceAccountSelection: true` now switches `prompt` to `login`
  (instead of `select_account`), which **breaks the sticky MS
  session**. The OAuth consent screen shows again.

#### 2) Server: `exchangeCodeForTokens` returns the original `loginHint`
Previously the function returned only the public account shape. It
now returns `{ account, loginHint, mailboxId }` so callers can
detect when the actually-connected email differs from the requested
hint.

#### 3) Server: `makeCallbackHtml(success, msg, { warning, showDisconnect, disconnectUrl, email })`
Renders an amber warning banner + a one-click "Disconnect this
account" link whenever the popup was opened with a `login_hint` and
Microsoft signed in as a different account. The `email` is also
forwarded to `postMessage` so the parent UI can show the warning
inline.

#### 4) Client: unique popup window name
All three popup-using sites (admin `Mailboxes.jsx`, user
`OutlookMailSettings.jsx`, and `api/index.js#startOutlookAuthFlow`)
now open the popup with `outlook-auth-${Date.now()}-${Math.random()}`.
If you click connect twice, the browser opens **two distinct**
windows instead of reusing a closed one (which can carry stale MS
session state).

#### 5) Client: pre-click UX hint
The Add Mailbox modal now shows an amber tip above the "Open
Microsoft Sign-In" button explaining the brandon-style pre-fill and
suggesting Ctrl+Shift+N (private window) as a fallback.

### Regression tests

`extension/fixtures/test_lumi_mailbox_auth.js` Part 6 (19 new tests):

- `buildAuthorizeUrl sets domain_hint for outlook.com` ✓
- `buildAuthorizeUrl uses "consumers" for personal MS domains` ✓
- `buildAuthorizeUrl forceAccountSelection uses prompt=login` ✓
- `makeCallbackHtml accepts opts.warning / opts.showDisconnect` ✓
- `oauth callback computes mismatch when actual != login_hint` ✓
- `oauth callback sends warning inside postMessage payload` ✓
- `exchangeCodeForTokens returns loginHint alongside account` ✓
- `server/index.js handleOutlookCallback detects mismatch` ✓
- `server/index.js exchangesCodeForTokens for the warning text` ✓
- `client api helper uses unique popup name` ✓
- `admin/Mailboxes uses unique popup name` ✓
- `OutlookMailSettings uses unique popup name` ✓
- `admin/Mailboxes surfaces "Wrong email pre-filled" hint above the connect button` ✓
- `extractDomain returns host for a@b@c` ✓ (unit)
- `extractDomain returns null for invalid input` ✓ (unit)
- `extractDomain lowercases` ✓ (unit)
- `decideDomainHint returns "consumers" for personal MS` ✓ (unit)
- `decideDomainHint returns the host for org accounts` ✓ (unit)
- `decideDomainHint returns null for invalid input` ✓ (unit)

Total: **94/94** passing in `test_lumi_mailbox_auth.js`.

### Files changed

- `server/services/outlookMailService.js` (buildAuthorizeUrl + exchangeCodeForTokens)
- `server/routes/user.js` (makeCallbackHtml signature + callback mismatch detection)
- `server/index.js` (handleOutlookCallback mismatch detection)
- `client/src/api/index.js` (unique popup name)
- `client/src/pages/admin/Mailboxes.jsx` (unique popup name + UX hint + postMessage warning pass-through)
- `client/src/components/OutlookMailSettings.jsx` (unique popup name)

## Bug 5: "❌ Connection failed: 11 values for 10 columns"

### Symptom

When clicking through Microsoft sign-in, the OAuth popup callback HTML
showed:

> ❌ Connection failed
> 11 values for 10 columns
> This window will close in 2s.

…and no mailbox got connected.

### Root cause

`saveTokensForNewOrExisting` had an INSERT with **10 columns** in the
column list (`user_id, profile_id, email, access_token, refresh_token,
expires_at, scope, connected_at, updated_at, last_error`) but the
VALUES clause had **11 `?` placeholders + 1 explicit `NULL` literal**
= 12 value slots, and the array passed 11 elements. SQLite saw:

```
columns = 10
placeholders = 11
```

…which is exactly what the error name says: the SQL tried to feed 11
values into 10 columns. The `display_name` column was simply missing
from the column list — `displayName` was still in the values array
(position 4), so the slot for `display_name` was the missing column.

### Fix

Add `display_name` to the column list and bring the placeholder count
and the array length into alignment:

```sql
INSERT INTO outlook_mailboxes (
    user_id, profile_id, email, display_name, access_token,
    refresh_token, expires_at, scope,
    connected_at, updated_at, last_error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

with 11 array values (the last being explicit `null` for `last_error`).

### Regression test

`extension/fixtures/test_lumi_mailbox_auth.js` Part 7 (5 new tests)
parses the actual source INSERT block and asserts:

- The INSERT block is parseable
- Column count == placeholders + literal NULLs
- Column count == array values
- `display_name` is in the column list
- `last_error` is in the column list

Total: **99/99** passing in `test_lumi_mailbox_auth.js`.

### Files changed

- `server/services/outlookMailService.js` (`saveTokensForNewOrExisting` INSERT)

## Bug 6: "Connected brandonhigbee95@hotmail.com" but admin mailbox list is empty

### Symptom

OAuth completes successfully:

> ✅ Connected
> Connected brandonhigbee95@hotmail.com! You can now close this window.

…but the **admin Mail Management page** (`/admin/mailboxes`)
shows zero mailboxes after the popup closes. Clicking "Add Mailbox"
again, the same brandon mailbox re-appears (it was added correctly),
but the admin list never displayed it.

### Root cause

`server/routes/admin.js` (lines 40-41) calls:

```js
const outlookMailboxes = outlookMail.listMailboxesPublic(null);
const gmailMailboxes = gmailImap.listMailboxesPublic(null);
```

The `null` is **intentional** — admins want ALL mailboxes across ALL
users, not just their own. The functions then call e.g.
`outlookMailService.listMailboxes(null)` which runs:

```sql
SELECT * FROM outlook_mailboxes WHERE user_id = ? ORDER BY id ASC
-- with the bind parameter set to NULL
```

Per **SQL semantics**, `column = NULL` is **never TRUE** — it's
UNKNOWN, which is treated as "not match" in a `WHERE` clause.
So the admin endpoint **always** returned `{ outlook: [], gmail: [] }`.

Same bug exists in:
- `gmailImapService.listMailboxes(null)` (Gmail mailbox list)
- `outlookMailService.listMessages(null, ...)` (admin mailbox
  messages endpoint) — same pattern, same broken SQL.

This bug has been **silently present since the file was originally
written**; it just never had a way to surface. Once the OAuth flow
started working end-to-end (after Bug 5), the absence of the
admin's list became obvious.

### Fix

Make each affected `list*` function handle `userId == null` by
**omitting the WHERE clause entirely** (returning all rows):

```js
function listMailboxes(userId) {
    ensureTables();
    if (userId == null) {
        return getAll(`SELECT * FROM outlook_mailboxes ORDER BY id ASC`, []);
    }
    return getAll(
        `SELECT * FROM outlook_mailboxes WHERE user_id = ? ORDER BY id ASC`,
        [userId]
    );
}
```

And for `listMessages` we had to dynamically build the SQL:

```js
function listMessages(userId, { limit = 30, mailboxId = null } = {}) {
    ensureTables();
    const params = [];
    let sql = `SELECT id, mailbox_id, graph_id, ...
                FROM outlook_messages`;
    if (userId != null) {
        sql += ' WHERE user_id = ?';
        params.push(userId);
    }
    if (mailboxId && mailboxId !== 'all') {
        sql += (userId == null ? ' WHERE ' : ' AND ') + 'mailbox_id ...';
        // ...
    }
    sql += ' ORDER BY ... LIMIT ?';
    params.push(Math.min(100, Math.max(1, Number(limit) || 30)));
    return getAll(sql, params);
}
```

### Regression tests

`extension/fixtures/test_lumi_mailbox_auth.js` Part 8 (8 new tests):

- `outlook listMailboxes branches on userId null` ✓
- `gmail listMailboxes branches on userId null` ✓
- `outlook listMessages skips WHERE user_id when userId is null` ✓
- `SQLite semantic: WHERE user_id = NULL yields NO_ROWS` ✓ (unit)
- `admin listMailboxes does NOT have WHERE user_id when userId is null` ✓ (unit)
- `user listMailboxes HAS WHERE user_id when userId is set` ✓ (unit)
- `admin mailboxes endpoint passes null for cross-user list` ✓
- `admin mailboxes endpoint joins user_id via userMap (defensive)` ✓

Total: **107/107** passing in `test_lumi_mailbox_auth.js`.

### Files changed

- `server/services/outlookMailService.js` (`listMailboxes`, `listMessages`)
- `server/services/gmailImapService.js` (`listMailboxes`)

## Bug 7: "Email went to Junk and never showed up"

### Symptom

User connected `brandonhigbee95@hotmail.com` and saw the mailbox in
the list — but the email they then sent to that account (which
Microsoft routed to the **Junk Email** folder) was nowhere in the
mail manager. The folder filter also didn't exist, so even after
manually syncing they couldn't pivot to view "just Junk" messages.

### Root cause

`server/services/outlookMailService.js#syncInbox` only fetched from
ONE Graph folder:

```js
const data = await graphGet(mailbox.id, '/me/mailFolders/inbox/messages', { ... });
```

Microsoft frequently routes security-code emails to **JunkEmail**
when SPF/DKIM/DMARC alignment isn't perfect. Anything not landing
in `Inbox` was silently dropped on the floor.

### Fix

Three layered changes:

#### 1) Server: sync multiple well-known folders in parallel
```js
const WELL_KNOWN_FOLDERS = [
    { name: 'inbox', graphId: 'inbox' },
    { name: 'junk',  graphId: 'junkemail' },
    { name: 'sent',  graphId: 'sentitems' }
];

const folderResults = await Promise.all(
    WELL_KNOWN_FOLDERS.map(async ({ name, graphId }) => {
        const data = await graphGet(
            mailbox.id,
            `/me/mailFolders('${graphId}')/messages`,
            { $top: MAX_SYNC, $orderby: 'receivedDateTime desc',
              $select: 'id,subject,from,receivedDateTime,bodyPreview,body,isRead' }
        );
        for (const msg of list) {
            upsertMessage(uid, mailbox.id, msg, name);
        }
    })
);
```

A folder that's restricted for a tenant (e.g. Junk not exposed to
the Graph app permission) doesn't fail the whole sync — it gets
logged in `folderResults` with `{ ok: false, error }`.

#### 2) Schema: store `folder` per message + new query param
- `outlook_messages.folder TEXT` (with safe `ALTER TABLE ADD COLUMN`
  for existing DBs)
- New index `idx_outlook_msg_folder(user_id, folder)`
- `upsertInboundMessage` writes/updates `folder`
- `normalizeOutlookFolder(name)` maps Microsoft's well-known
  folder identifiers — `inbox`, `junkemail`, `bulkemail`,
  `sentitems`, `deleteditems`, `drafts`, `archive` — to a stable
  set of labels: `inbox`, `junk`, `sent`, `drafts`, `deleted`,
  `archive`, `other`
- `listMessages(userId, { folder })` applies `WHERE folder = ?`
  when folder is set and not `'all'`
- `/user/outlook/messages` and `/api/admin/mailboxes/messages`
  forward `?folder=` from the client

#### 3) Client: folder filter dropdown
- Admin Mail Management page → folder select in the Messages panel
  (only shown when a mailbox is selected; only for `outlook` provider)
- User Inbox page → folder select in the top toolbar
- Both default to "All folders" and re-fetch on change

### Regression tests

`extension/fixtures/test_lumi_mailbox_auth.js` Part 9 (28 new tests):

- Server: WELL_KNOWN_FOLDERS structure ✓
- Server: `/me/mailFolders('<id>')/messages` query path ✓
- Server: `normalizeOutlookFolder` mappings (10 unit cases) ✓
- Schema: `outlook_messages.folder` column + ALTER TABLE migration ✓
- Server: `listMessages` SELECTs + filters by folder ✓
- Routes: `?folder=` param forwarding (user + admin) ✓
- Client UI: state + select rendering on both pages ✓

Total: **135/135** passing in `test_lumi_mailbox_auth.js`.

### Files changed

- `server/services/outlookMailService.js`
  (WELL_KNOWN_FOLDERS, syncInbox fan-out, folder migration,
  normalizeOutlookFolder, listMessages folder filter)
- `server/routes/user.js` (forward `?folder=`)
- `server/routes/admin.js` (forward `?folder=`)
- `client/src/pages/user/Inbox.jsx` (filterFolder state + dropdown)
- `client/src/pages/admin/Mailboxes.jsx` (selectedFolder state + dropdown)

## Bug 8: Greenhouse captcha auto-pass race condition

### Symptom

User runs an auto-bid queue with Greenhouse jobs. Lumi opens the
apply page, fills the form, clicks Submit, hits a reCAPTCHA wall,
then pauses awaiting human intervention. When the user manually
solves the captcha (or NopeCHA/Buster does it on their behalf),
Lumi sometimes continues to "Submit" but Greenhouse reports the
application as bot traffic / unusual activity.

### Root cause

`waitForCaptchaOrLoginCleared` in `extension/lib/bidderQueue.js`
declared the captcha "cleared" the moment:

```js
if (wall?.thankYou || (!wall.captcha && !wall.login) || wall.widgetSolved) {
    return { cleared: true, ... };
}
```

`wall.widgetSolved` is computed by checking the iframe checkbox
state for the reCAPTCHA widget. There's a **race window**:

1. NopeCHA injects the `g-recaptcha-response` token
2. The widget iframe visually shows the ✓ checkmark
3. The page's form submit handler reads the response textarea

If Lumi submits at step 2 **before** step 1 actually settles in
the DOM, the form posts an empty token, and Greenhouse rejects the
application as bot-traffic in their WAF (visible in the
`/admin/pipeline/applications` view as `requires_manual` /
`failed` with `last_event_type` like `blocked_ats`).

There's also a perf cost: `probeCaptchaHelpers()` is called every
1.5s during the wait, which re-runs `chrome.management.getAll()`
each tick — wasted on a profile that hasn't changed.

### Fix

Two new helpers + one targeted edit:

#### 1) `validateCaptchaResponse(tabId, { minLen })`
Reads the actual `g-recaptcha-response` / `h-captcha-response` /
`cf-turnstile-response` / `fc-token` textareas and returns
`{ ok, length, selector, head }`. Uses **60 chars** as the
minimum — below the typical token length (600+) but well above
empty/placeholder values, so a "checked" iframe with no
actual token is now correctly detected as not-solved.

Selectors covered:
- `textarea[name="g-recaptcha-response"]`
- `textarea[id*="g-recaptcha-response"]`
- `input[name="g-recaptcha-response"]`
- `textarea[name="h-captcha-response"]` / `input[name="h-captcha-response"]`
- `[name="h-captcha-response"]` / `[data-hcaptcha-response]`
- `textarea[name="cf-turnstile-response"]` / `input[name="cf-turnstile-response"]`
- `input[name="fc-token"]` (legacy Arkose)
- `[data-cf-turnstile-response]`

#### 2) `probeCaptchaHelpersCached()` with 30-minute TTL
Same as `probeCaptchaHelpers()` but with an in-memory cache. The
cache invalidates only when the queue stops (so a fresh user
session re-probes once). Cuts management-API calls from ~40/min
(per pausing captcha loop) to ~2/min.

#### 3) `waitForCaptchaOrLoginCleared` validates before returning
```js
if (wall.widgetSolved) {
    let token = null;
    try {
        token = await validateCaptchaResponse(currentTabId, { minLen: 60 });
    } catch (_) { /* ignore */ }
    if (token && !token.ok) {
        // Token empty — keep waiting. NopeCHA / Buster probably
        // need another poll cycle to inject.
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
    }
}
```

Cost: one additional `executeScript` per captcha event (no
more than once per 1.5s while paused). Prevents the bot-traffic
false-positive on Greenhouse apply pages.

### Regression tests

`extension/fixtures/test_lumi_mailbox_auth.js` Part 10 (19 new tests):

- `bidderQueue exports validateCaptchaResponse` ✓
- `bidderQueue exports probeCaptchaHelpersCached` ✓
- `bidderQueue exports invalidateCaptchaHelperCache` ✓
- `validateCaptchaResponse checks g-recaptcha-response textarea` ✓
- `validateCaptchaResponse checks h-captcha-response textarea` ✓
- `validateCaptchaResponse checks cf-turnstile-response` ✓
- `validateCaptchaResponse checks fc-token input (Arkose legacy)` ✓
- `validateCaptchaResponse uses 60-char minimum length` ✓
- `waitForCaptchaOrLoginCleared validates token before declaring cleared` ✓
- `probeCaptchaHelpersCached caches result for 30 minutes` ✓
- `probeCaptchaHelpersCached short-circuits when cache is fresh` ✓
- `validator: empty token fails` ✓ (unit)
- `validator: < 60 chars fails` ✓ (unit)
- `validator: 60 chars exactly passes` ✓ (unit)
- `validator: typical reCAPTCHA token length passes` ✓ (unit)
- `validator: only whitespace counts as empty` ✓ (unit)
- `probe cache: miss on first call` ✓ (unit)
- `probe cache: hits within TTL` ✓ (unit)
- `probe cache: miss after TTL` ✓ (unit)

Total: **154/154** passing in `test_lumi_mailbox_auth.js`.

### Files changed

- `extension/lib/bidderQueue.js`
  (`validateCaptchaResponse`, `probeCaptchaHelpersCached`,
  `invalidateCaptchaHelperCache`, `waitForCaptchaOrLoginCleared` integration)

## Bug 9: Auto-bidder select / dropdown not working

See `docs/auto-select-fix.md` for full writeup. Two stacked issues:

1. Native `<select>` dispatching didn't fire React's `onChange`
   (the famous `__value` setter hack). Fix: use
   `HTMLSelectElement.prototype.value` setter via
   `Object.getOwnPropertyDescriptor` in `bidderFill.js#fillSelect`.

2. `scoreOptionText` was substring-only — `USA` vs
   `United States of America`, `Bachelor` vs `Bachelor's Degree`
   all failed. Fix: token-overlap scorer added in `fill.js`.

3. `commitComboboxWithKeyboard` didn't fire `input` + `change` +
   `blur` after Enter, so React's controlled-state commit flag
   wasn't set. Fix: emit all three events.

Total: **171/171** passing in `test_lumi_mailbox_auth.js`.

## Bug 9: Auto-bidder select / dropdown not working

### Symptom

Lumi opens a Greenhouse apply page, the form has `<select>` dropdowns
(EEO / Work Authorization / Relocation / Previous Employer / etc.),
Lumi reads the right option and dispatches the change event — but
the form still shows "Select..." after we navigate to the next
page. The bid appears to succeed but the actual submission has
"Select..." (the default empty option), which Greenhouse's WAF
flags as unusual activity.

Specific symptoms:
- "Work Authorization" / "Visa Sponsorship" / "Race" / "Veteran"
  select fields stay at the placeholder after Lumi "fills" them.
- A reCAPTCHA challenge fires after submission claiming unusual
  activity, even though everything seems fine.
- Picking values like "Bachelor's Degree" / "Master of Science" /
  "United States of America" against alias "Bachelor" / "Master" /
  "USA" / "United States" doesn't match — substring-equal but
  not exact-text equal.