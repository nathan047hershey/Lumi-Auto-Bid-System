import {
    getSettings,
    saveSettings,
    listProfiles,
    generateResume,
    generateAnswers,
    generateCoverLetter,
    techstacksToCoreSkills,
    inferCoreSkillsFromJd,
    resumeDownloadUrl,
    fetchResumeBase64,
    listBidderReady,
    getBidderStatus,
    markApplicationApplied,
    clearFalseApplicationSuccess,
    getBidderApplication,
    getBidderApplicationByJobUrl,
    logBidCourseFill,
    generateBidderAnswers,
    checkoutApplicationCheck,
    checkBidderCv,
    logBidderFieldAttempts,
    interpretBidderInstruction,
    listBidderFillLessons,
    saveBidderFillLesson,
    upsertQuestionMemory
} from './lib/api.js';
import {
    BIDDER_DEFAULTS,
    acquireQueueLock,
    releaseQueueLock,
    setQueueState,
    setAppRunState,
    getQueueState,
    getBidderPrefs,
    saveBidderPrefs,
    logCourseEvent,
    uploadScreenshot,
    savePackage,
    detectSubmitSuccess,
    detectSubmitSuccessDetail,
    pollDetectSubmitSuccess,
    clearFalseSuccessOutlines,
    uploadSuccessProofScreenshot,
    detectCaptchaOrLogin,
    waitForCaptchaOrLoginCleared,
    clickFormNextIfAny,
    ensureUsDialCodeTrusted,
    attachPageDebugger,
    releasePageDebugger,
    releaseAllPageDebuggers,
    assistRecaptchaCheckbox,
    captchaStrategyForVendor,
    vendorLabel,
    isBlockingCaptchaWall,
    tryFillOutlookEmailOtp,
    fillEmailSecurityCode,
    detectEmailSecurityCodePage,
    clickPostOtpSubmit,
    emailOtpInputsFilled,
    probeCaptchaHelpers
} from './lib/bidderQueue.js';
import { appendUiMessage, getUiMessageLog } from './lib/uiMessageLog.js';
import {
    saveFillLesson,
    lessonsForHost as fillLessonsForHost,
    matchLesson as matchFillLesson
} from './lib/fillLessons.js';
import {
    looksLikeCreateAccountPage,
    generateAtsPassword,
    upsertApplyLesson,
    lessonsForHost
} from './lib/applyGate.js';
import {
    assistCaptchaHelpers,
    assistCaptchaHelpersWithRetry,
    detectCaptchaSolved
} from './lib/captchaAssist.js';
import { resolveBidderAts, detectAtsFromUrl, isAshbyJobDescriptionUrl, ashbyApplicationUrl } from './lib/atsDetect.js';
import {
    AUTOFILL_ENGINE,
    AUTOFILL_RETRY_PER_PAGE,
    BID_HARD_LIMIT_MS,
    bidLimitMsForAts,
    formWaitMsForAts,
    normalizeFillStats,
    isFillIncomplete,
    canAutoSubmit,
    engineLabelForAts,
    formFingerprint,
    formFieldCount,
    maxPagesForAts,
    mergeAnswers,
    lessonFillsToAnswers,
    pickNewQuestions,
    settleMsForAts,
    shouldAdvancePage,
    shouldRefillPage,
    useAnswersOnlyOnPage
} from './lib/autofillEngine.js';
import { solveCaptchaOnTab, resolveSolverProvider } from './lib/captchaSolver.js';
import { SUBMIT_SUCCESS_POLL_MS } from './lib/fillVerify.js';

const GENERATING_KEY = 'generating';
const FILLING_KEY = 'filling';
const FILLING_AT_KEY = 'fillingAt';

/** Prevent concurrent Mode-2 autofill on the same tab (begin→end→begin loop). */
const inflightPendingFillTabs = new Map();

/**
 * Optional cover letter DOCX for upload.
 * Default OFF — never invent a CL or put a resume into the CL slot.
 * Only runs when opts.uploadCoverLetter is true, or the form marks CL as required.
 */
async function maybePrepareCoverLetterFile({
    form,
    profileId,
    jobDescription,
    resumeHtml,
    companyName,
    jobRole,
    settings,
    uploadCoverLetter = false
}) {
    const fileInputs = form?.fileInputs || [];
    const coverInputs = fileInputs.filter((f) => {
        const hay = `${f.label || ''} ${f.kind || ''}`.toLowerCase();
        return f.kind === 'cover_letter' || /\b(cover[\s_-]*letter|covering[\s_-]*letter)\b/.test(hay);
    });
    if (!coverInputs.length || !profileId) return null;

    const required = coverInputs.some((f) => f.required || f.required === true
        || /\*/.test(String(f.label || ''))
        || /\brequired\b/i.test(String(f.label || '')));
    // Skip optional CL unless user explicitly enabled upload.
    if (!uploadCoverLetter && !required) return null;

    try {
        const gen = await generateCoverLetter({
            profile_id: profileId,
            job_description: jobDescription || '',
            resume_html: resumeHtml || '',
            company_name: companyName || '',
            job_role: jobRole || ''
        });
        const fname = gen?.cover_letter_filename;
        if (!fname) return null;
        // Hard gate: never treat a resume_*.docx as a cover letter.
        if (/^resume_/i.test(fname) || !/cover/i.test(fname)) {
            console.warn('[autofill] refusing non-cover-letter filename for CL slot', fname);
            return null;
        }
        return await fetchResumeBase64(settings.apiBaseUrl, fname, settings.token);
    } catch (err) {
        console.warn('[autofill] cover letter generate failed', err);
        return null;
    }
}
function jobUrlKey(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
        return String(url).split('?')[0].toLowerCase();
    }
}

function newSessionId() {
    return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Persist the job-page ↔ generate-page pair so fill cannot use another job's CV.
 */
async function saveActiveJobSession(patch) {
    const settings = await getSettings();
    const prev = settings.activeJobSession || {};
    const next = {
        ...prev,
        ...patch,
        updatedAt: new Date().toISOString()
    };
    await saveSettings({ activeJobSession: next });
    return next;
}

async function clearActiveJobSession() {
    await saveSettings({ activeJobSession: null });
}

/**
 * Fill is only allowed when this tab/window is bound to the CV session
 * (or a remembered cvLink for this exact apply URL). Never use another job's CV.
 */
function assertJobSessionMatch({ pageUrl, tabId, windowId, session, linked, lastResult }) {
    if (linked?.applicationId || linked?.resumeFilename) {
        if (!linked.jobUrl || urlsLooselyMatch(pageUrl, linked.jobUrl) || jobUrlKey(pageUrl) === jobUrlKey(linked.jobUrl)) {
            return { ok: true, via: 'cvLink' };
        }
    }

    if (lastResult?.applicationId && lastResult?.jobUrl) {
        if (urlsLooselyMatch(pageUrl, lastResult.jobUrl) || jobUrlKey(pageUrl) === jobUrlKey(lastResult.jobUrl)) {
            return { ok: true, via: 'lastResult' };
        }
    }

    if (!session?.sessionId) {
        return {
            ok: false,
            error:
                'No job↔CV session. On the JD page: select the JD text → Alt+Shift+G, wait for CV, then Alt+Shift+F on that job’s apply form (same browser window).'
        };
    }

    // Same window as the JD that launched generate (survives JD→apply navigation).
    if (windowId != null && session.jobWindowId != null && Number(windowId) === Number(session.jobWindowId)) {
        return { ok: true, via: 'window' };
    }
    if (tabId != null && (
        Number(tabId) === Number(session.jobTabId)
        || Number(tabId) === Number(session.applyTabId)
    )) {
        return { ok: true, via: 'tab' };
    }

    const pageKey = jobUrlKey(pageUrl);
    const sessionKey = session.jobUrlKey || jobUrlKey(session.jobUrl);
    if (pageKey && sessionKey && (pageKey === sessionKey || urlsLooselyMatch(pageUrl, session.jobUrl))) {
        return { ok: true, via: 'url' };
    }

    const label = [session.company, session.jobTitle].filter(Boolean).join(' — ') || session.jobUrl || 'another job';
    return {
        ok: false,
        error:
            `Wrong job window. Bound CV is for: ${label}. `
            + 'Use the same browser window where you generated, or run Alt+Shift+G on this job’s JD first.'
    };
}

/** Persist application_id + resume for this job URL so fill after refresh reconnects. */
async function rememberCvForJob({
    jobUrl,
    applicationId,
    resumeFilename,
    profileId,
    company,
    jobTitle
} = {}) {
    if (!applicationId && !resumeFilename) return;
    const settings = await getSettings();
    const url = jobUrl || settings.lastResult?.jobUrl || '';
    const key = jobUrlKey(url);
    if (!key) return;

    const links = { ...(settings.cvLinks || {}) };
    links[key] = {
        applicationId: applicationId || null,
        resumeFilename: resumeFilename || null,
        profileId: profileId || settings.selectedProfileId || null,
        jobUrl: url,
        company: company || null,
        jobTitle: jobTitle || null,
        at: new Date().toISOString()
    };

    const keys = Object.keys(links);
    if (keys.length > 50) {
        const sorted = keys.sort((a, b) => String(links[a].at || '').localeCompare(String(links[b].at || '')));
        for (const k of sorted.slice(0, keys.length - 50)) delete links[k];
    }
    await saveSettings({ cvLinks: links });
}

async function findCvLinkForUrl(pageUrl, profileId) {
    const settings = await getSettings();
    const links = settings.cvLinks || {};
    const key = jobUrlKey(pageUrl);
    const candidates = [];
    if (key && links[key]) candidates.push(links[key]);
    for (const v of Object.values(links)) {
        if (!v) continue;
        if (candidates.includes(v)) continue;
        if (urlsLooselyMatch(pageUrl, v.jobUrl) || urlsLooselyMatch(pageUrl, jobUrlKey(v.jobUrl))) {
            candidates.push(v);
        }
    }
    for (const v of candidates) {
        if (profileId && v.profileId && Number(v.profileId) !== Number(profileId)) continue;
        return v;
    }
    return null;
}

async function notify(title, message) {
    const text = String(message || '').slice(0, 250);
    let short = text;
    try {
        const entry = await appendUiMessage(title, text);
        short = entry?.short || text;
    } catch (_) {
        try {
            await chrome.storage.local.set({
                lastUiMessage: {
                    at: new Date().toISOString(),
                    title: String(title || 'Lumi'),
                    message: text,
                    short: text,
                    kind: /fail|error|nothing|no cv/i.test(`${title} ${text}`) ? 'error' : 'ok'
                }
            });
        } catch (__) { /* ignore */ }
    }

    try {
        await chrome.action.setBadgeBackgroundColor({ color: '#1d4ed8' });
        await chrome.action.setBadgeText({ text: '…' });
        setTimeout(() => {
            chrome.action.setBadgeText({ text: '' }).catch(() => {});
        }, 8000);
    } catch (_) { /* ignore */ }

    try {
        await chrome.notifications.create(`bidder-${Date.now()}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: String(title || 'Lumi'),
            message: short.slice(0, 120),
            priority: 2
        });
    } catch (err) {
        console.warn('[bidder] notify failed', err);
    }
}

async function toastActiveTab(text, kind = 'info') {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        await ensureScripts(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_TOAST', text, kind });
    } catch (err) {
        console.warn('[bidder] toast failed', err);
    }
}

async function clearFillLock() {
    await chrome.storage.local.set({ [FILLING_KEY]: false, [FILLING_AT_KEY]: 0 });
}

async function acquireFillLock({ waitMs = 8000 } = {}) {
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
        const locks = await chrome.storage.local.get([FILLING_KEY, FILLING_AT_KEY]);
        const started = Number(locks[FILLING_AT_KEY] || 0);
        const stale = started > 0 && (Date.now() - started) > 3 * 60 * 1000;
        if (!locks[FILLING_KEY] || stale) {
            await chrome.storage.local.set({ [FILLING_KEY]: true, [FILLING_AT_KEY]: Date.now() });
            return;
        }
        if (Date.now() >= deadline) {
            throw new Error('Fill already in progress — wait a few seconds or reload the extension');
        }
        await new Promise((r) => setTimeout(r, 400));
    }
}

function isNoReceiverError(err) {
    return /Receiving end does not exist|Could not establish connection|message port closed/i.test(
        String(err?.message || err || '')
    );
}

async function waitTabDocumentReady(tabId, timeoutMs = 20000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        // Tab gone is normal during queue (user close / unattended skip) — never throw.
        if (!tab) return null;
        if (tabShowsBrowserErrorPage(tab)) throw new Error(tabErrorPageMessage(tab));
        const url = String(tab.url || tab.pendingUrl || '');
        if (
            tab.status === 'complete'
            && url
            && !/^(chrome|chrome-extension|edge|about|devtools):/i.test(url)
        ) {
            return tab;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return await chrome.tabs.get(tabId).catch(() => null);
}

async function ensureScripts(tabId) {
    try {
        const tab = await waitTabDocumentReady(tabId);
        if (!tab) return false;
        try {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: ['content/controlMatch.js', 'content/scrape.js', 'content/fill.js', 'content/bidderFill.js']
            });
        } catch (injErr) {
            const inj = String(injErr?.message || injErr || '');
            // Tab really gone
            if (/No tab with id|Invalid tab/i.test(inj)) return false;
            // Already injected / CSP race — tab is still usable
        }
        return true;
    } catch (err) {
        const msg = String(err?.message || err || '');
        if (/No tab with id|Invalid tab|tab.*closed|Tab closed/i.test(msg)) {
            return false;
        }
        if (/showing error page|chrome-error|cannot be reached|err_/i.test(msg)) {
            throw new Error(
                /showing error page|chrome-error/i.test(msg)
                    ? 'This tab is a Chrome error page (site failed to load). Open the job URL again, then retry.'
                    : msg
            );
        }
        // Transient — tab may still accept messages
        const still = await chrome.tabs.get(tabId).catch(() => null);
        return !!still;
    }
}

/** Inject content scripts and sendMessage with reconnect retries (nav races). */
async function sendTabMessage(tabId, message, { retries = 6, baseDelayMs = 350 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const injected = await ensureScripts(tabId);
            if (!injected) {
                const still = await chrome.tabs.get(tabId).catch(() => null);
                if (!still) {
                    const err = new Error('Tab closed');
                    err.tabClosed = true;
                    throw err;
                }
            }
            // Lightweight ping so we know a listener exists before heavy FILL_FORM payloads.
            if (attempt > 0 || message?.type === 'FILL_FORM' || message?.type === 'BIDDER_ENGINE_COLLECT') {
                await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' });
            }
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (err) {
            lastErr = err;
            if (err?.tabClosed || /Tab closed/i.test(String(err?.message || ''))) throw err;
            if (!isNoReceiverError(err)) throw err;
            await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
        }
    }
    throw lastErr || new Error('Could not establish connection. Receiving end does not exist.');
}

/** Chrome interstitial when navigation failed (DNS, connection, crash, etc.). */
function tabShowsBrowserErrorPage(tab) {
    if (!tab) return true;
    const url = String(tab.pendingUrl || tab.url || '');
    if (!url) return false;
    if (/^chrome-error:/i.test(url)) return true;
    if (/chromewebdata/i.test(url)) return true;
    if (/^chrome:\/\/error/i.test(url)) return true;
    if (/^about:neterror|^about:certerror/i.test(url)) return true;
    return false;
}

function tabErrorPageMessage(tab) {
    const url = String(tab?.pendingUrl || tab?.url || '');
    return `Tab is showing a Chrome error page${url ? ` (${url.slice(0, 80)})` : ''} — reload the job posting, then try again`;
}

/** Greenhouse / ATS URL helpers for finding an open apply tab after a stale tabId. */
function ghTokenFromUrl(url) {
    try {
        const u = new URL(String(url || ''));
        if (!/greenhouse\.io/i.test(u.hostname)) return '';
        return u.searchParams.get('token') || '';
    } catch {
        return '';
    }
}

function urlsLooselyMatchApply(a, b) {
    const left = String(a || '');
    const right = String(b || '');
    if (!left || !right) return false;
    if (left === right) return true;
    const t1 = ghTokenFromUrl(left);
    const t2 = ghTokenFromUrl(right);
    if (t1 && t2 && t1 === t2) return true;
    try {
        const u1 = new URL(left);
        const u2 = new URL(right);
        const h1 = u1.hostname.replace(/^www\./, '').replace(/^job-boards\./, 'boards.');
        const h2 = u2.hostname.replace(/^www\./, '').replace(/^job-boards\./, 'boards.');
        if (h1 === h2 && u1.pathname.replace(/\/$/, '') === u2.pathname.replace(/\/$/, '')) return true;
        if (h1 === h2 && /greenhouse\.io/i.test(h1)) return true;
    } catch {
        /* ignore */
    }
    return false;
}

/**
 * Resolve an open apply tab. Prefer stored tabId; if closed, search by job URL
 * (fixes Control "Tab closed" while the Greenhouse form tab is still open / Ready).
 */
async function resolveOpenApplyTabId({ tabId = null, applicationId = null, url = '' } = {}) {
    const clean = (raw) => {
        const s = String(raw || '').trim();
        if (!s) return '';
        if (/[?&]error=true\b/i.test(s) || /\/embed\/job_board/i.test(s)) return '';
        if (isAshbyJobDescriptionUrl(s)) return ashbyApplicationUrl(s);
        return s;
    };
    const wantedUrl = clean(url);
    const preferred = Number(tabId) || 0;
    if (preferred) {
        try {
            await chrome.tabs.get(preferred);
            return preferred;
        } catch {
            /* search below */
        }
    }
    try {
        const st = await getQueueState();
        const mapped = applicationId
            ? Number(st?.tabsByAppId?.[String(applicationId)] || 0) || 0
            : 0;
        const candidates = [
            mapped,
            Number(st?.currentTabId || 0) || 0,
            Number(st?.captchaTabId || 0) || 0
        ].filter((id, i, arr) => id && arr.indexOf(id) === i);
        for (const id of candidates) {
            try {
                const t = await chrome.tabs.get(id);
                const u = t?.pendingUrl || t?.url || '';
                if (wantedUrl && !urlsLooselyMatchApply(u, wantedUrl)) continue;
                return id;
            } catch {
                /* gone */
            }
        }
        if (wantedUrl) {
            const all = await chrome.tabs.query({});
            const tok = ghTokenFromUrl(wantedUrl);
            for (const t of all || []) {
                if (!t?.id || !t.url || /^(chrome|edge|about|devtools):/i.test(t.url)) continue;
                if (tok && ghTokenFromUrl(t.url) === tok) return t.id;
                if (urlsLooselyMatchApply(t.url, wantedUrl)) return t.id;
            }
        }
    } catch {
        /* ignore */
    }
    return null;
}

async function scrapeActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    if (tabShowsBrowserErrorPage(tab)) {
        throw new Error(tabErrorPageMessage(tab));
    }
    if (!tab.url || /^(chrome|chrome-extension|edge|about|devtools):/i.test(tab.url)) {
        throw new Error('Open a job posting page first (not a Chrome internal page)');
    }
    await ensureScripts(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_JOB' });
    if (!response?.ok) throw new Error(response?.error || 'Failed to scrape page');
    return { tab, job: response.data };
}

async function collectForm(tabId) {
    const response = await sendTabMessage(tabId, { type: 'COLLECT_FORM' });
    if (!response?.ok) throw new Error(response?.error || 'Failed to collect form');
    return response.data;
}

async function fillAndUpload(tabId, payload) {
    await ensureScripts(tabId);
    // Dial Country* first (trusted CDP) — content-script clicks often leave it blank.
    try {
        await ensureUsDialCodeTrusted(tabId);
    } catch (err) {
        console.warn('[bidder] dial country pre-fill', err);
    }
    const response = await sendTabMessage(tabId, { type: 'FILL_FORM', payload });
    if (!response?.ok) throw new Error(response?.error || 'Failed to fill form');
    return response;
}

function urlsLooselyMatch(a, b) {
    if (!a || !b) return false;
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        if (ua.hostname.replace(/^www\./, '') !== ub.hostname.replace(/^www\./, '')) return false;
        const pa = ua.pathname.replace(/\/+$/, '');
        const pb = ub.pathname.replace(/\/+$/, '');
        return pa === pb || pa.includes(pb) || pb.includes(pa);
    } catch {
        return String(a).split('?')[0] === String(b).split('?')[0];
    }
}

async function maybeMarkApplied(applicationId) {
    if (!applicationId) return null;
    try {
        return await markApplicationApplied(applicationId);
    } catch (err) {
        console.warn('[bidder] mark applied failed', err);
        return null;
    }
}

async function waitForAnswersReady(requestId, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            reject(new Error('Timed out after 60s — Answer questions on Generate, then Fill on apply form'));
        }, timeoutMs);

        function listener(msg) {
            if (msg?.type !== 'ANSWERS_READY') return;
            if (requestId && msg.requestId && msg.requestId !== requestId) return;
            clearTimeout(timer);
            chrome.runtime.onMessage.removeListener(listener);
            if (msg.error) {
                reject(new Error(msg.error));
                return;
            }
            resolve(msg.payload || {});
        }
        chrome.runtime.onMessage.addListener(listener);
    });
}

/**
 * Send selected questions to the Generate page AI Assistant, show answers there,
 * then return structured answers for autofill.
 */
async function answerQuestionsViaGenerateAssistant({
    settings,
    profile,
    job,
    result,
    questions,
    mode = 'interactive'
}) {
    const session = settings.activeJobSession || {};
    let generateTabId = session.generateTabId || settings.lastResult?.generateTabId || null;

    if (generateTabId) {
        try {
            await chrome.tabs.get(generateTabId);
        } catch (_) {
            generateTabId = null;
        }
    }

    if (!generateTabId) {
        // Fall back: open generate page for this profile (no auto_generate).
        const generateUrl =
            `${settings.frontendBaseUrl}/user/generate/${profile.id}?from_bidder=1`;
        const tab = await chrome.tabs.create({ url: generateUrl, active: true });
        await waitTabComplete(tab.id);
        await new Promise((r) => setTimeout(r, 800));
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/app-bridge.js']
            });
        } catch (_) { /* ignore */ }
        generateTabId = tab.id;
        await saveActiveJobSession({ generateTabId });
    } else {
        try {
            await chrome.tabs.update(generateTabId, { active: true });
        } catch (_) { /* ignore */ }
        try {
            await chrome.scripting.executeScript({
                target: { tabId: generateTabId },
                files: ['content/app-bridge.js']
            });
        } catch (_) { /* ignore */ }
    }

    const requestId = `ans_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const waitPromise = waitForAnswersReady(requestId, 60000);

    await chrome.tabs.sendMessage(generateTabId, {
        type: 'BIDDER_ANSWER_QUESTIONS',
        payload: {
            requestId,
            mode,
            profile_id: profile.id,
            questions,
            job_description: job.description || job.job_description || '',
            resume_html: result.resume_html || result.resume_content || result.draft_html || '',
            company_name: job.company || result.company_name || '',
            job_role: job.title || result.job_role || '',
            application_id: result.application_id || result.applicationId || null
        }
    });

    await notify(
        mode === 'auto' ? 'Auto-answering questions…' : 'Answer questions on Generate',
        mode === 'auto'
            ? 'CV ready — drafting AI answers and filling the form'
            : 'Profile is filled. Click Answer on each question, then Fill on apply form'
    );

    return waitPromise;
}

async function autofillAfterGenerate({
    tabId,
    settings,
    profile,
    job,
    result,
    phase = 'full',
    answerMode = 'interactive'
}) {
    const form = await collectForm(tabId);
    if (form.blocked) {
        throw new Error(form.reason || 'This site is blocked for autofill');
    }

    const profileFields = {
        id: profile.id,
        first_name: profile.first_name,
        last_name: profile.last_name,
        email: profile.email,
        phone: profile.phone,
        linkedin_url: profile.linkedin_url,
        github_url: profile.github_url,
        city: profile.city,
        state: profile.state,
        country: profile.country,
        address: profile.address,
        postal_code: profile.postal_code,
        birthdate: profile.birthdate || '',
        salary_range: profile.salary_range || '',
        gender: profile.gender || '',
        work_authorization: profile.work_authorization || '',
        requires_sponsorship: profile.requires_sponsorship || '',
        disability_status: 'No, I do not have a disability',
        veteran_status: profile.veteran_status || '',
        race_ethnicity: profile.race_ethnicity || '',
        website_url: profile.website_url || '',
        portfolio_url: profile.portfolio_url || '',
        preferred_name: profile.preferred_name || '',
        over_18: profile.over_18 || '',
        hispanic_latino: profile.hispanic_latino || '',
        willing_to_relocate: profile.willing_to_relocate || '',
        willing_to_travel: profile.willing_to_travel || '',
        earliest_start_date: profile.earliest_start_date || '',
        notice_period: profile.notice_period || '',
        how_heard: profile.how_heard || 'LinkedIn',
        years_of_experience: profile.years_of_experience || '',
        education_level: profile.education_level || '',
        education: profile.education || '',
        school: profile.school || '',
        degree: profile.degree || '',
        discipline: profile.discipline || '',
        security_clearance: profile.security_clearance || ''
    };

    const questionsRaw = form.questions || [];
    let questions = questionsRaw;
    if (form.hasQuestionSelection) {
        questions = form.selectedQuestions || [];
    }

    // Always include salary fields for answer fill (even if not checked in picker).
    const salaryFromFields = (form.fields || []).filter((f) => f.kind === 'salary');
    for (const sf of salaryFromFields) {
        if (!questions.some((q) => String(q.id) === String(sf.id))) {
            questions = [...questions, {
                id: sf.id,
                label: sf.label,
                kind: 'salary',
                type: sf.type || 'text',
                answer_type: 'salary'
            }];
        }
    }

    const essayQuestions = questions.filter(
        (q) => q.kind === 'question' || (q.answer_type === 'written' && q.kind !== 'salary')
    );
    const salaryQuestions = questions.filter(
        (q) => q.kind === 'salary' || q.answer_type === 'salary'
    );
    // Essays need AI; salary is resolved server-side from JD/profile (no LLM).
    const writtenQuestions = [...essayQuestions, ...salaryQuestions];

    let resumeFile = null;
    const filename = result.resume_filename || result.resumeFilename;
    if (filename && phase !== 'answers') {
        try {
            resumeFile = await fetchResumeBase64(settings.apiBaseUrl, filename, settings.token);
        } catch (err) {
            console.warn('[bidder] resume download for upload failed', err);
        }
    }

    let coverLetterFile = null;
    if (phase !== 'answers') {
        // Autofill: only upload CL when the field is required (optional CL stays empty).
        coverLetterFile = await maybePrepareCoverLetterFile({
            form,
            profileId: settings.selectedProfileId || result.profile_id,
            jobDescription: job.description || job.job_description || '',
            resumeHtml: result.resume_html || result.draft_html || '',
            companyName: job.company || result.company_name || '',
            jobRole: job.title || result.job_role || '',
            settings,
            uploadCoverLetter: false
        });
    }

    let fillResult = {
        fillStats: { filled: 0 },
        uploadStats: { uploaded: 0 },
        submitStats: { clicked: false },
        ats: form.ats
    };

    // Phase 1 — Simplify-style: saved profile only (no AI)
    if (phase === 'full' || phase === 'profile') {
        await notify('Lumi', 'Autofill — saved profile (no AI)…');
        fillResult = await fillAndUpload(tabId, {
            fields: form.fields || [],
            answers: [],
            profile: profileFields,
            jobDescription: job.description || job.job_description || '',
            fileInputs: form.fileInputs || [],
            filename: resumeFile?.filename,
            base64: resumeFile?.base64,
            mimeType: resumeFile?.mimeType,
            resume: resumeFile,
            coverLetter: coverLetterFile,
            autoSubmit: false
        });

        await toastActiveTab(
            `Autofilled ${fillResult?.fillStats?.filled ?? 0} profile field(s)`
                + (essayQuestions.length
                    ? ` · ${essayQuestions.length} need Answer questions`
                    : ''),
            'success'
        );

        if (phase === 'profile') {
            return {
                ats: fillResult.ats || form.ats,
                questions: essayQuestions.length,
                answers: 0,
                skippedSalary: fillResult.fillStats?.skippedSalary || 0,
                filled: fillResult.fillStats?.filled || 0,
                uploaded: fillResult.uploadStats?.uploaded || 0,
                submitted: false,
                markedApplied: false,
                applicationId: result.application_id || result.applicationId || null,
                phase: 'profile'
            };
        }
    }

    let answersPayload = {
        answers: [],
        skipped: [],
        profile: { ...profileFields }
    };

    // Phase 2 — AI written answers (needs CV)
    if ((phase === 'full' || phase === 'answers') && writtenQuestions.length > 0) {
        const hasCv = !!(
            result.resume_html
            || result.resume_content
            || result.draft_html
            || result.resume_filename
            || result.application_id
        );
        if (!hasCv) {
            throw new Error('Generate a CV first (Alt+Shift+G), then use Answer questions');
        }

        await notify(
            'Lumi',
            answerMode === 'auto'
                ? `Drafting ${writtenQuestions.length} AI answer(s)…`
                : `${writtenQuestions.length} question(s) → Answer on Generate`
        );

        const applyAiAnswers = async (payload) => {
            answersPayload = {
                answers: payload.answers || [],
                skipped: payload.skipped || [],
                profile: {
                    ...profileFields,
                    ...(payload.profile || {})
                },
                provider: payload.provider || null,
                model: payload.model || null,
                written_filled: payload.written_filled,
                written_count: payload.written_count
            };

            try {
                await chrome.tabs.update(tabId, { active: true });
            } catch (_) { /* ignore */ }

            if (!(answersPayload.answers || []).length) return;

            await notify(
                'Filling AI answers',
                `${answersPayload.answers.length} answer(s) → apply form`
            );
            const aiFill = await fillAndUpload(tabId, {
                fields: form.fields || [],
                answers: answersPayload.answers || [],
                profile: answersPayload.profile,
                jobDescription: job.description || job.job_description || '',
                fileInputs: form.fileInputs || [],
                filename: resumeFile?.filename || null,
                base64: resumeFile?.base64 || null,
                mimeType: resumeFile?.mimeType || null,
                resume: resumeFile,
                coverLetter: coverLetterFile,
                answersOnly: true,
                autoSubmit: opts.bidderAutoSubmit != null
                    ? !!opts.bidderAutoSubmit
                    : true
            });
            fillResult = {
                ...fillResult,
                fillStats: {
                    ...(fillResult.fillStats || {}),
                    filled: (fillResult.fillStats?.filled || 0) + (aiFill.fillStats?.filled || 0),
                    filledWritten: aiFill.fillStats?.filledWritten,
                    skippedWritten: aiFill.fillStats?.skippedWritten
                },
                submitStats: aiFill.submitStats || fillResult.submitStats
            };
        };

        try {
            if (answerMode === 'auto') {
                // Fast path: API directly (no Generate-tab bridge / 10min wait).
                const apiPayload = await generateAnswers({
                    profile_id: profile.id,
                    job_description: job.description || job.job_description || '',
                    resume_html: result.resume_html || result.resume_content || result.draft_html || '',
                    questions: writtenQuestions,
                    company_name: job.company || result.company_name || '',
                    job_role: job.title || result.job_role || '',
                    application_id: result.application_id || result.applicationId || null
                });
                await applyAiAnswers(apiPayload);
            } else {
                const viaAssistant = await answerQuestionsViaGenerateAssistant({
                    settings: await getSettings(),
                    profile,
                    job,
                    result,
                    questions: writtenQuestions,
                    mode: answerMode || 'interactive'
                });
                await applyAiAnswers(viaAssistant);
            }
        } catch (err) {
            console.warn('[bidder] answer draft failed — trying API batch', err);
            try {
                const apiPayload = await generateAnswers({
                    profile_id: profile.id,
                    job_description: job.description || job.job_description || '',
                    resume_html: result.resume_html || result.resume_content || result.draft_html || '',
                    questions: writtenQuestions,
                    company_name: job.company || result.company_name || '',
                    job_role: job.title || result.job_role || '',
                    application_id: result.application_id || result.applicationId || null
                });
                await applyAiAnswers(apiPayload);
                if ((answersPayload.answers || []).length) {
                    await notify('Answers via API', err?.message || 'Filled using direct answers API');
                }
            } catch (err2) {
                console.warn('[bidder] generateAnswers failed', err2);
                await notify(
                    'Written answers skipped',
                    err2?.message || 'Generate a CV first (Alt+Shift+G), then Answer questions'
                );
                answersPayload.answers = [];
                answersPayload.skipped = writtenQuestions.map((q) => ({
                    id: q.id,
                    label: q.label,
                    reason: 'answers_api_failed'
                }));
            }
        }
    } else if (phase === 'answers' && writtenQuestions.length === 0) {
        await notify('Lumi', 'No written questions found on this form');
    }

    const applicationId = result.application_id || result.applicationId || null;
    // Only auto-mark applied when optional auto-Submit actually clicked.
    // Otherwise the user marks applied (popup button) after they Submit.
    let marked = null;
    if (
        applicationId
        && settings.autoSubmit
        && fillResult.submitStats?.clicked
        && !opts.skipAutoMarkApplied
    ) {
        marked = await maybeMarkApplied(applicationId);
    }

    if (applicationId) {
        try {
            const salaryAns = (answersPayload.answers || []).find((a) => a?.salary_meta);
            await logBidCourseFill({
                application_id: applicationId,
                job_url: job.url || null,
                company_name: job.company || result.company_name || null,
                job_role: job.title || result.job_role || null,
                answers: answersPayload.answers || [],
                answers_provider: answersPayload.provider || null,
                answers_model: answersPayload.model || null,
                salary_value: salaryAns?.salary_meta?.value ?? null,
                salary_formatted: salaryAns?.answer || null,
                fill_stats: {
                    filled: fillResult.fillStats?.filled || 0,
                    uploaded: fillResult.uploadStats?.uploaded || 0,
                    filledSalary: fillResult.fillStats?.filledSalary || 0,
                    skippedSalary: fillResult.fillStats?.skippedSalary || 0,
                    ats: fillResult.ats || form.ats,
                    questions: writtenQuestions.length
                }
            });
        } catch (err) {
            console.warn('[bidder] bid course fill log failed', err);
        }
    }

    return {
        ats: fillResult.ats || form.ats,
        questions: essayQuestions.length,
        answers: (answersPayload.answers || []).length,
        skippedSalary: (answersPayload.skipped || []).length + (fillResult.fillStats?.skippedSalary || 0),
        filled: fillResult.fillStats?.filled || 0,
        uploaded: fillResult.uploadStats?.uploaded || 0,
        submitted: !!fillResult.submitStats?.clicked,
        markedApplied: !!marked,
        applicationId
    };
}

async function copyJobToClipboard(tabId, job) {
    const text = [
        job.title ? `Title: ${job.title}` : '',
        job.company ? `Company: ${job.company}` : '',
        job.url ? `URL: ${job.url}` : '',
        '',
        job.description || ''
    ].filter((line, i, arr) => line || arr[i - 1] !== '').join('\n').trim();

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: async (payload) => {
                try {
                    await navigator.clipboard.writeText(payload);
                    return true;
                } catch (_) {
                    const ta = document.createElement('textarea');
                    ta.value = payload;
                    ta.style.position = 'fixed';
                    ta.style.left = '-9999px';
                    document.body.appendChild(ta);
                    ta.select();
                    const ok = document.execCommand('copy');
                    ta.remove();
                    return ok;
                }
            },
            args: [text]
        });
        return true;
    } catch (err) {
        console.warn('[bidder] clipboard copy failed', err);
        return false;
    }
}

async function waitTabComplete(tabId, timeoutMs = 30000) {
    const existing = await chrome.tabs.get(tabId);
    if (existing.status === 'complete') return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('Timed out loading Generate page'));
        }, timeoutMs);
        function listener(id, info) {
            if (id === tabId && info.status === 'complete') {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

/**
 * Ashby JD pages have no form — application is at .../{uuid}/application.
 * After JD scrape, open that page in the same tab (click Apply, else navigate).
 */
async function ensureAshbyApplicationPage(tabId, currentUrl) {
    if (!isAshbyJobDescriptionUrl(currentUrl)) {
        return { navigated: false, url: currentUrl };
    }
    const targetUrl = ashbyApplicationUrl(currentUrl);

    let clickedHref = null;
    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const anchors = [...document.querySelectorAll('a[href*="/application"]')];
                const prefer = anchors.find((a) => /apply for this job/i.test((a.innerText || '').trim()))
                    || anchors.find((a) => /apply/i.test((a.innerText || '').trim()))
                    || anchors[0];
                if (prefer) {
                    const href = prefer.href || prefer.getAttribute('href') || '';
                    prefer.click();
                    return href || true;
                }
                const btn = [...document.querySelectorAll('button, [role="button"]')]
                    .find((el) => /apply for this job/i.test((el.innerText || el.textContent || '').trim()));
                if (btn) {
                    btn.click();
                    return true;
                }
                return false;
            }
        });
        clickedHref = result || null;
    } catch (_) {
        clickedHref = null;
    }

    if (!clickedHref) {
        await chrome.tabs.update(tabId, { url: targetUrl });
    }

    try {
        await waitTabComplete(tabId, 45000);
    } catch (_) { /* SPA may already be complete */ }

    // Ashby SPA: wait until path includes /application or form appears.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        let tab;
        try { tab = await chrome.tabs.get(tabId); } catch (_) { break; }
        const url = tab?.url || '';
        if (/\/application\/?($|\?|#)/i.test(url)) break;
        try {
            await ensureScripts(tabId);
            const detect = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' }).catch(() => null);
            if (detect?.ok && detect.data?.ok) break;
        } catch (_) { /* loading */ }
        await new Promise((r) => setTimeout(r, 500));
    }

    // If click stayed on JD, force navigate.
    try {
        const tab = await chrome.tabs.get(tabId);
        if (isAshbyJobDescriptionUrl(tab?.url || '')) {
            await chrome.tabs.update(tabId, { url: targetUrl });
            await waitTabComplete(tabId, 45000).catch(() => {});
            await new Promise((r) => setTimeout(r, 1200));
        }
    } catch (_) { /* ignore */ }

    await ensureScripts(tabId).catch(() => false);
    await new Promise((r) => setTimeout(r, 800));
    let finalUrl = targetUrl;
    try {
        finalUrl = (await chrome.tabs.get(tabId))?.url || targetUrl;
    } catch (_) { /* ignore */ }
    return { navigated: true, url: finalUrl };
}

async function seedGenerateTabStorage(tabId, token, user, pending, clipText) {
    const seedFn = (token, user, pending, clipText) => {
        try {
            if (token) localStorage.setItem('token', token);
            if (user) localStorage.setItem('user', JSON.stringify(user));
            sessionStorage.setItem('job_apply_bidder_pending', JSON.stringify(pending));
            sessionStorage.setItem('job_apply_bidder_show_preview', '1');
        } catch (_) { /* ignore */ }
        try {
            navigator.clipboard.writeText(clipText);
        } catch (_) { /* ignore */ }
    };

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            injectImmediately: true,
            func: seedFn,
            args: [token, user, pending, clipText]
        });
    } catch (_) {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: seedFn,
            args: [token, user, pending, clipText]
        });
    }
}

async function openGeneratePageAndInject({ settings, profile, job, coreSkills, samePageFill = false, jobTab = null }) {
    const payload = {
        company_name: job.company || '',
        job_role: job.title || '',
        job_url: job.url || '',
        job_description: job.description || '',
        core_skills: coreSkills.join(', '),
        font_family: '__random__',
        auto_generate: true,
        same_page_fill: !!samePageFill,
        session_id: settings.activeJobSession?.sessionId || null
    };

    const magicClipboard = JSON.stringify({
        magic: '__JOB_DETAILS_PAYLOAD__',
        version: 1,
        company_name: payload.company_name,
        job_role: payload.job_role,
        core_skills: payload.core_skills,
        job_url: payload.job_url,
        job_description: payload.job_description
    });

    const generateUrl =
        `${settings.frontendBaseUrl}/user/generate/${profile.id}?from_bidder=1`;

    const tab = await chrome.tabs.create({ url: generateUrl, active: true });

    // Seed auth + JD as early as possible (before React mount when we can).
    const onLoading = (tabId, info) => {
        if (tabId !== tab.id || info.status !== 'loading') return;
        seedGenerateTabStorage(tab.id, settings.token, settings.user, payload, magicClipboard).catch(() => {});
    };
    chrome.tabs.onUpdated.addListener(onLoading);

    await waitTabComplete(tab.id);
    chrome.tabs.onUpdated.removeListener(onLoading);

    // Idempotent fallback after load — no full tab reload.
    await seedGenerateTabStorage(tab.id, settings.token, settings.user, payload, magicClipboard);

    try {
        await chrome.tabs.sendMessage(tab.id, {
            type: 'BIDDER_INJECT_JOB',
            payload,
            token: settings.token,
            user: settings.user
        });
    } catch (_) {
        await new Promise((r) => setTimeout(r, 250));
        try {
            await chrome.tabs.sendMessage(tab.id, {
                type: 'BIDDER_INJECT_JOB',
                payload,
                token: settings.token,
                user: settings.user
            });
        } catch (_) {
            // sessionStorage + poll bridge in ResumeGenerator is enough.
        }
    }

    await saveActiveJobSession({
        generateTabId: tab.id,
        generateWindowId: tab.windowId,
        generateUrl,
        jobTabId: jobTab?.id ?? null,
        jobWindowId: jobTab?.windowId ?? null
    });

    return { tabId: tab.id, generateUrl, payload };
}

/**
 * Profile-only autofill on a known tab (works while CV is still generating).
 * No AI, no resume required.
 */
async function fillProfileOnTab(tabId, { profile, job }) {
    await ensureScripts(tabId);
    const form = await collectForm(tabId);
    if (form.blocked) {
        throw new Error(form.reason || 'This site is blocked for autofill');
    }
    const fieldCount = (form.fields || []).length + (form.fileInputs || []).length;
    if (fieldCount < 1) {
        return { filled: 0, questions: 0, uploaded: 0 };
    }

    const profileFields = {
        id: profile.id,
        first_name: profile.first_name,
        last_name: profile.last_name,
        email: profile.email,
        phone: profile.phone,
        linkedin_url: profile.linkedin_url,
        github_url: profile.github_url,
        city: profile.city,
        state: profile.state,
        country: profile.country,
        address: profile.address,
        postal_code: profile.postal_code,
        birthdate: profile.birthdate || '',
        salary_range: profile.salary_range || '',
        gender: profile.gender || '',
        work_authorization: profile.work_authorization || '',
        requires_sponsorship: profile.requires_sponsorship || '',
        disability_status: 'No, I do not have a disability',
        veteran_status: profile.veteran_status || '',
        race_ethnicity: profile.race_ethnicity || '',
        website_url: profile.website_url || '',
        portfolio_url: profile.portfolio_url || '',
        preferred_name: profile.preferred_name || '',
        over_18: profile.over_18 || '',
        hispanic_latino: profile.hispanic_latino || '',
        willing_to_relocate: profile.willing_to_relocate || '',
        willing_to_travel: profile.willing_to_travel || '',
        earliest_start_date: profile.earliest_start_date || '',
        notice_period: profile.notice_period || '',
        how_heard: profile.how_heard || 'LinkedIn',
        years_of_experience: profile.years_of_experience || '',
        education_level: profile.education_level || '',
        education: profile.education || '',
        school: profile.school || '',
        degree: profile.degree || '',
        discipline: profile.discipline || '',
        security_clearance: profile.security_clearance || ''
    };

    const writtenQuestions = (form.questions || []).filter(
        (q) => q.kind === 'question' || (q.answer_type === 'written' && q.kind !== 'salary')
    );

    const fillResult = await fillAndUpload(tabId, {
        fields: form.fields || [],
        answers: [],
        profile: profileFields,
        jobDescription: job.description || job.job_description || '',
        fileInputs: [],
        filename: null,
        base64: null,
        mimeType: null,
        autoSubmit: false
    });

    const filled = fillResult.fillStats?.filled || 0;
    await chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_TOAST',
        text: filled
            ? `Autofilled ${filled} profile field(s) while CV generates`
            : 'No profile fields matched yet',
        kind: filled ? 'ok' : 'info'
    }).catch(() => {});

    return {
        filled,
        uploaded: 0,
        questions: writtenQuestions.length,
        ats: fillResult.ats || form.ats
    };
}

async function runBidGenerate({ alsoFill = false } = {}) {
    const settings = await getSettings();
    if (!settings.token) {
        await notify('Lumi', 'Log in via the extension popup first');
        throw new Error('Not logged in');
    }
    if (!settings.selectedProfileId) {
        await notify('Lumi', 'Choose a bid profile in the extension popup');
        throw new Error('No profile selected');
    }

    const locks = await chrome.storage.local.get([GENERATING_KEY, 'generatingAt']);
    const genStarted = Number(locks.generatingAt || 0);
    const genStale = genStarted > 0 && (Date.now() - genStarted) > 10 * 60 * 1000;
    if (locks[GENERATING_KEY] && !genStale) {
        await notify('Lumi', 'A generate is already running');
        return;
    }

    await chrome.storage.local.set({ [GENERATING_KEY]: true, generatingAt: Date.now() });
    await notify('Lumi', 'Capturing job description…');

    try {
        const { tab, job } = await scrapeActiveTab();

        // Require a real JD: selection / picked block / known selector — not full-page junk.
        if (job.needsSelection || !job.description || job.description.length < 80) {
            await ensureScripts(tab.id);
            await chrome.tabs.sendMessage(tab.id, { type: 'START_JD_PICK' }).catch(() => {});
            await notify(
                'Select the JD first',
                'Highlight the job description (or click the JD block), then press Alt+Shift+G again'
            );
            await toastActiveTab(
                'Select JD text (or click JD block), then Alt+Shift+G',
                'error'
            );
            // Soft stop — already notified; do not throw (avoids red [bidder] Error in SW console).
            return {
                needsSelection: true,
                jobUrl: tab.url || job.url || ''
            };
        }

        if (job.source === 'none') {
            await chrome.tabs.sendMessage(tab.id, { type: 'START_JD_PICK' }).catch(() => {});
            await notify('Select the JD first', 'Could not find JD — click the description block, then Alt+Shift+G');
            return { needsSelection: true, jobUrl: tab.url || job.url || '' };
        }

        const copied = await copyJobToClipboard(tab.id, job);

        // Ashby: JD page has no form — open .../application in this tab after scrape.
        const jdUrl = job.url || tab.url || '';
        if (isAshbyJobDescriptionUrl(tab.url || jdUrl)) {
            try {
                await notify('Ashby', 'Opening application form…');
                const nav = await ensureAshbyApplicationPage(tab.id, tab.url || jdUrl);
                if (nav.navigated) {
                    job.url = jdUrl; // keep posting URL for CV / session
                    try {
                        const refreshed = await chrome.tabs.get(tab.id);
                        if (refreshed) Object.assign(tab, refreshed);
                    } catch (_) { /* ignore */ }
                }
            } catch (err) {
                console.warn('[bidder] ashby open application', err);
                await notify('Ashby', `Could not open application page: ${err?.message || err}`);
            }
        }

        const profiles = await listProfiles();
        const profile = (Array.isArray(profiles) ? profiles : [])
            .find((p) => Number(p.id) === Number(settings.selectedProfileId));
        if (!profile) throw new Error('Selected profile is no longer assigned to your account');

        let coreSkills = inferCoreSkillsFromJd(job.description, profile.techstacks);
        if (coreSkills.length === 0) {
            coreSkills = techstacksToCoreSkills(profile.techstacks).slice(0, 2);
        }
        if (coreSkills.length === 0) coreSkills = ['Python'];

        const sessionId = newSessionId();
        await saveActiveJobSession({
            sessionId,
            jobTabId: tab.id,
            jobWindowId: tab.windowId,
            jobUrl: jdUrl || job.url || tab.url || '',
            jobUrlKey: jobUrlKey(jdUrl || job.url || tab.url),
            jobDescription: job.description,
            jobSource: job.source || 'unknown',
            company: job.company || '',
            jobTitle: job.title || '',
            profileId: profile.id,
            generateTabId: null,
            applyTabId: /\/application\/?($|\?|#)/i.test(tab.url || '') ? tab.id : null,
            applicationId: null,
            resumeFilename: null,
            createdAt: new Date().toISOString()
        });

        // Greenhouse-style: JD + questions on one page → after CV, answer + fill this tab.
        // Ashby: after auto-nav to /application, form is on this tab too.
        let samePageFill = false;
        let formSnapshot = null;
        try {
            formSnapshot = await collectForm(tab.id);
            samePageFill = !formSnapshot?.blocked
                && Array.isArray(formSnapshot.questions)
                && formSnapshot.questions.length > 0;
            // Ashby application often has profile fields before AI questions.
            if (!samePageFill && detectAtsFromUrl(tab.url).id === 'ashby') {
                const fieldN = (formSnapshot?.fields || []).length;
                if (fieldN >= 2) samePageFill = true;
            }
        } catch (err) {
            console.warn('[bidder] form collect on generate', err);
        }

        if (samePageFill) {
            await saveSettings({
                pendingSamePageApply: {
                    applyTabId: tab.id,
                    applyUrl: tab.url || job.url || '',
                    sessionId,
                    autoAnswerWhenCvReady: true,
                    job: {
                        title: job.title,
                        company: job.company,
                        url: job.url,
                        description: job.description
                    },
                    form: {
                        ats: formSnapshot.ats,
                        fields: formSnapshot.fields || [],
                        questions: formSnapshot.questions || [],
                        fileInputs: formSnapshot.fileInputs || []
                    },
                    profileId: profile.id,
                    at: new Date().toISOString()
                }
            });
            await saveActiveJobSession({ applyTabId: tab.id });

            // Profile autofill NOW (no AI) while CV generates in parallel.
            try {
                await notify(
                    'Autofill while CV generates',
                    `Filling name/phone/… now · ${formSnapshot.questions.length} AI question(s) after CV`
                );
                await fillProfileOnTab(tab.id, { profile, job });
            } catch (err) {
                console.warn('[bidder] profile fill during generate', err);
                await notify('Profile autofill skipped', err?.message || String(err));
            }
        } else {
            await saveSettings({ pendingSamePageApply: null });
            // Still try profile fill if the page has personal fields (JD+apply hybrid).
            try {
                const fieldN = (formSnapshot?.fields || []).length;
                if (fieldN >= 2) {
                    await fillProfileOnTab(tab.id, { profile, job });
                    await saveActiveJobSession({ applyTabId: tab.id });
                    await saveSettings({
                        pendingSamePageApply: {
                            applyTabId: tab.id,
                            applyUrl: tab.url || job.url || '',
                            sessionId,
                            autoAnswerWhenCvReady: true,
                            job: {
                                title: job.title,
                                company: job.company,
                                url: job.url,
                                description: job.description
                            },
                            form: formSnapshot,
                            profileId: profile.id,
                            at: new Date().toISOString()
                        }
                    });
                }
            } catch (err) {
                console.warn('[bidder] optional profile fill', err);
            }
            await notify(
                'Lumi',
                copied
                    ? `JD captured (${job.source}) — opening Generate…`
                    : 'Opening Generate page with JD…'
            );
        }

        const opened = await openGeneratePageAndInject({
            settings: await getSettings(),
            profile,
            job,
            coreSkills,
            samePageFill,
            jobTab: tab
        });

        if (samePageFill) {
            await notify(
                'CV generating…',
                'Profile already autofilled. AI questions will fill when CV is ready.'
            );
        } else if (alsoFill && !samePageFill) {
            await notify('Generate started in app', 'When CV is ready: Answer questions on the apply form');
        } else if (!samePageFill) {
            await notify(
                'Watch Generate page',
                'CV generating — Autofill anytime; Answer questions after CV'
            );
        }

        const lastResult = {
            at: new Date().toISOString(),
            sessionId,
            jobTitle: job.title,
            company: job.company || '',
            jobUrl: job.url,
            jobDescription: job.description,
            jdSource: job.source,
            jdCopied: copied,
            openedGenerateUi: true,
            generateUrl: opened.generateUrl,
            generateTabId: opened.tabId,
            jobTabId: tab.id,
            jobWindowId: tab.windowId,
            profileId: profile.id,
            profileName: `${profile.first_name} ${profile.last_name}`,
            applicationId: null,
            resumeFilename: null,
            downloadUrl: null,
            validationPass: null,
            autoPassed: null,
            samePageFill,
            questionCount: samePageFill ? formSnapshot.questions.length : 0,
            fillStats: null
        };
        await saveSettings({ lastResult });
        return lastResult;
    } catch (err) {
        const message = err?.message || String(err);
        const soft = /Select the job description|Could not find JD|error page|Chrome error page|Open a job posting/i.test(message);
        await saveSettings({
            lastResult: { at: new Date().toISOString(), error: message },
            pendingSamePageApply: null
        });
        if (!soft) {
            await notify('Lumi failed', message);
        } else if (/error page|Chrome error page/i.test(message)) {
            await notify('Page failed to load', message);
        }
        if (soft) return { error: message, soft: true };
        throw err;
    } finally {
        await chrome.storage.local.set({ [GENERATING_KEY]: false });
    }
}

/**
 * Called when the Generate page finishes a CV (via app-bridge).
 * If this was a Greenhouse same-page run, draft answers and fill the apply tab.
 */
async function handleGenerateDone(result = {}) {
    const settings = await getSettings();
    const applicationId = result.application_id || null;
    const resumeFilename = result.resume_filename || null;
    const jobUrl = result.job_url || settings.lastResult?.jobUrl || null;

    await saveSettings({
        lastResult: {
            ...(settings.lastResult || {}),
            at: new Date().toISOString(),
            applicationId,
            resumeFilename,
            downloadUrl: resumeFilename
                ? resumeDownloadUrl(settings.apiBaseUrl, resumeFilename)
                : (settings.lastResult?.downloadUrl || null),
            validationPass: result.validation_pass,
            company: result.company_name || settings.lastResult?.company,
            jobTitle: result.job_role || settings.lastResult?.jobTitle,
            jobUrl,
            profileId: result.profile_id || settings.lastResult?.profileId
        }
    });

    // Remember this CV by job URL so Alt+Shift+F after refresh reconnects
    // to the same application_id (no regenerate).
    await rememberCvForJob({
        jobUrl,
        applicationId,
        resumeFilename,
        profileId: result.profile_id || settings.selectedProfileId,
        company: result.company_name,
        jobTitle: result.job_role
    });

    await saveActiveJobSession({
        applicationId,
        resumeFilename,
        company: result.company_name || settings.activeJobSession?.company,
        jobTitle: result.job_role || settings.activeJobSession?.jobTitle,
        jobUrl: jobUrl || settings.activeJobSession?.jobUrl,
        jobUrlKey: jobUrlKey(jobUrl || settings.activeJobSession?.jobUrl),
        profileId: result.profile_id || settings.selectedProfileId
    });

    const pending = settings.pendingSamePageApply;
    if (pending?.applyTabId) {
        await saveSettings({
            pendingSamePageApply: {
                ...pending,
                waitForManualFill: !pending.autoAnswerWhenCvReady,
                applicationId,
                resumeFilename
            }
        });
    }

    // After CV: auto-run AI answers on the apply tab (profile was filled during generate).
    if (pending?.autoAnswerWhenCvReady && pending.applyTabId && applicationId) {
        await notify(
            'CV ready — answering questions',
            'Profile already filled. Drafting AI answers from JD + CV…'
        );
        try {
            await chrome.tabs.get(pending.applyTabId);
            // Prefer staying on generate briefly then answers UI opens — run answers phase
            // with explicit tab so we don't scrape the Generate page.
            await runFillOnly({
                phase: 'answers',
                answerMode: 'auto',
                tabId: pending.applyTabId,
                jobOverride: pending.job || null,
                resultOverride: {
                    application_id: applicationId,
                    resume_filename: resumeFilename,
                    resume_html: result.resume_html || result.resume_content || result.draft_html || '',
                    company_name: result.company_name || pending.job?.company || '',
                    job_role: result.job_role || pending.job?.title || ''
                }
            });
            await saveSettings({ pendingSamePageApply: null });
            return { ok: true, filled: true, applicationId, autoAnswered: true };
        } catch (err) {
            console.warn('[bidder] auto answer after CV failed', err);
            await notify(
                'CV ready — answer manually',
                err?.message || 'Click Answer questions on the apply page'
            );
        }
    }

    await notify(
        'CV ready — preview on Generate',
        applicationId
            ? `App #${applicationId}. Profile may already be filled — use Answer questions for “why…”`
            : 'Review the CV, then Answer questions on the apply form.'
    );
    return { ok: true, filled: false, applicationId, deferredFill: true };
}

async function runFillOnly(opts = {}) {
    const phase = opts.phase || 'profile'; // Simplify default: profile autofill only
    const settings = await getSettings();
    if (!settings.token || !settings.selectedProfileId) {
        await notify('Lumi', 'Log in and choose a profile in the extension popup first');
        throw new Error('Log in and choose a profile first');
    }

    await acquireFillLock();
    const phaseLabel = phase === 'answers'
        ? 'Answer questions…'
        : phase === 'full'
            ? 'Autofill + answer questions…'
            : 'Autofill (profile)…';
    await notify('Lumi', phaseLabel);
    await toastActiveTab(phaseLabel, 'info');

    try {
        let tab;
        let job;
        if (opts.tabId) {
            tab = await chrome.tabs.get(opts.tabId);
            await ensureScripts(tab.id);
            job = opts.jobOverride
                ? {
                    title: opts.jobOverride.title || '',
                    company: opts.jobOverride.company || '',
                    url: opts.jobOverride.url || tab.url || '',
                    description: opts.jobOverride.description || ''
                }
                : {
                    title: '',
                    company: '',
                    url: tab.url || '',
                    description: ''
                };
            // Prefer session JD text when answering
            const session0 = settings.activeJobSession;
            if ((!job.description || job.description.length < 80) && session0?.jobDescription) {
                job.description = session0.jobDescription;
                job.title = job.title || session0.jobTitle || '';
                job.company = job.company || session0.company || '';
            }
        } else {
            const scraped = await scrapeActiveTab();
            tab = scraped.tab;
            job = scraped.job;
        }

        const session = settings.activeJobSession;
        const pageUrl = tab.url || job.url || '';

        const fe = settings.frontendBaseUrl || '';
        if (
            (fe && pageUrl.startsWith(fe))
            || /\/user\/generate\//i.test(pageUrl)
            || /localhost:5173|127\.0\.0\.1:5173/.test(pageUrl)
        ) {
            throw new Error('Switch to the job apply form tab (not the Generate page)');
        }

        const linked = await findCvLinkForUrl(pageUrl, settings.selectedProfileId);
        const gate = assertJobSessionMatch({
            pageUrl,
            tabId: tab.id,
            windowId: tab.windowId,
            session,
            linked,
            lastResult: settings.lastResult
        });
        if (!gate.ok) {
            throw new Error(gate.error);
        }

        await saveActiveJobSession({
            applyTabId: tab.id,
            applyUrl: pageUrl
        });

        await chrome.tabs.sendMessage(tab.id, {
            type: 'SHOW_TOAST',
            text: 'Lumi: working on this page…',
            kind: 'info'
        }).catch(() => {});

        if (phase === 'answers' || phase === 'full') {
            let formPreview = null;
            try {
                formPreview = await collectForm(tab.id);
            } catch (_) { /* ignore */ }
            const writtenQs = (formPreview?.questions || []).filter(
                (q) => q.kind === 'question' || q.kind === 'salary'
            );
            if (writtenQs.length > 0 && !formPreview?.hasQuestionSelection) {
                await chrome.tabs.sendMessage(tab.id, { type: 'SELECT_ALL_QUESTIONS' }).catch(() => {});
            }
        }

        let profile = null;
        let result = {
            application_id: null,
            resume_filename: null,
            resume_html: '',
            company_name: job.company || session?.company || settings.lastResult?.company || '',
            job_role: job.title || session?.jobTitle || settings.lastResult?.jobTitle || '',
            ...(opts.resultOverride || {})
        };
        if (opts.resultOverride?.application_id) {
            result.application_id = opts.resultOverride.application_id;
        }
        if (opts.resultOverride?.resume_filename) {
            result.resume_filename = opts.resultOverride.resume_filename;
        }
        if (opts.resultOverride?.resume_html) {
            result.resume_html = opts.resultOverride.resume_html;
        }

        // Prefer session CV (bound to this job window), then cvLink for this URL.
        if (session?.applicationId || session?.resumeFilename) {
            result.application_id = session.applicationId || null;
            result.resume_filename = session.resumeFilename || null;
            result.company_name = session.company || result.company_name;
            result.job_role = session.jobTitle || result.job_role;
            if (session.jobDescription) {
                job.description = session.jobDescription;
            }
        } else if (linked?.applicationId || linked?.resumeFilename) {
            result.application_id = linked.applicationId || null;
            result.resume_filename = linked.resumeFilename || null;
            result.company_name = linked.company || result.company_name;
            result.job_role = linked.jobTitle || result.job_role;
        }

        if (settings.lastResult?.applicationId && !result.application_id) {
            result.application_id = settings.lastResult.applicationId;
            result.resume_filename = settings.lastResult.resumeFilename || result.resume_filename;
        }

        try {
            const profiles = await listProfiles();
            profile = (profiles || []).find((p) => String(p.id) === String(settings.selectedProfileId))
                || (profiles || [])[0];
        } catch (_) { /* ignore */ }

        if (result.application_id) {
            try {
                const packed = await getBidderApplication(result.application_id);
                if (packed?.application) {
                    result.resume_filename = packed.application.resume_filename || result.resume_filename;
                    result.resume_html = packed.application.draft_html || result.resume_html || '';
                    result.company_name = packed.application.company_name || result.company_name;
                    result.job_role = packed.application.job_role || result.job_role;
                    job.description = packed.application.job_description || job.description || session?.jobDescription || '';
                    if (packed.profile) profile = packed.profile;
                }
            } catch (err) {
                console.warn('[bidder] application fetch failed', err);
            }
        }

        if (!result.application_id && !result.resume_filename) {
            try {
                const byUrl = await getBidderApplicationByJobUrl(pageUrl, settings.selectedProfileId);
                if (byUrl?.application) {
                    result.application_id = byUrl.application.id;
                    result.resume_filename = byUrl.application.resume_filename;
                    result.resume_html = byUrl.application.draft_html || '';
                    result.company_name = byUrl.application.company_name || result.company_name;
                    result.job_role = byUrl.application.job_role || result.job_role;
                    job.description = byUrl.application.job_description || job.description;
                    if (byUrl.profile) profile = byUrl.profile;
                }
            } catch (_) { /* ignore */ }
        }

        if (!profile) {
            throw new Error('No profile selected — save a bid profile in the popup');
        }

        if (phase === 'answers' && !result.resume_filename && !result.application_id && !result.resume_html) {
            throw new Error('Generate a CV first (Alt+Shift+G), then Answer questions');
        }

        if (session?.jobDescription && session.jobDescription.length > 80) {
            job.description = session.jobDescription;
        }

        const fillStats = await autofillAfterGenerate({
            tabId: tab.id,
            settings,
            profile,
            job,
            result,
            phase,
            answerMode: opts.answerMode || 'interactive'
        });

        await rememberCvForJob({
            jobUrl: pageUrl,
            applicationId: fillStats.applicationId || result.application_id,
            resumeFilename: result.resume_filename,
            profileId: settings.selectedProfileId,
            company: result.company_name,
            jobTitle: result.job_role
        });

        await saveActiveJobSession({
            applicationId: fillStats.applicationId || result.application_id,
            resumeFilename: result.resume_filename,
            applyTabId: tab.id,
            applyUrl: pageUrl
        });

        await saveSettings({
            pendingFill: null,
            lastResult: {
                ...(settings.lastResult || {}),
                at: new Date().toISOString(),
                applicationId: fillStats.applicationId || result.application_id,
                filled: fillStats.filled,
                uploaded: fillStats.uploaded,
                resumeFilename: result.resume_filename || settings.lastResult?.resumeFilename,
                jobUrl: pageUrl || settings.lastResult?.jobUrl,
                sessionId: session?.sessionId || settings.lastResult?.sessionId,
                phase
            }
        });

        const msg = phase === 'profile'
            ? `Autofilled ${fillStats.filled || 0} field(s)`
                + (fillStats.uploaded ? `, uploaded resume` : '')
                + (fillStats.questions ? ` · ${fillStats.questions} need Answer questions` : '')
            : `Filled ${fillStats.filled || 0}`
                + (fillStats.answers ? `, answers ${fillStats.answers}` : '');
        await notify('Lumi', msg);
        await toastActiveTab(msg, (fillStats.filled || 0) > 0 ? 'ok' : 'error');
        return fillStats;
    } catch (err) {
        const message = err?.message || String(err);
        await notify('Fill failed', message);
        await toastActiveTab('Fill failed: ' + message, 'error');
        throw err;
    } finally {
        await clearFillLock();
    }
}

/**
 * Stay-in-Lumi focus helper.
 * Only reclaim focus from OUR apply/background window — never yank the user
 * out of Gmail, another Chrome window, or any unrelated tab.
 * Pass { force: true } right after we open an apply tab.
 */
async function refocusStayInAppHome(opts = {}) {
    const force = !!opts.force;
    try {
        const { captchaUserFocusHoldUntil } = await chrome.storage.session.get('captchaUserFocusHoldUntil');
        if (Date.now() < Number(captchaUserFocusHoldUntil || 0)) return false;
    } catch (_) { /* ignore */ }

    const isApp = (u) => /localhost:5173|127\.0\.0\.1:5173|localhost:3000|127\.0\.0\.1:3000/i.test(u || '');
    try {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!force && isApp(active?.url) && !/job-links/i.test(active.url || '')) return false;
    } catch (_) { /* ignore */ }
    const pickHome = async () => {
        const tabs = await chrome.tabs.query({});
        return (
            tabs.find((t) => isApp(t.url) && /job-links/i.test(t.url || ''))
            || tabs.find((t) => isApp(t.url))
            || null
        );
    };

    try {
        const home = await pickHome();
        if (!home?.id) return false;

        if (!force) {
            let bgId = null;
            try {
                bgId = (await chrome.storage.session.get(['bidderBgWindowId']))?.bidderBgWindowId || null;
            } catch (_) { /* ignore */ }
            let focused = null;
            try {
                focused = await chrome.windows.getLastFocused();
            } catch (_) { /* ignore */ }
            const focusedId = focused?.id;
            // Already on Job Links window — nothing to reclaim.
            if (focusedId != null && focusedId === home.windowId) return true;
            // User is in some other window (not our apply bg) — leave them alone.
            if (focusedId != null && bgId != null && focusedId !== bgId) return false;
            if (focusedId != null && bgId == null && focusedId !== home.windowId) return false;
        }

        await chrome.tabs.update(home.id, { active: true });
        if (home.windowId != null) {
            await chrome.windows.update(home.windowId, { focused: true });
        }
        // One short re-assert only when we just opened an apply tab (debugger can steal once).
        if (force) {
            setTimeout(() => {
                chrome.storage.session.get('captchaUserFocusHoldUntil').then((data) => {
                    if (Date.now() < Number(data?.captchaUserFocusHoldUntil || 0)) return;
                    pickHome().then((h) => {
                        if (!h?.id) return;
                        chrome.tabs.update(h.id, { active: true }).catch(() => {});
                        if (h.windowId != null) {
                            chrome.windows.update(h.windowId, { focused: true }).catch(() => {});
                        }
                    }).catch(() => {});
                }).catch(() => {});
            }, 200);
        }
        return true;
    } catch (_) {
        return false;
    }
}

/** Dedicated unfocused window for apply tabs — Job Links window never switches. */
async function getOrCreateBidderBgWindow() {
    try {
        const stored = await chrome.storage.session.get(['bidderBgWindowId']);
        const id = stored?.bidderBgWindowId;
        if (id) {
            try {
                const win = await chrome.windows.get(id);
                if (win?.id) return win;
            } catch (_) { /* gone */ }
        }
    } catch (_) { /* session storage may be unavailable */ }
    return null;
}

async function closeBidderTab(tabId) {
    if (!tabId) return;
    await releasePageDebugger(tabId);
    try { await chrome.tabs.remove(tabId); } catch (_) { /* ignore */ }
}

async function openReadyApplication(item, { fromQueue = false } = {}) {
    if (!item?.open_url) throw new Error('No apply URL on this application');
    const settings = await getSettings();
    const prefs = await getBidderPrefs();

    // Wait for CV if somehow not ready
    if (!item.resume_filename) {
        throw new Error('CV not ready yet — wait for generation');
    }

    // Ashby Overview JD has no form — open .../application directly.
    const applyUrl = isAshbyJobDescriptionUrl(item.open_url)
        ? ashbyApplicationUrl(item.open_url)
        : item.open_url;

    await rememberCvForJob({
        jobUrl: applyUrl,
        applicationId: item.id,
        resumeFilename: item.resume_filename,
        profileId: item.profile_id,
        company: item.company_name,
        jobTitle: item.job_role
    });

    await saveSettings({
        pendingFill: {
            applicationId: item.id,
            profileId: item.profile_id,
            resumeFilename: item.resume_filename,
            company: item.company_name,
            jobRole: item.job_role,
            jobUrl: applyUrl,
            // Queue Process drives fill itself — never auto-start a second fill on tab load
            // (that raced acquireFillLock → "Fill already in progress" every Process).
            autoFillWhenReady: !fromQueue,
            fromBidder: true,
            autoSubmit: prefs.autoSubmit
        },
        lastResult: {
            at: new Date().toISOString(),
            applicationId: item.id,
            profileId: item.profile_id,
            resumeFilename: item.resume_filename,
            company: item.company_name,
            jobTitle: item.job_role,
            jobUrl: applyUrl,
            downloadUrl: item.resume_filename
                ? resumeDownloadUrl(settings.apiBaseUrl, item.resume_filename)
                : null,
            fromMode2: true,
            fromBidder: true
        },
        selectedProfileId: item.profile_id || settings.selectedProfileId
    });

    await logCourseEvent(item.id, 'opened', {
        url: applyUrl,
        fromQueue,
        stayInApp: true,
        ashbyApplication: applyUrl !== item.open_url,
        bgWindow: true
    });

    // Always open apply pages in a separate unfocused window so the Job Links
    // tab never redirects. Live monitor stays visible in the app window.
    let bgWin = await getOrCreateBidderBgWindow();
    let tab;
    if (bgWin?.id) {
        tab = await chrome.tabs.create({
            windowId: bgWin.id,
            url: applyUrl,
            active: false
        });
        try { await chrome.windows.update(bgWin.id, { focused: false }); } catch (_) { /* ignore */ }
    } else {
        bgWin = await chrome.windows.create({
            url: applyUrl,
            focused: false,
            type: 'normal',
            width: 1100,
            height: 800,
            left: 80,
            top: 80
        });
        tab = bgWin.tabs?.[0];
        try {
            await chrome.storage.session.set({ bidderBgWindowId: bgWin.id });
        } catch (_) { /* ignore */ }
    }
    // Do not yank Job Links (or any other window) to the front — user may be in Gmail/etc.
    try { await chrome.windows.update(bgWin.id, { focused: false }); } catch (_) { /* ignore */ }

    await notify(
        'Apply page opened',
        'Bidder — background window. You can keep using other tabs; watch Live monitor.'
    );
    return { ok: true, tabId: tab.id, url: applyUrl, windowId: bgWin.id };
}

/**
 * Process ready queue until daily cap / empty / stop.
 * Max 3 tabs, 15s between opens. CAPTCHA/login: focus tab, pause queue
 * (default) until you solve it, then resume fill — no auto-bypass.
 */
async function processReadyQueue(opts = {}) {
    const jobLinkIds = Array.isArray(opts.jobLinkIds)
        ? opts.jobLinkIds.map((id) => parseInt(id, 10)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
    const applicationIds = Array.isArray(opts.applicationIds)
        ? opts.applicationIds.map((id) => parseInt(id, 10)).filter((n) => Number.isInteger(n) && n > 0)
        : [];

    const gotLock = await acquireQueueLock();
    if (!gotLock) {
        throw new Error(
            'Queue already in progress — use Live monitor (Resume / Next / Stop). Do not click Process again.'
        );
    }

    // Always start Process clean — a stuck Autofill lock or prior Stop must not block bidding.
    await clearFillLock();
    // Cancel any leftover Mode-2 pendingFill so tab-complete cannot race Process fill.
    try {
        await saveSettings({ pendingFill: null });
    } catch (_) { /* ignore */ }

    // MV3: early sendResponse (queued≥1) can let Chrome sleep the SW mid-queue.
    // Ping storage periodically so Process keeps running through Greenhouse fill.
    const keepAlive = setInterval(() => {
        try {
            chrome.storage.local.get(['bidderQueueState']).catch(() => {});
        } catch (_) { /* ignore */ }
    }, 4000);

    let prefs = await getBidderPrefs();
    if (
        opts.uploadCoverLetter != null
        || opts.stayInApp != null
        || opts.unattended != null
        || opts.captchaGraceSec != null
        || opts.autoSubmit != null
        || opts.autoNext != null
        || opts.captchaHelper != null
        || opts.capsolverApiKey != null
        || opts.twocaptchaApiKey != null
        || opts.disabledFillLessons != null
    ) {
        const patch = {};
        if (opts.uploadCoverLetter != null) patch.bidderUploadCoverLetter = !!opts.uploadCoverLetter;
        if (opts.stayInApp != null) patch.bidderStayInApp = !!opts.stayInApp;
        if (opts.unattended != null) patch.bidderUnattended = !!opts.unattended;
        if (opts.autoSubmit != null) patch.bidderAutoSubmit = !!opts.autoSubmit;
        if (opts.autoNext != null) patch.bidderAutoNext = !!opts.autoNext;
        if (opts.captchaHelper != null) patch.bidderCaptchaHelper = !!opts.captchaHelper;
        if (opts.captchaHelperWaitSec != null && Number(opts.captchaHelperWaitSec) >= 0) {
            patch.bidderCaptchaHelperWaitSec = Number(opts.captchaHelperWaitSec);
        }
        if (opts.captchaGraceSec != null && Number(opts.captchaGraceSec) >= 0) {
            patch.bidderCaptchaGraceSec = Number(opts.captchaGraceSec);
        }
        if (opts.capsolverApiKey != null) {
            patch.bidderCapsolverApiKey = String(opts.capsolverApiKey || '').trim();
        }
        if (opts.twocaptchaApiKey != null) {
            patch.bidderTwocaptchaApiKey = String(opts.twocaptchaApiKey || '').trim();
        }
        if (opts.disabledFillLessons != null && typeof opts.disabledFillLessons === 'object') {
            patch.bidderDisabledFillLessons = opts.disabledFillLessons;
        }
        await saveBidderPrefs(patch);
        Object.assign(prefs, {
            uploadCoverLetter: patch.bidderUploadCoverLetter ?? prefs.uploadCoverLetter,
            stayInApp: true,
            unattended: patch.bidderUnattended ?? prefs.unattended,
            autoSubmit: patch.bidderAutoSubmit ?? prefs.autoSubmit,
            autoNext: patch.bidderAutoNext ?? prefs.autoNext,
            captchaHelper: patch.bidderCaptchaHelper ?? prefs.captchaHelper,
            captchaGraceMs: patch.bidderCaptchaGraceSec != null
                ? Math.round(Number(patch.bidderCaptchaGraceSec) * 1000)
                : prefs.captchaGraceMs,
            captchaHelperWaitMs: patch.bidderCaptchaHelperWaitSec != null
                ? Math.round(Number(patch.bidderCaptchaHelperWaitSec) * 1000)
                : prefs.captchaHelperWaitMs,
            capsolverApiKey: patch.bidderCapsolverApiKey != null
                ? patch.bidderCapsolverApiKey
                : prefs.capsolverApiKey,
            twocaptchaApiKey: patch.bidderTwocaptchaApiKey != null
                ? patch.bidderTwocaptchaApiKey
                : prefs.twocaptchaApiKey,
            disabledFillLessons: patch.bidderDisabledFillLessons != null
                ? patch.bidderDisabledFillLessons
                : prefs.disabledFillLessons
        });
    }
    // Stay on Job Links for Live monitor. Hands-free (unattended) must NOT force captchaFocus —
    // that path waits for helpers / CapSolver and continues the queue without you.
    prefs.stayInApp = true;
    if (prefs.unattended) {
        prefs.captchaFocus = false;
    } else {
        prefs.captchaFocus = prefs.captchaFocus !== false;
    }
    const settings = await getSettings();
    if (!settings.token) {
        clearInterval(keepAlive);
        await releaseQueueLock();
        throw new Error('Log in first (Job Links page session will sync into Lumi on Process)');
    }
    if (!settings.selectedProfileId && !jobLinkIds.length && !applicationIds.length) {
        clearInterval(keepAlive);
        await releaseQueueLock();
        throw new Error('Choose a bid profile in the popup');
    }

    try {
        await setQueueState({
            running: true,
            status: 'loading',
            error: null,
            jobLinkIds,
            applicationIds,
            stopRequested: false,
            nextClicked: false,
            queueStartedAt: Date.now()
        });
        let items = [];
        try {
            const data = await listBidderReady(
                200,
                // When the user picks Job Links in the UI, bid those ready CVs
                // even if Lumi's popup profile differs (fill uses each app's profile).
                jobLinkIds.length || applicationIds.length ? null : settings.selectedProfileId,
                jobLinkIds.length ? jobLinkIds : null
            );
            items = data?.items || [];
            if (applicationIds.length) {
                const allow = new Set(applicationIds);
                const scoped = items.filter((it) => allow.has(Number(it.id)));
                if (scoped.length) items = scoped;
                else if (!jobLinkIds.length) {
                    items = [];
                }
            }
            if (jobLinkIds.length && settings.selectedProfileId && items.length > 1) {
                const preferred = items.filter(
                    (it) => Number(it.profile_id) === Number(settings.selectedProfileId)
                );
                if (preferred.length) items = preferred;
            }
        } catch (err) {
            if (err.status === 401 || err.authExpired) {
                await notify('Lumi', 'Session expired — log in again');
                await setQueueState({ running: false, status: 'auth', error: 'login_required' });
                throw new Error('Session expired — pause and log in on Job Links, then Process again');
            }
            throw err;
        }

        if (!items.length) {
            const msg = jobLinkIds.length || applicationIds.length
                ? `No ready CVs for the selected Job Link(s) under this login. Use the same account in Lumi as Job Links (or click Process again so the page session syncs).`
                : `No ready applications for Lumi profile #${settings.selectedProfileId}`;
            await notify('Bidder', msg);
            await setQueueState({ running: false, status: 'empty' });
            return { ok: false, processed: 0, queued: 0, error: msg, filtered: jobLinkIds.length > 0 };
        }

        // Signal caller that the queue is real (not empty) before long work.
        if (typeof opts.onReady === 'function') {
            try {
                opts.onReady({ ok: true, started: true, queued: items.length, jobLinkIds });
            } catch (_) { /* ignore */ }
        }

        const names = items
            .slice(0, 3)
            .map((it) => it.company_name || it.job_role || `#${it.id}`)
            .join(', ');
        await notify(
            'Bidder',
            `Starting ${items.length} job(s)${names ? `: ${names}` : ''}${items.length > 3 ? '…' : ''}`
        );

        await setQueueState({
            running: true,
            status: 'running',
            total: items.length,
            index: 0,
            openTabIds: [],
            queueStartedAt: Date.now()
        });

        let processed = 0;
        let skippedAts = 0; // legacy counter (LinkedIn-only skips logged as blocked_ats during fill)
        let lastOpenAt = 0;
        const openTabs = new Map(); // tabId -> item
        // Greenhouse email OTP: keep these tabs open after queue (never leftover-close).
        const holdEmailOtpTabs = new Map(); // tabId -> { id, company_name, ... }

        for (let i = 0; i < items.length; i++) {
            const state = await getQueueState();
            if (state?.stopRequested) break;

            // Soft wait until under max tabs
            while (openTabs.size >= BIDDER_DEFAULTS.maxTabs) {
                await new Promise((r) => setTimeout(r, 1000));
                // Drop closed tabs
                for (const tid of [...openTabs.keys()]) {
                    try {
                        await chrome.tabs.get(tid);
                    } catch {
                        openTabs.delete(tid);
                    }
                }
                const st2 = await getQueueState();
                if (st2?.stopRequested) break;
            }

            const gap = BIDDER_DEFAULTS.openGapMs - (Date.now() - lastOpenAt);
            if (lastOpenAt && gap > 0) {
                await new Promise((r) => setTimeout(r, gap));
            }

            const item = items[i];
            const applyUrl = item.open_url || item.job_url || '';
            const itemAts = resolveBidderAts({
                applyUrl,
                tabUrl: applyUrl,
                formAts: item.ats || item.ats_name || 'generic'
            });
            await setQueueState({
                index: i + 1,
                currentId: item.id,
                currentJobUrl: applyUrl || null,
                currentTabId: null,
                jobStartedAt: Date.now()
            });
            await setAppRunState(item.id, 'opening', {
                url: applyUrl || null,
                eventType: 'run_opening'
            }).catch(() => {});

            // Always create/update a bid course so failures are visible in the UI.
            await logCourseEvent(item.id, 'queue_started', {
                job_link_id: item.job_link_id || null,
                company: item.company_name || null,
                url: applyUrl || null,
                ats: itemAts
            });

            let opened = null;
            try {
                opened = await openReadyApplication(item, { fromQueue: true });
            } catch (err) {
                await logCourseEvent(item.id, 'open_failed', { error: err?.message });
                await notify('Bidder', `Skip open: ${err?.message || err}`);
                continue;
            }
            lastOpenAt = Date.now();
            openTabs.set(opened.tabId, item);
            await setQueueState({
                currentTabId: opened.tabId,
                currentJobUrl: applyUrl || opened.url || null
            });
            await setAppRunState(item.id, 'gating', {
                tabId: opened.tabId,
                url: applyUrl || opened.url || null,
                eventType: 'run_gating'
            }).catch(() => {});

            try {
            // Wait for form. Prefer clicking Apply — never CAPTCHA-pause while Apply is still on the page.
            let formOk = false;
            let captchaHandoff = false;
            let applyClickedOnce = false;
            let lastApplyMeta = null;
            let profileEmail = String(
                item.email || item.profile_email || item.candidate_email || ''
            ).trim();
            if (!profileEmail) {
                try {
                    const packed = await getBidderApplication(item.id);
                    profileEmail = String(
                        packed?.profile?.email
                        || packed?.email
                        || packed?.application?.email
                        || ''
                    ).trim();
                } catch (_) { /* ignore */ }
            }
            // Apply-gate wait — ATS-aware (slow SPAs need longer; still capped).
            const formWaitMs = Math.min(
                formWaitMsForAts(itemAts, Number(prefs.formWaitMs) || BIDDER_DEFAULTS.formWaitMs),
                22000
            );
            const formDeadline = Date.now() + formWaitMs;
            const bidLimitMs = bidLimitMsForAts(itemAts, { pageCount: 0 });
            const bidDeadline = Date.now() + bidLimitMs;
            while (Date.now() < formDeadline) {
                try {
                    await ensureScripts(opened.tabId);
                    const revealedEarly = await ensureApplyFormVisible(opened.tabId, {
                        profileEmail,
                        applicationId: item.id
                    });
                    if (revealedEarly?.tabId && revealedEarly.tabId !== opened.tabId) {
                        openTabs.delete(opened.tabId);
                        opened.tabId = revealedEarly.tabId;
                        openTabs.set(opened.tabId, item);
                        await setQueueState({
                            currentTabId: opened.tabId,
                            currentJobUrl: revealedEarly.href || opened.url || null
                        }).catch(() => {});
                    }
                    if (revealedEarly?.clicked || revealedEarly?.applyFound) {
                        applyClickedOnce = applyClickedOnce || !!revealedEarly.clicked;
                        lastApplyMeta = revealedEarly;
                    }
                    const detect = await chrome.tabs.sendMessage(opened.tabId, { type: 'DETECT_APPLY_FORM' });
                    if (detect?.ok && detect.data?.ok) {
                        formOk = true;
                        // Learn: this Apply label/selector got us a form on this host.
                        if (lastApplyMeta?.applyLabel || lastApplyMeta?.applySelector) {
                            try {
                                const tab = await chrome.tabs.get(opened.tabId);
                                const h = new URL(tab.url || '').hostname;
                                await saveApplyLesson({
                                    host: h,
                                    label: lastApplyMeta.applyLabel,
                                    selector: lastApplyMeta.applySelector,
                                    href: tab.url,
                                    outcome: 'form_ok'
                                });
                                await logCourseEvent(item.id, 'apply_lesson_saved', {
                                    label: lastApplyMeta.applyLabel,
                                    selector: lastApplyMeta.applySelector
                                }).catch(() => {});
                            } catch (_) { /* ignore */ }
                        }
                        break;
                    }
                    // JD / careers pages: Apply is the only action. Do not treat as CAPTCHA/login.
                    if (revealedEarly?.applyFound || revealedEarly?.clicked) {
                        await new Promise((r) => setTimeout(r, 1000));
                        continue;
                    }
                    const wall = await detectCaptchaOrLogin(opened.tabId);
                    let formReadyNow = false;
                    try {
                        const dForm = await chrome.tabs.sendMessage(opened.tabId, { type: 'DETECT_APPLY_FORM' });
                        formReadyNow = !!(dForm?.ok && dForm?.data?.ok);
                    } catch (_) { /* loading */ }
                    if (formReadyNow && !wall?.login
                        && !isBlockingCaptchaWall(wall, { formReady: true })) {
                        formOk = true;
                        break;
                    }
                    if ((wall.captcha || wall.login) && isBlockingCaptchaWall(wall, { formReady: formReadyNow })) {
                        captchaHandoff = true;
                        const wait = await runCaptchaPassEngine({
                            tabId: opened.tabId,
                            applicationId: item.id,
                            prefs,
                            wall,
                            phase: 'open',
                            companyLabel: item.company_name || 'Job'
                        });
                        if (wait.stopped) break;
                        if (wait.tabClosed || wait.timeout || wait.skippedWait || wait.abandoned || !wait.cleared) {
                            if ((wait.tabClosed || wait.timeout) && !wait.abandoned) {
                                await logCourseEvent(item.id, 'captcha_abandoned', wait);
                            }
                            if (!wait.abandoned && prefs.unattended) {
                                try { await chrome.tabs.remove(opened.tabId); } catch (_) { /* ignore */ }
                            }
                            openTabs.delete(opened.tabId);
                            formOk = false;
                            break;
                        }
                        formOk = await recheckFormAfterCaptcha(opened.tabId);
                        captchaHandoff = false;
                        break;
                    }
                } catch (_) { /* loading */ }
                await new Promise((r) => setTimeout(r, 800));
            }

            // Unattended / user may have closed the apply tab — skip quietly.
            {
                const alive = await chrome.tabs.get(opened.tabId).catch(() => null);
                if (!alive) {
                    openTabs.delete(opened.tabId);
                    await logCourseEvent(item.id, 'tab_closed', { phase: 'form_wait' }).catch(() => {});
                    continue;
                }
            }

            if (!formOk) {
                // Last try: click Apply once more before deciding CAPTCHA / no-form
                const lastReveal = await ensureApplyFormVisible(opened.tabId, {
                    profileEmail,
                    applicationId: item.id
                }).catch(() => null);
                if (lastReveal?.tabId && lastReveal.tabId !== opened.tabId) {
                    openTabs.delete(opened.tabId);
                    opened.tabId = lastReveal.tabId;
                    openTabs.set(opened.tabId, item);
                }
                if (lastReveal?.clicked || lastReveal?.applyFound) {
                    formOk = await recheckFormAfterCaptcha(opened.tabId, Math.min(18000, formWaitMs));
                    if (formOk && (lastReveal.applyLabel || lastReveal.applySelector)) {
                        try {
                            const tab = await chrome.tabs.get(opened.tabId);
                            await saveApplyLesson({
                                host: new URL(tab.url || '').hostname,
                                label: lastReveal.applyLabel,
                                selector: lastReveal.applySelector,
                                href: tab.url,
                                outcome: 'form_ok'
                            });
                        } catch (_) { /* ignore */ }
                    }
                }
            }

            if (!formOk) {
                const wall = await detectCaptchaOrLogin(opened.tabId).catch(() => ({}));
                // Still on a JD with Apply — keep tab open for Open/Resume; do not hard-fail as "can't do that".
                const stillApply = await ensureApplyFormVisible(opened.tabId, {
                    profileEmail,
                    applicationId: item.id
                }).catch(() => null);
                if (stillApply?.applyFound || applyClickedOnce) {
                    await logCourseEvent(item.id, 'needs_manual', {
                        reason: 'apply_gate',
                        applyClickedOnce,
                        applyLabel: stillApply?.applyLabel || lastApplyMeta?.applyLabel || null,
                        detail: 'Apply visible or clicked but form not ready — Open tab and click Apply / create account, then Resume'
                    });
                    await uploadScreenshot(item.id, 'live', opened.tabId, {
                        settleMs: 200,
                        stayInApp: true
                    }).catch(() => {});
                    await setQueueState({
                        status: 'awaiting_captcha',
                        captchaTabId: opened.tabId,
                        captchaApplicationId: item.id,
                        captchaJobUrl: stillApply?.href || null,
                        lastStatusEvent: 'needs_manual',
                        lastStatusAt: Date.now(),
                        lastStatusMeta: { reason: 'apply_gate' }
                    }).catch(() => {});
                    await notify(
                        'Bidder',
                        `Apply gate — finish Apply / account on tab, then Resume (${item.company_name || item.id})`
                    );
                    // Leave tab open for the human / next Resume — do not remove.
                    continue;
                }
                if (isBlockingCaptchaWall(wall, { formReady: false }) || captchaHandoff) {
                    // Attended: leave tab open for human. Unattended: tab already closed.
                    if (!prefs.unattended) {
                        // Tab left open for human; do not close
                    } else {
                        try { await chrome.tabs.remove(opened.tabId); } catch (_) { /* ignore */ }
                        openTabs.delete(opened.tabId);
                    }
                    continue;
                }
                await logCourseEvent(item.id, 'no_form', {});
                await notify('Bidder', `No form in ${Math.round(formWaitMs / 1000)}s — skip ${item.company_name || item.id}`);
                try { await chrome.tabs.remove(opened.tabId); } catch (_) {}
                openTabs.delete(opened.tabId);
                continue;
            }

            // Greenhouse JD sits above the form — click Apply + scroll before capture/fill.
            const revealed = await ensureApplyFormVisible(opened.tabId);
            await logCourseEvent(item.id, 'form_revealed', revealed);
            await refocusStayInAppHome();

            // Live frames fire on status events (≤0.5s) — no 3s interval.

            // Let the form paint before the "opened" capture (was too early).
            await new Promise((r) => setTimeout(r, 800));
            await ensureApplyFormVisible(opened.tabId);
            await uploadScreenshot(item.id, 'opened', opened.tabId, { settleMs: 600, stayInApp: true });
            await logCourseEvent(item.id, 'form_detected', { revealed });

            await setAppRunState(item.id, 'filling', {
                tabId: opened.tabId,
                url: applyUrl || opened.url || null,
                eventType: 'run_filling'
            }).catch(() => {});

            // Clear per-job lesson stash from prior item.
            if (prefs.earlyFillLessons || prefs.earlyFillLessonMeta) {
                prefs = { ...prefs, earlyFillLessons: undefined, earlyFillLessonMeta: undefined };
            }

            // Early lesson replay for this host (before first fill attempt).
            try {
                let host = '';
                try {
                    const tab = await chrome.tabs.get(opened.tabId);
                    host = new URL(tab.url || applyUrl || '').hostname.replace(/^www\./i, '');
                } catch (_) {
                    try { host = new URL(applyUrl || '').hostname.replace(/^www\./i, ''); } catch (_) { /* ignore */ }
                }
                if (host) {
                    let disabledMap = {};
                    try {
                        const prefs = await getBidderPrefs();
                        disabledMap = prefs?.disabledFillLessons && typeof prefs.disabledFillLessons === 'object'
                            ? prefs.disabledFillLessons
                            : {};
                    } catch (_) {
                        disabledMap = {};
                    }
                    const local = await fillLessonsForHost(host);
                    let remote = [];
                    try {
                        const pack = await listBidderFillLessons({ host });
                        remote = Array.isArray(pack?.lessons) ? pack.lessons : [];
                    } catch (_) { /* ignore */ }
                    const merged = [...local, ...remote].filter((les) => {
                        const key = `${host}|${les.fieldKey || les.field_key || 'form'}|${les.issueKey || les.issue_key || ''}`;
                        return !disabledMap[key];
                    });
                    if (merged.length) {
                        const lesson = matchFillLesson(merged, {}) || merged[0];
                        const fills = Array.isArray(lesson?.actions?.fills) ? lesson.actions.fills : [];
                        if (fills.length) {
                            await setQueueState({
                                coachStatus: `Lesson ready — ${lesson.fieldKey || lesson.field_key || 'form'} @ ${host}`,
                                coachAt: Date.now()
                            }).catch(() => {});
                            await logCourseEvent(item.id, 'fill_lesson_queued', {
                                host,
                                fieldKey: lesson.fieldKey || lesson.field_key,
                                fill_count: fills.length,
                                phase: 'before_fill'
                            }).catch(() => {});
                            prefs = {
                                ...prefs,
                                earlyFillLessons: fills,
                                earlyFillLessonMeta: {
                                    host,
                                    fieldKey: lesson.fieldKey || lesson.field_key,
                                    issueKey: lesson.issueKey || lesson.issue_key
                                }
                            };
                        }
                    }
                }
            } catch (lessonEarlyErr) {
                console.warn('[bidder] early lesson load failed', lessonEarlyErr?.message || lessonEarlyErr);
            }

            // Full fill — at most 2 attempts, and only retry tab/script disconnects.
            // Re-running the whole fill 4× was why one bid could exceed 10 minutes.
            let fillStats = null;
            let fillErr = null;
            let submitted = false;
            for (let attempt = 0; attempt < 2; attempt++) {
                if (Date.now() > bidDeadline) {
                    fillErr = new Error('bid_time_budget_exceeded');
                    await logCourseEvent(item.id, 'bid_budget_exceeded', {
                        attempt,
                        limitMs: bidLimitMs
                    });
                    break;
                }
                const midWall = await detectCaptchaOrLogin(opened.tabId);
                // Form already detected — ignore passive reCAPTCHA widgets; only block real walls.
                if (isBlockingCaptchaWall(midWall, { formReady: true })) {
                    await setAppRunState(item.id, 'paused_captcha', {
                        tabId: opened.tabId,
                        captcha: true,
                        eventType: 'run_paused_captcha'
                    }).catch(() => {});
                    const wait = await runCaptchaPassEngine({
                        tabId: opened.tabId,
                        applicationId: item.id,
                        prefs,
                        wall: midWall,
                        phase: 'before_fill',
                        companyLabel: item.company_name || 'Job'
                    });
                    if (!wait.cleared) {
                        fillErr = new Error(
                            wait.stopped
                                ? 'stopped'
                                : wait.timeout
                                    ? 'captcha_not_cleared'
                                    : 'captcha_needs_manual'
                        );
                        break;
                    }
                    await setAppRunState(item.id, 'filling', {
                        tabId: opened.tabId,
                        captcha: false,
                        eventType: 'run_filling'
                    }).catch(() => {});
                }
                try {
                    await ensureApplyFormVisible(opened.tabId);
                    await ensureScripts(opened.tabId);
                    fillStats = await runBidderFillOnTab(opened.tabId, item, {
                        ...prefs,
                        bidDeadline,
                        bidLimitMs
                    });
                    fillErr = null;
                    break;
                } catch (err) {
                    fillErr = err;
                    if (err.status === 401 || err.authExpired) {
                        await notify('Lumi', 'Session expired — pause and log in');
                        await setQueueState({ running: false, status: 'auth', error: 'login_required' });
                        throw err;
                    }
                    const connRace = isNoReceiverError(err);
                    await logCourseEvent(item.id, 'fill_retry', {
                        attempt,
                        error: err?.message,
                        willRetry: connRace && attempt === 0
                    });
                    // Only retry ephemeral extension disconnects — not AI/CV/logic failures.
                    if (!connRace || attempt >= 1) break;
                    await new Promise((r) => setTimeout(r, 1500));
                }
            }

            if (fillErr) {
                // bid_budget_exceeded already logged — avoid a second FAILED event.
                if (!/bid_time_budget|bid_budget/i.test(String(fillErr?.message || ''))) {
                    await logCourseEvent(item.id, 'fill_failed', { error: fillErr?.message });
                }
                await setAppRunState(item.id, 'failed', {
                    tabId: opened.tabId,
                    eventType: 'run_failed'
                }).catch(() => {});
                await notify('Bidder', /bid_time_budget|bid_budget/i.test(String(fillErr?.message || ''))
                    ? `Time limit (~${Math.round(bidLimitMs / 1000)}s) — next job`
                    : `Fill failed: ${fillErr.message}`);
                await playBidderSound(prefs.soundEnabled);
                if (
                    prefs.unattended
                    && /captcha/i.test(String(fillErr?.message || ''))
                ) {
                    try { await chrome.tabs.remove(opened.tabId); } catch (_) { /* ignore */ }
                    openTabs.delete(opened.tabId);
                }
                continue;
            }

            // Wait for React/Greenhouse to settle, then capture filled form (~2s).
            const settleSec = Math.max(2, Math.min(6, Number(prefs.screenshotSettleSec) || 2));
            await new Promise((r) => setTimeout(r, settleSec * 1000));
            await ensureApplyFormVisible(opened.tabId);
            await uploadScreenshot(item.id, 'after_fill', opened.tabId, { settleMs: 800, stayInApp: true });
            fillStats = normalizeFillStats(fillStats || {});
            await setAppRunState(item.id, 'verifying', {
                tabId: opened.tabId,
                requiredOk: fillStats.requiredOk,
                requiredTotal: fillStats.requiredTotal,
                missingRequired: fillStats.missingRequired,
                eventType: 'run_verifying'
            }).catch(() => {});
            const fillIncompleteEarly = isFillIncomplete(fillStats);
            await savePackage(item.id, fillStats?.answersList || [], {
                filled: fillStats?.filled,
                company: item.company_name,
                role: item.job_role,
                incomplete: !!fillIncompleteEarly,
                requiredOk: fillStats?.requiredOk,
                requiredTotal: fillStats?.requiredTotal
            });

            // Submit success path — proof screenshot defaults to site thank-you / success message.
            submitted = !!fillStats?.submitClicked;
            const fillIncomplete = fillIncompleteEarly;
            if (!submitted && prefs.autoSubmit) {
                await setAppRunState(item.id, 'submitting', {
                    tabId: opened.tabId,
                    eventType: 'run_submitting'
                }).catch(() => {});
                // Always try Submit when auto-submit is on. Greenhouse's enabled
                // "Submit application" button is the source of truth — our collector
                // often false-flags React EE selects as empty and used to skip the click.
                try {
                    const sub = await sendTabMessage(opened.tabId, {
                        type: 'BIDDER_ENGINE_SUBMIT',
                        force: !!fillIncomplete
                    });
                    if (sub?.clicked) {
                        submitted = true;
                        fillStats = {
                            ...(fillStats || {}),
                            submitClicked: true,
                            requiredComplete: true
                        };
                        await logCourseEvent(item.id, 'submit_clicked', {
                            ...(sub || {}),
                            via: fillIncomplete ? 'queue_force_site_ready' : 'queue_retry'
                        });
                    } else if (fillIncomplete) {
                        await logCourseEvent(item.id, 'fill_incomplete', {
                            filled: fillStats?.filled || 0,
                            requiredOk: fillStats?.requiredOk,
                            requiredTotal: fillStats?.requiredTotal,
                            missing: fillStats?.missingRequired || sub?.missing || [],
                            reason: sub?.reason || 'required_fields_incomplete',
                            siteReady: sub?.siteReady
                        });
                        await setAppRunState(item.id, 'incomplete', {
                            tabId: opened.tabId,
                            missingRequired: fillStats.missingRequired,
                            requiredOk: fillStats.requiredOk,
                            requiredTotal: fillStats.requiredTotal,
                            eventType: 'run_incomplete'
                        }).catch(() => {});
                        await notify(
                            'Bidder',
                            `Incomplete fill (${fillStats?.requiredOk ?? '?'}/${fillStats?.requiredTotal ?? '?'} required) — tab left open`
                        );
                        await playBidderSound(prefs.soundEnabled);
                    } else {
                        // Fallback: Mode-1 CLICK_SUBMIT (fill.js) if bidder engine missed the button.
                        const sub2 = await sendTabMessage(opened.tabId, { type: 'CLICK_SUBMIT' }).catch(() => null);
                        if (sub2?.clicked) {
                            submitted = true;
                            fillStats = { ...(fillStats || {}), submitClicked: true };
                            await logCourseEvent(item.id, 'submit_clicked', {
                                ...(sub2 || {}),
                                via: 'queue_click_submit'
                            });
                        } else {
                            await logCourseEvent(item.id, 'submit_no_click', {
                                filled: fillStats?.filled || 0,
                                reason: sub?.reason || sub2?.reason || 'no_submit_control'
                            });
                        }
                    }
                } catch (err) {
                    await logCourseEvent(item.id, 'submit_no_click', {
                        filled: fillStats?.filled || 0,
                        error: err?.message || String(err)
                    });
                }
            }
            if (submitted) {
                await setAppRunState(item.id, 'submitting', {
                    tabId: opened.tabId,
                    eventType: 'run_submitting'
                }).catch(() => {});
                let poll = await pollDetectSubmitSuccess(opened.tabId, {
                    totalMs: SUBMIT_SUCCESS_POLL_MS,
                    gapMs: 800
                });
                // Validation errors → one re-fill of missing labels + one resubmit.
                if (!poll.ok && poll.reason === 'validation_errors') {
                    await logCourseEvent(item.id, 'submit_validation', {
                        reason: poll.reason,
                        sample: String(poll.sample || '').slice(0, 160)
                    }).catch(() => {});
                    try {
                        await ensureScripts(opened.tabId);
                        const refills = await runBidderFillOnTab(opened.tabId, item, {
                            ...prefs,
                            bidDeadline: Date.now() + 45000,
                            autoSubmit: false,
                            answersOnly: false
                        }).catch(() => null);
                        const reStats = normalizeFillStats(refills || {});
                        if (canAutoSubmit(reStats, { autoSubmit: true })) {
                            const sub2 = await sendTabMessage(opened.tabId, { type: 'BIDDER_ENGINE_SUBMIT' }).catch(() => null);
                            if (sub2?.clicked) {
                                await logCourseEvent(item.id, 'submit_clicked', { via: 'validation_refill' });
                                poll = await pollDetectSubmitSuccess(opened.tabId, {
                                    totalMs: SUBMIT_SUCCESS_POLL_MS,
                                    gapMs: 800
                                });
                            }
                        }
                    } catch (reErr) {
                        console.warn('[bidder] validation refill failed', reErr?.message || reErr);
                    }
                }
                // Greenhouse: Submit #1 → email security code → fill → Submit #2 → thank-you.
                // Never treat OTP miss as "done" and never leftover-close this tab.
                if (!poll.ok) {
                    await new Promise((r) => setTimeout(r, 1200));
                    let otpUi = await detectEmailSecurityCodePage(opened.tabId).catch(() => null);
                    const wall = await detectCaptchaOrLogin(opened.tabId).catch(() => null);
                    const isEmailOtp = !!(
                        otpUi?.emailOtp
                        || wall?.emailOtp
                        || /email_otp/i.test(String(wall?.vendor || ''))
                    );
                    if (isEmailOtp) {
                        await logCourseEvent(item.id, 'email_otp_wait', {
                            phase: 'post_submit',
                            engine: 'greenhouse-double-submit',
                            shortBoxes: otpUi?.shortBoxes || 0
                        }).catch(() => {});
                        await setQueueState({
                            status: 'awaiting_email_otp',
                            captchaTabId: opened.tabId,
                            captchaApplicationId: item.id,
                            captchaKind: 'email_otp',
                            captchaSince: Date.now(),
                            coachStatus: 'Waiting for email security code…',
                            coachAt: Date.now()
                        }).catch(() => {});
                        try { await chrome.tabs.update(opened.tabId, { active: true }); } catch (_) { /* ignore */ }

                        const otpTimeout = Math.min(
                            Number(prefs.captchaGraceMs) > 0 ? Number(prefs.captchaGraceMs) : 180000,
                            5 * 60 * 1000
                        );
                        let otp = await tryFillOutlookEmailOtp(opened.tabId, {
                            timeoutMs: otpTimeout,
                            applicationId: item.id
                        }).catch((err) => ({ ok: false, error: err?.message || String(err) }));

                        // If Outlook/IMAP miss, hold tab open and wait for Instruct / manual paste.
                        if (!otp?.ok) {
                            await notify(
                                'Lumi — Security code',
                                'Paste the email code in Instruct Lumi (e.g. wFY53Ht3). Tab stays open for second Submit.'
                            );
                            await playBidderSound(prefs.soundEnabled);
                            const instructHoldMs = Math.min(
                                Math.max(otpTimeout, 3 * 60 * 1000),
                                12 * 60 * 1000
                            );
                            const holdStart = Date.now();
                            let secondSubmitTried = false;
                            let lastMailboxRetryAt = 0;
                            while (Date.now() - holdStart < instructHoldMs) {
                                const stHold = await getQueueState();
                                if (stHold?.stopRequested) break;
                                try { await chrome.tabs.get(opened.tabId); } catch {
                                    otp = { ok: false, error: 'tab_closed' };
                                    break;
                                }
                                const successEarly = await detectSubmitSuccess(opened.tabId).catch(() => false);
                                if (successEarly) {
                                    poll = { ok: true, reason: 'success_during_otp_hold', attempts: 0, elapsedMs: Date.now() - holdStart };
                                    otp = { ok: true, via: 'already_success' };
                                    break;
                                }
                                const filled = await emailOtpInputsFilled(opened.tabId).catch(() => null);
                                if (filled?.filled && !secondSubmitTried) {
                                    secondSubmitTried = true;
                                    otp = { ok: true, via: 'manual_or_instruct' };
                                    break;
                                }
                                // Periodic mailbox retry (Graph may connect mid-hold).
                                if (Date.now() - holdStart > 20000 && Date.now() - lastMailboxRetryAt > 45000) {
                                    lastMailboxRetryAt = Date.now();
                                    const retry = await tryFillOutlookEmailOtp(opened.tabId, {
                                        timeoutMs: 25000,
                                        applicationId: item.id
                                    }).catch(() => null);
                                    if (retry?.ok) {
                                        otp = retry;
                                        break;
                                    }
                                }
                                await setQueueState({
                                    coachStatus: 'Awaiting email security code — Instruct Lumi or paste in form',
                                    coachAt: Date.now()
                                }).catch(() => {});
                                await new Promise((r) => setTimeout(r, 2000));
                            }
                        }

                        await logCourseEvent(item.id, otp?.ok ? 'email_otp_filled' : 'email_otp_miss', {
                            phase: 'post_submit',
                            ok: !!otp?.ok,
                            via: otp?.via || null,
                            subject: otp?.subject || null,
                            error: otp?.error || null
                        }).catch(() => {});

                        if (otp?.ok && otp?.via !== 'already_success') {
                            await new Promise((r) => setTimeout(r, 700));
                            let otpSubmit = await sendTabMessage(opened.tabId, {
                                type: 'BIDDER_ENGINE_SUBMIT',
                                force: true
                            }).catch(() => null);
                            if (!otpSubmit?.clicked) {
                                otpSubmit = await sendTabMessage(opened.tabId, { type: 'CLICK_SUBMIT' }).catch(() => null);
                            }
                            if (!otpSubmit?.clicked) {
                                otpSubmit = await clickPostOtpSubmit(opened.tabId).catch(() => null);
                            }
                            await logCourseEvent(item.id, 'submit_clicked', {
                                via: 'post_submit_email_otp',
                                clicked: !!otpSubmit?.clicked,
                                label: otpSubmit?.label || null
                            }).catch(() => {});
                            poll = await pollDetectSubmitSuccess(opened.tabId, {
                                totalMs: Math.max(SUBMIT_SUCCESS_POLL_MS, 25000),
                                gapMs: 800
                            });
                        }

                        // Still on OTP page → park tab; do not leftover-close.
                        if (!poll.ok) {
                            holdEmailOtpTabs.set(opened.tabId, item);
                            openTabs.delete(opened.tabId);
                            await setQueueState({
                                status: 'awaiting_email_otp',
                                captchaTabId: opened.tabId,
                                captchaApplicationId: item.id,
                                captchaKind: 'email_otp',
                                coachStatus: 'Security code tab kept open — Instruct then second Submit',
                                coachAt: Date.now()
                            }).catch(() => {});
                            await logCourseEvent(item.id, 'needs_manual', {
                                reason: 'awaiting_email_otp',
                                tabKept: true
                            }).catch(() => {});
                            await setAppRunState(item.id, 'incomplete', {
                                tabId: opened.tabId,
                                eventType: 'run_awaiting_email_otp'
                            }).catch(() => {});
                            await uploadSuccessProofScreenshot(item.id, opened.tabId, {
                                stayInApp: true,
                                waitMs: 800
                            }).catch(() =>
                                uploadScreenshot(item.id, 'live', opened.tabId, { stayInApp: true })
                            );
                            await refocusStayInAppHome();
                            // Skip the generic needs_manual close path below.
                            if (!prefs.autoNext) {
                                await setQueueState({
                                    running: true,
                                    status: 'awaiting_email_otp',
                                    lastTabId: opened.tabId,
                                    lastApplicationId: item.id,
                                    captchaTabId: opened.tabId,
                                    captchaApplicationId: item.id,
                                    captchaKind: 'email_otp'
                                });
                                await notify('Lumi', 'Enter security code via Instruct, then Next when ready');
                                await waitForBidderNext();
                            }
                            continue;
                        }

                        await setQueueState({
                            status: 'running',
                            captchaKind: null,
                            captchaTabId: null,
                            captchaApplicationId: null,
                            coachStatus: null
                        }).catch(() => {});
                    }
                }
                const ok = !!poll.ok;
                if (ok || prefs.autoSubmit) {
                    if (ok) {
                        await markApplicationApplied(item.id);
                        await logCourseEvent(item.id, 'marked_applied', {
                            via: 'success_text',
                            pollAttempts: poll.attempts,
                            pollMs: poll.elapsedMs
                        });
                        await setAppRunState(item.id, 'success', {
                            tabId: opened.tabId,
                            eventType: 'run_success'
                        }).catch(() => {});
                        await watchLearnAfterSuccess(opened.tabId, item.id, {
                            source: 'auto_watch'
                        }).catch(() => {});
                        await uploadSuccessProofScreenshot(item.id, opened.tabId, {
                            stayInApp: true,
                            waitMs: 1600
                        });
                        await closeBidderTab(opened.tabId);
                        openTabs.delete(opened.tabId);
                        holdEmailOtpTabs.delete(opened.tabId);
                        processed += 1;
                        submitted = true;
                        await refocusStayInAppHome();
                    } else {
                        await logCourseEvent(item.id, 'needs_manual', {
                            reason: poll.reason || 'submit_no_thanks',
                            pollAttempts: poll.attempts
                        });
                        await setAppRunState(item.id, 'incomplete', {
                            tabId: opened.tabId,
                            eventType: 'run_needs_manual'
                        }).catch(() => {});
                        // If OTP UI appeared late, still hold the tab.
                        const lateOtp = await detectEmailSecurityCodePage(opened.tabId).catch(() => null);
                        if (lateOtp?.emailOtp) {
                            holdEmailOtpTabs.set(opened.tabId, item);
                            openTabs.delete(opened.tabId);
                            await setQueueState({
                                status: 'awaiting_email_otp',
                                captchaTabId: opened.tabId,
                                captchaApplicationId: item.id,
                                captchaKind: 'email_otp'
                            }).catch(() => {});
                            await notify('Lumi — Security code', 'Tab kept open for email code + second Submit');
                        } else {
                            await notify('Bidder', 'Submit clicked — confirm success (Submitted OK) if needed');
                        }
                        await playBidderSound(prefs.soundEnabled);
                        await uploadSuccessProofScreenshot(item.id, opened.tabId, {
                            stayInApp: true,
                            waitMs: 1000
                        }).catch(() =>
                            uploadScreenshot(item.id, 'live', opened.tabId, { stayInApp: true })
                        );
                        await refocusStayInAppHome();
                    }
                }
            } else if (fillIncomplete) {
                await ensureApplyFormVisible(opened.tabId);
                await uploadScreenshot(item.id, 'after_fill_done', opened.tabId, { stayInApp: true });
                await setQueueState({
                    coachStatus: 'Watching… stuck after fill — use Instruct Lumi',
                    coachAt: Date.now()
                }).catch(() => {});
                await setAppRunState(item.id, 'incomplete', {
                    tabId: opened.tabId,
                    missingRequired: fillStats.missingRequired,
                    eventType: 'run_incomplete'
                }).catch(() => {});
                // Keep apply tab open for manual finish — do not close.
                await refocusStayInAppHome();
            } else if (!prefs.autoSubmit) {
                await logCourseEvent(item.id, 'awaiting_manual_submit', {
                    filled: fillStats?.filled || 0
                });
                // Fill finished — close background tab; user stays on Job Links + Live monitor history.
                await ensureApplyFormVisible(opened.tabId);
                await uploadScreenshot(item.id, 'after_fill_done', opened.tabId, { stayInApp: true });
                await closeBidderTab(opened.tabId);
                openTabs.delete(opened.tabId);
                await refocusStayInAppHome();
                await notify(
                    'Bidder',
                    `Fill done (${fillStats?.filled || 0} fields) — tab closed. Review Live monitor / Bid course.`
                );
            } else {
                // autoSubmit on but could not click Submit — still FILLED for monitor.
                await ensureApplyFormVisible(opened.tabId);
                await uploadScreenshot(item.id, 'after_fill_done', opened.tabId, { stayInApp: true });
                await closeBidderTab(opened.tabId);
                openTabs.delete(opened.tabId);
                await refocusStayInAppHome();
            }

            // Pause for Next unless autoNext
            if (!prefs.autoNext) {
                await setQueueState({
                    running: true,
                    status: 'awaiting_next',
                    lastTabId: null,
                    lastApplicationId: item.id
                });
                await notify('Bidder', 'Click Next in Auto Bidder / Live monitor to continue');
                await waitForBidderNext();
            }

            // Count fill-only jobs once (submit success already counted above)
            if (!fillStats?.submitClicked) processed += 1;
            } catch (itemErr) {
                if (itemErr?.status === 401 || itemErr?.authExpired) throw itemErr;
                const msg = String(itemErr?.message || itemErr || '');
                if (opened?.tabId) openTabs.delete(opened.tabId);
                await logCourseEvent(item.id, 'item_aborted', { error: msg }).catch(() => {});
                if (/Tab closed|bid_time_budget/i.test(msg)) {
                    console.warn('[bidder] item skipped (tab/budget)', msg);
                } else {
                    console.warn('[bidder] item failed', itemErr);
                    await notify('Bidder', `Skip: ${msg}`).catch(() => {});
                }
            }
        }

        // Close leftover apply tabs — but NEVER close Greenhouse email-OTP tabs
        // (Submit #1 done; waiting for code + Submit #2).
        for (const tid of [...openTabs.keys()]) {
            if (holdEmailOtpTabs.has(tid)) {
                openTabs.delete(tid);
                continue;
            }
            const lateOtp = await detectEmailSecurityCodePage(tid).catch(() => null);
            if (lateOtp?.emailOtp) {
                const meta = openTabs.get(tid);
                if (meta) holdEmailOtpTabs.set(tid, meta);
                openTabs.delete(tid);
                continue;
            }
            await closeBidderTab(tid);
            openTabs.delete(tid);
        }
        await refocusStayInAppHome();

        const otpHoldCount = holdEmailOtpTabs.size;
        const firstOtpTab = otpHoldCount ? [...holdEmailOtpTabs.keys()][0] : null;
        const firstOtpItem = firstOtpTab ? holdEmailOtpTabs.get(firstOtpTab) : null;

        await setQueueState({
            running: otpHoldCount > 0,
            status: otpHoldCount > 0 ? 'awaiting_email_otp' : 'done',
            processed,
            skippedAts,
            queueEndedAt: Date.now(),
            captchaTabId: firstOtpTab || null,
            captchaApplicationId: firstOtpItem?.id || null,
            captchaKind: otpHoldCount > 0 ? 'email_otp' : null,
            coachStatus: otpHoldCount > 0
                ? 'Security code tab(s) kept open — Instruct Lumi with the code, then Submit'
                : null,
            coachAt: Date.now()
        });
        if (otpHoldCount > 0) {
            await notify(
                'Lumi — Security code',
                `${otpHoldCount} Greenhouse tab(s) waiting for email code. Instruct Lumi with the code (second Submit).`
            );
        }
        const doneMsg = otpHoldCount > 0
            ? `Queue paused — ${otpHoldCount} tab(s) need email security code (Instruct Lumi)`
            : (skippedAts
                ? `Queue finished — processed ${processed}, skipped ${skippedAts} unsupported`
                : `Queue finished — processed ${processed}`);
        await notify('Bidder', doneMsg);
        return { ok: true, processed, queued: items.length, skippedAts, awaitingEmailOtp: otpHoldCount };
    } catch (err) {
        console.warn('[bidder] processReadyQueue failed', err);
        await setQueueState({
            running: false,
            status: 'error',
            error: err?.message || String(err)
        }).catch(() => {});
        throw err;
    } finally {
        clearInterval(keepAlive);
        await releaseAllPageDebuggers().catch(() => {});
        await releaseQueueLock();
    }
}

async function waitForBidderNext(timeoutMs = 60 * 60 * 1000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const st = await getQueueState();
        if (st?.nextClicked) {
            await setQueueState({ nextClicked: false, status: 'running' });
            return;
        }
        if (st?.stopRequested) return;
        await new Promise((r) => setTimeout(r, 400));
    }
}

async function playBidderSound(enabled) {
    if (!enabled) return;
    try {
        await chrome.notifications.create(`bidder-sound-${Date.now()}`, {
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'Lumi Bidder',
            message: 'Needs your attention',
            priority: 2,
            silent: false
        });
    } catch (_) { /* ignore */ }
}

/**
 * CAPTCHA / login pass engineer.
 * - Built-in CapSolver / 2Captcha API (when key set): extract sitekey → buy token → inject
 * - Else: wait for Chrome helper extensions (NopeCHA/Buster) or human Resume
 * - Attended / unattended wait windows as before
 */
async function runCaptchaPassEngine({
    tabId,
    applicationId,
    prefs,
    wall,
    phase = 'open',
    companyLabel = 'Job'
} = {}) {
    const kind = wall?.captcha ? 'needs_captcha' : 'login_wall';
    const stayInApp = prefs?.stayInApp !== false;
    const unattended = prefs?.unattended === true;
    const solverProvider = resolveSolverProvider(prefs || {});
    // Free path: NopeCHA/Buster — always wait for helpers when no paid API key
    const captchaHelper = prefs?.captchaHelper === true || !solverProvider;
    const vendor = wall?.vendor || (wall?.login ? 'login' : 'generic');

    try {
        const helpers = await probeCaptchaHelpers();
        if (applicationId && helpers.probed) {
            await logCourseEvent(applicationId, helpers.helper_missing
                ? 'captcha_helper_missing'
                : 'captcha_helper_present', {
                phase,
                vendor,
                nopecha: !!helpers.nopecha,
                buster: !!helpers.buster
            }).catch(() => {});
        }
    } catch (_) { /* ignore */ }

    const strategy = captchaStrategyForVendor(vendor, {
        login: !!wall?.login,
        captchaHelper: captchaHelper || !!solverProvider
    });
    const baseGrace = Math.max(0, Number(prefs?.captchaGraceMs ?? BIDDER_DEFAULTS.captchaGraceMs) || 0);
    const helperWait = Math.max(
        0,
        Number(prefs?.captchaHelperWaitMs ?? BIDDER_DEFAULTS.captchaHelperWaitMs) || 0
    );
    // Vendor-aware wait:
    // - Built-in solver or helper ON: long window
    // - Helper OFF + AFK: short grace then skip
    // - Attended without helper: up to captchaTimeoutMs for human
    // Attended + helper: wait for helpers (~helperWait), not a full hour hold that
    // starves fill when Greenhouse still shows a passive reCAPTCHA badge.
    // Human Resume still works anytime; real walls without form keep polling.
    let graceMs;
    if (!unattended) {
        graceMs = (captchaHelper || solverProvider)
            ? Math.max(helperWait, 120 * 1000)
            : BIDDER_DEFAULTS.captchaTimeoutMs;
    } else if ((captchaHelper || solverProvider) && wall?.captcha) {
        // Free helpers: use helperWait (default 90s), not a forced 5-minute stall
        graceMs = Math.max(baseGrace, helperWait, strategy.unattendedWaitMs || 0);
    } else if (strategy.helperUseful) {
        graceMs = Math.max(baseGrace, strategy.unattendedWaitMs || baseGrace);
    } else {
        graceMs = Math.min(baseGrace, strategy.unattendedWaitMs || 25000);
    }
    const helperUseful = (!!captchaHelper || !!solverProvider) && !!wall?.captcha;
    // AFK CAPTCHA pass: keep apply tab focused the entire wait (helpers / inject need it).
    const holdApplyForHelpers = helperUseful;
    const shouldWait = unattended ? graceMs > 0 : true;
    // Re-nudge NopeCHA/Buster more often on free path (no paid solver)
    const HELPER_REASSIST_MS = solverProvider ? 15000 : 8000;

    await logCourseEvent(applicationId, kind, {
        ...wall,
        phase,
        stayInApp,
        unattended,
        captchaHelper,
        freeHelpersOnly: !solverProvider,
        solverProvider: solverProvider || null,
        vendor,
        strategy: strategy.id,
        strategyLabel: strategy.label,
        helperUseful,
        holdApplyForHelpers,
        graceMs: unattended || captchaHelper || solverProvider ? graceMs : undefined,
        engine: 'captcha-pass-v9'
    });

    await uploadScreenshot(applicationId, wall?.captcha ? 'captcha' : 'login_wall', tabId, {
        settleMs: 400,
        stayInApp
    }).catch(() => {});

    // Built-in API solver first (CapSolver / 2Captcha) — multi-strategy, up to 2 rounds.
    if (wall?.captcha && solverProvider && !wall?.login) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) { /* ignore */ }
        await logCourseEvent(applicationId, 'captcha_solver_start', {
            phase,
            provider: solverProvider,
            vendor,
            engine: 'captcha-pass-v9'
        }).catch(() => {});

        let solved = null;
        for (let round = 0; round < 2; round += 1) {
            if (round > 0) {
                await new Promise((r) => setTimeout(r, 3000));
                await logCourseEvent(applicationId, 'captcha_solver_retry', {
                    phase,
                    round,
                    engine: 'captcha-pass-v9'
                }).catch(() => {});
            }
            solved = await solveCaptchaOnTab(tabId, {
                ...prefs,
                captchaSolverTimeoutMs: Math.max(
                    Number(prefs?.captchaSolverTimeoutMs) || 0,
                    240000
                )
            }, wall).catch((err) => ({
                ok: false,
                error: err?.message || String(err)
            }));
            if (solved?.ok) break;
            // Only retry when sitekey missing / soft miss — hard vendor skip
            if (solved?.skipped || /vendor_not_solvable|no_solver/i.test(String(solved?.error || ''))) {
                break;
            }
        }

        await logCourseEvent(applicationId, solved?.ok ? 'captcha_solver_ok' : 'captcha_solver_miss', {
            phase,
            provider: solved?.provider || solverProvider,
            vendor: solved?.vendor || vendor,
            error: solved?.error || null,
            sitekey: solved?.sitekey || null,
            taskType: solved?.taskType || null,
            attemptCount: Array.isArray(solved?.attempts) ? solved.attempts.length : null,
            engine: 'captcha-pass-v9'
        }).catch(() => {});
        if (solved?.ok) {
            await new Promise((r) => setTimeout(r, 2000));
            const after = await detectCaptchaOrLogin(tabId).catch(() => null);
            if (after && (!after.captcha || after.widgetSolved) && !after.login) {
                await logCourseEvent(applicationId, 'captcha_cleared', {
                    via: `api_${solved.provider}`,
                    phase,
                    engine: 'captcha-pass-v9'
                });
                await setQueueState({
                    status: 'running',
                    captchaKind: null,
                    captchaTabId: null,
                    captchaApplicationId: null,
                    captchaUnattended: null
                });
                return { cleared: true, via: `api_${solved.provider}`, kind };
            }
            // Token injected but detector still sees wall — treat as cleared for solvable widgets
            if (solved.injected) {
                await logCourseEvent(applicationId, 'captcha_cleared', {
                    via: `api_${solved.provider}_injected`,
                    phase,
                    engine: 'captcha-pass-v9'
                });
                await setQueueState({
                    status: 'running',
                    captchaKind: null,
                    captchaTabId: null,
                    captchaApplicationId: null,
                    captchaUnattended: null
                });
                return { cleared: true, via: `api_${solved.provider}_injected`, kind };
            }
        }
    }

    // Free helpers: focus pulse + re-assist so NopeCHA / Buster can engage.
    let assist = null;
    if (wall?.captcha && helperUseful && !wall?.login) {
        assist = await assistCaptchaHelpersWithRetry(tabId, vendor, {
            attempts: 3,
            gapMs: 1100,
            focusPulse: true
        }).catch(() => null);
        if (assist?.solved || assist?.clicked) {
            await logCourseEvent(applicationId, 'captcha_assist_helpers', {
                phase,
                tried: assist.tried || [],
                vendor,
                solved: !!assist.solved,
                signals: assist.signals || [],
                attempts: assist.attempts,
                freeHelpersOnly: !solverProvider,
                engine: 'captcha-pass-v10'
            });
            await new Promise((r) => setTimeout(r, 1200));
            const tokenHit = assist.solved
                ? { solved: true }
                : await detectCaptchaSolved(tabId).catch(() => ({ solved: false }));
            const early = await detectCaptchaOrLogin(tabId).catch(() => null);
            if (
                tokenHit?.solved
                || (early && (!early.captcha || early.widgetSolved) && !early.login)
            ) {
                await logCourseEvent(applicationId, 'captcha_cleared', {
                    via: tokenHit?.solved ? 'helper_token' : 'helper_assist',
                    phase,
                    engine: 'captcha-pass-v10'
                });
                await setQueueState({
                    status: 'running',
                    captchaKind: null,
                    captchaTabId: null,
                    captchaApplicationId: null,
                    captchaUnattended: null
                });
                return { cleared: true, via: tokenHit?.solved ? 'helper_token' : 'helper_assist', kind };
            }
        }
    }

    // Email security code / Outlook OTP — existing path kept; further work deferred.
    if (wall?.emailOtp || /email_otp/i.test(String(vendor))) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) { /* ignore */ }
        await logCourseEvent(applicationId, 'email_otp_wait', {
            phase,
            engine: 'captcha-pass-v9'
        }).catch(() => {});
        const otpWait = Math.min(graceMs || helperWait || 180000, 5 * 60 * 1000);
        const otp = await tryFillOutlookEmailOtp(tabId, {
            timeoutMs: otpWait,
            applicationId
        }).catch((err) => ({ ok: false, error: err?.message || String(err) }));
        await logCourseEvent(applicationId, otp?.ok ? 'email_otp_filled' : 'email_otp_miss', {
            phase,
            ok: !!otp?.ok,
            subject: otp?.subject || null,
            error: otp?.error || null,
            engine: 'captcha-pass-v9'
        }).catch(() => {});
        if (otp?.ok) {
            await new Promise((r) => setTimeout(r, 1500));
            let otpSubmit = await sendTabMessage(tabId, {
                type: 'BIDDER_ENGINE_SUBMIT',
                force: true
            }).catch(() => null);
            if (!otpSubmit?.clicked) {
                otpSubmit = await clickPostOtpSubmit(tabId).catch(() => null);
            }
            await logCourseEvent(applicationId, 'submit_clicked', {
                via: 'captcha_pass_email_otp',
                clicked: !!otpSubmit?.clicked
            }).catch(() => {});
            await new Promise((r) => setTimeout(r, 1500));
            const afterOtp = await detectCaptchaOrLogin(tabId).catch(() => null);
            const success = await detectSubmitSuccess(tabId).catch(() => false);
            if (
                success
                || (afterOtp && !afterOtp.captcha && !afterOtp.login && !afterOtp.emailOtp)
            ) {
                await setQueueState({
                    status: 'running',
                    captchaKind: null,
                    captchaTabId: null,
                    captchaApplicationId: null,
                    captchaUnattended: null
                });
                return { cleared: true, via: 'outlook_email_otp', kind };
            }
        }
    }

    if (holdApplyForHelpers) {
        // AFK/attended helper pass: pin apply tab — do NOT soft-refocus Job Links (starves solvers).
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) { /* ignore */ }
        try {
            await chrome.storage.session.set({
                captchaUserFocusHoldUntil: Date.now() + Math.max(graceMs, 60_000) + 30_000
            });
        } catch (_) { /* ignore */ }
        await logCourseEvent(applicationId, 'captcha_helper_focus_pulse', {
            phase,
            focus: 'apply_hold',
            afk: unattended,
            engine: 'captcha-pass-v9'
        }).catch(() => {});
    } else if (!stayInApp && !unattended) {
        try { await chrome.tabs.update(tabId, { active: true }); } catch (_) { /* ignore */ }
    } else if (!unattended) {
        await refocusStayInAppHome();
    }

    const graceSec = Math.round(graceMs / 1000);
    const vendorName = vendorLabel(vendor);
    await notify(
        wall?.captcha ? `Bidder — ${vendorName}` : 'Bidder — Login required',
        unattended
            ? (solverProvider
                ? `${companyLabel}: solving CAPTCHA via ${solverProvider} (built-in API)…`
                : (helperUseful
                    ? `${companyLabel}: AFK CAPTCHA — tab held ~${graceSec}s for NopeCHA/Buster.`
                    : `${companyLabel}: ${strategy.label}. Skipping in ~${graceSec}s (AFK, no helper).`))
            : (helperUseful || solverProvider
                ? `${companyLabel}: ${strategy.label}. Apply tab held for ${solverProvider || 'NopeCHA/Buster'} (~${graceSec}s); Resume if needed.`
                : (stayInApp
                    ? `${companyLabel}: ${strategy.label}. Solve in background tab, then Resume.`
                    : `${companyLabel}: ${strategy.label}. Solve in this tab, then Resume.`))
    );
    await playBidderSound(prefs?.soundEnabled);

    let captchaJobUrl = null;
    try {
        const st0 = await getQueueState();
        captchaJobUrl = st0?.currentJobUrl || st0?.captchaJobUrl || null;
        if (!captchaJobUrl || /[?&]error=true\b/i.test(captchaJobUrl) || /\/embed\/job_board/i.test(captchaJobUrl)) {
            const t = await chrome.tabs.get(tabId);
            const tabUrl = t?.pendingUrl || t?.url || null;
            if (tabUrl && !/[?&]error=true\b/i.test(tabUrl) && !/\/embed\/job_board/i.test(tabUrl)) {
                captchaJobUrl = tabUrl;
            }
        }
    } catch (_) { /* ignore */ }

    await setQueueState({
        status: 'awaiting_captcha',
        captchaTabId: tabId,
        captchaApplicationId: applicationId,
        captchaKind: wall?.captcha ? 'captcha' : 'login',
        captchaSince: Date.now(),
        captchaStayInApp: stayInApp,
        captchaUnattended: unattended,
        captchaHelper,
        captchaHoldApply: holdApplyForHelpers,
        captchaJobUrl,
        captchaTabMissing: false,
        captchaAbandonRequested: false
    });

    const abandonUnattended = async (extra = {}) => {
        await logCourseEvent(applicationId, 'captcha_abandoned', {
            ...extra,
            phase,
            unattended: true,
            captchaHelper,
            graceMs,
            assist,
            engine: 'captcha-pass-v9'
        });
        // Keep browser tab open when helper was on so CapSolver/NopeCHA / Open tab can still finish.
        if (!captchaHelper) {
            try { await chrome.tabs.remove(tabId); } catch (_) { /* ignore */ }
        }
        try { await chrome.storage.session.remove('captchaUserFocusHoldUntil'); } catch (_) { /* ignore */ }
        await setQueueState({
            status: 'running',
            captchaKind: null,
            captchaTabId: null,
            captchaApplicationId: null,
            captchaUnattended: null,
            captchaHelper: null,
            captchaHoldApply: null,
            captchaJobUrl: null,
            captchaTabMissing: false,
            captchaAbandonRequested: false
        });
        await notify(
            'Bidder — CAPTCHA parked',
            captchaHelper
                ? `${companyLabel}: helper did not clear in time — apply tab left open; queue continues.`
                : `${companyLabel}: marked for later. Queue keeps applying other jobs.`
        );
        return {
            cleared: false,
            abandoned: true,
            unattended: true,
            captchaHelper,
            tabKept: !!captchaHelper,
            skippedWait: !!extra.skippedWait,
            timeout: !!extra.timeout,
            via: extra.via || null,
            kind
        };
    };

    if (!shouldWait) {
        if (unattended) return abandonUnattended({ skippedWait: true });
        return { cleared: false, skippedWait: true, kind };
    }

    // Live frames on status change only (≤0.5s) — no CAPTCHA interval spam.

    let lastAssist = Date.now();
    const pollMs = unattended ? 1000 : BIDDER_DEFAULTS.captchaPollMs;
    const start = Date.now();
    while (Date.now() - start < graceMs) {
            const stFocus = await getQueueState();
            const tid = stFocus?.captchaTabId || tabId;

            if (holdApplyForHelpers && tid) {
                // Pin apply tab every cycle — NopeCHA/Buster need focus for AFK pass.
                try { await chrome.tabs.update(tid, { active: true }); } catch (_) { /* ignore */ }
                if (Date.now() - lastAssist > HELPER_REASSIST_MS) {
                    const again = await assistCaptchaHelpers(tid, vendor).catch(() => null);
                    if (again?.clicked) {
                        await logCourseEvent(applicationId, 'captcha_assist_helpers', {
                            phase,
                            tried: again.tried || [],
                            vendor,
                            engine: 'captcha-pass-v9'
                        }).catch(() => {});
                    }
                    lastAssist = Date.now();
                }
            } else if (captchaHelper && Date.now() - lastAssist > HELPER_REASSIST_MS) {
                if (tid) await assistCaptchaHelpers(tid, vendor).catch(() => null);
                lastAssist = Date.now();
            }

            const slice = Math.min(pollMs * 8, Math.max(0, graceMs - (Date.now() - start)));
            const wait = await waitForCaptchaOrLoginCleared(tabId, {
                applicationId,
                timeoutMs: Math.max(pollMs, slice),
                pollMs
            });
            if (wait.cleared) {
                await logCourseEvent(applicationId, 'captcha_cleared', {
                    ...wait,
                    phase,
                    unattended,
                    captchaHelper,
                    engine: 'captcha-pass-v9'
                });
                const st = await getQueueState();
                const clearedTid = st?.captchaTabId || tabId;
                await uploadScreenshot(applicationId, 'captcha_cleared', clearedTid, {
                    settleMs: 600,
                    stayInApp
                }).catch(() => {});
                await notify('Bidder', captchaHelper
                    ? 'Challenge cleared (NopeCHA/Buster) — continuing AFK fill'
                    : 'Challenge cleared — continuing fill');
                try { await chrome.storage.session.remove('captchaUserFocusHoldUntil'); } catch (_) { /* ignore */ }
                await setQueueState({
                    status: 'running',
                    captchaKind: null,
                    captchaTabId: null,
                    captchaApplicationId: null,
                    captchaUnattended: null,
                    captchaHelper: null,
                    captchaHoldApply: null,
                    captchaJobUrl: null,
                    captchaTabMissing: false
                });
                if (stayInApp) await refocusStayInAppHome().catch(() => {});
                return { ...wait, kind };
            }
            if (wait.abandoned || wait.via === 'user_skip') {
                return abandonUnattended({ ...wait, via: wait.via || 'user_skip' });
            }
            if (wait.stopped) {
                return { ...wait, kind };
            }
            if (wait.tabClosed) {
                if (unattended) return abandonUnattended(wait);
                return { ...wait, kind };
            }
        }
        if (unattended) {
            return abandonUnattended({ timeout: true });
        }
        return { cleared: false, timeout: true, kind };
}

const APPLY_LESSONS_KEY = 'bidderApplyLessons';
const ATS_CREDS_KEY = 'bidderAtsCredentials';

async function loadApplyLessons() {
    try {
        return (await chrome.storage.local.get([APPLY_LESSONS_KEY]))[APPLY_LESSONS_KEY] || [];
    } catch {
        return [];
    }
}

async function saveApplyLesson(lesson) {
    try {
        const cur = await loadApplyLessons();
        const next = upsertApplyLesson(cur, lesson);
        await chrome.storage.local.set({ [APPLY_LESSONS_KEY]: next });
        return next;
    } catch {
        return [];
    }
}

/** After SUCCESS, remember location free-text / instruct patterns for this host. */
async function watchLearnAfterSuccess(tabId, applicationId, meta = {}) {
    try {
        let host = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            host = new URL(tab.url || '').hostname.replace(/^www\./i, '');
        } catch (_) { /* ignore */ }
        if (!host) return;
        let city = meta.city || meta.location || '';
        if (!city && applicationId) {
            try {
                const packed = await getBidderApplication(applicationId);
                const p = packed?.profile || {};
                city = [p.city, p.state, p.postal_code].filter(Boolean).join(', ');
            } catch (_) { /* ignore */ }
        }
        const lesson = {
            host,
            fieldKey: meta.fieldKey || 'location',
            issueKey: meta.issueKey || 'location|no_dropdown_match',
            instruction: meta.instruction || 'Type city, state and zip into Location',
            actions: meta.actions || {
                fills: city
                    ? [{ label: 'Location (city)', answer: city }]
                    : [],
                clickSubmit: true
            },
            ats: meta.ats || '',
            source: meta.source || 'auto_watch'
        };
        const existing = await fillLessonsForHost(host);
        if (!lesson.actions.fills?.length && existing[0]?.actions) {
            lesson.actions = existing[0].actions;
            lesson.fieldKey = existing[0].fieldKey || lesson.fieldKey;
            lesson.issueKey = existing[0].issueKey || lesson.issueKey;
        }
        if (!lesson.actions.fills?.length && !existing.length) return;
        await saveFillLesson(lesson);
        await saveBidderFillLesson({
            host: lesson.host,
            field_key: lesson.fieldKey,
            issue_key: lesson.issueKey,
            instruction: lesson.instruction,
            actions: lesson.actions,
            ats: lesson.ats,
            source: lesson.source
        }).catch(() => {});
        // Studying Engine: learn Policy answers from successful fill lessons
        try {
            const fills = Array.isArray(lesson.actions?.fills) ? lesson.actions.fills : [];
            for (const fill of fills) {
                const label = String(fill.label || fill.fieldLabel || '').trim();
                const answer = String(fill.answer || fill.value || '').trim();
                if (!label || !answer || answer.length > 160) continue;
                const kindGuess = (() => {
                    const h = label.toLowerCase();
                    if (/disabilit|ada\b/.test(h) && !/insurance/.test(h)) return 'disability_status';
                    if (/sponsor|visa/.test(h)) return 'requires_sponsorship';
                    if (/previous|former|worked for|employed/.test(h)) return 'previous_employer_no';
                    if (/background\s*check/.test(h)) return 'background_check_yes';
                    if (/non[\s-]*compete/.test(h)) return 'non_compete_no';
                    if (/salary|compensation/.test(h) && /comfortable|outlined|accept/.test(h)) {
                        return 'salary_comfort_yes';
                    }
                    return '';
                })();
                if (!kindGuess) continue;
                await upsertQuestionMemory({
                    kind: kindGuess,
                    question: label,
                    answer,
                    source: 'success',
                    knockout: ['disability_status', 'requires_sponsorship', 'previous_employer_no',
                        'background_check_yes', 'non_compete_no'].includes(kindGuess)
                }).catch(() => {});
            }
        } catch (_) { /* ignore */ }
        await setQueueState({
            coachStatus: `Learned — ${lesson.fieldKey} @ ${host}`,
            coachAt: Date.now()
        }).catch(() => {});
        await notify('Lumi', `Learned — ${lesson.fieldKey} @ ${host}`);
        if (applicationId) {
            await logCourseEvent(applicationId, 'fill_lesson_applied', {
                via: 'auto_watch',
                host,
                fieldKey: lesson.fieldKey
            }).catch(() => {});
        }
    } catch (err) {
        console.warn('[bidder] watch learn failed', err?.message || err);
    }
}

async function getOrCreateAtsPassword(host) {
    const h = String(host || '').replace(/^www\./i, '').toLowerCase();
    if (!h) return generateAtsPassword('lumi');
    try {
        const data = (await chrome.storage.local.get([ATS_CREDS_KEY]))[ATS_CREDS_KEY] || {};
        if (data[h]?.password) return data[h].password;
        const password = generateAtsPassword(h);
        data[h] = {
            password,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await chrome.storage.local.set({ [ATS_CREDS_KEY]: data });
        return password;
    } catch {
        return generateAtsPassword(h);
    }
}

async function followApplyOpenedTab(openerTabId, beforeTabIds, waitMs = 5000) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        try {
            const tabs = await chrome.tabs.query({});
            const child = (tabs || []).find((t) => t?.openerTabId === openerTabId && t.id);
            if (child?.id) return child.id;
            const fresh = (tabs || []).find((t) => {
                if (!t?.id || beforeTabIds.has(t.id)) return false;
                const u = String(t.pendingUrl || t.url || '');
                return /\/apply|application|greenhouse|lever|ashby|workday|smartrecruiters|icims/i.test(u);
            });
            if (fresh?.id) return fresh.id;
        } catch (_) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 400));
    }
    return null;
}

/**
 * Try to create an ATS account when Apply lands on sign-up.
 * Uses profile email + generated/saved password for this host.
 */
async function tryCreateAtsAccount(tabId, profileEmail) {
    const email = String(profileEmail || '').trim();
    if (!email || !tabId) return { ok: false, reason: 'no_email' };
    try {
        let host = '';
        try {
            const tab = await chrome.tabs.get(tabId);
            host = new URL(tab.url || '').hostname.replace(/^www\./i, '');
        } catch (_) { /* ignore */ }
        const password = await getOrCreateAtsPassword(host);
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (emailAddr, pass) => {
                const text = (document.body?.innerText || '').slice(0, 8000).toLowerCase();
                const looksCreate = /\b(create\s+(an?\s+)?account|sign\s*up|register|set\s+a\s+password|confirm\s+password)\b/.test(text);
                const passInputs = [...document.querySelectorAll('input[type="password"]')].filter((el) => {
                    const r = el.getBoundingClientRect();
                    return r.width > 2 && r.height > 2;
                });
                if (!looksCreate && passInputs.length < 1) {
                    return { ok: false, reason: 'not_create_page' };
                }
                const isVisible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) return false;
                    const st = window.getComputedStyle(el);
                    return st.display !== 'none' && st.visibility !== 'hidden';
                };
                const fill = (el, val) => {
                    if (!el || !isVisible(el)) return false;
                    try {
                        el.focus();
                        el.value = val;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    } catch (_) {
                        return false;
                    }
                };
                const emailEl = [...document.querySelectorAll(
                    'input[type="email"], input[name*="email" i], input[autocomplete="email"], input[id*="email" i]'
                )].find(isVisible);
                const filledEmail = fill(emailEl, emailAddr);
                let filledPass = 0;
                for (const p of passInputs.slice(0, 2)) {
                    if (fill(p, pass)) filledPass += 1;
                }
                const createBtn = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
                    .find((el) => {
                        if (!isVisible(el)) return false;
                        const t = `${el.innerText || ''} ${el.value || ''}`.replace(/\s+/g, ' ').trim();
                        return /^(create(\s+account)?|sign\s*up|register|continue|next|submit)$/i.test(t)
                            || /\bcreate\s+account\b/i.test(t);
                    });
                let clicked = false;
                if (createBtn && (filledEmail || filledPass)) {
                    try {
                        createBtn.click();
                        clicked = true;
                    } catch (_) { /* ignore */ }
                }
                return {
                    ok: !!(filledEmail || filledPass),
                    filledEmail,
                    filledPass,
                    clicked,
                    passFields: passInputs.length
                };
            },
            args: [email, password]
        });
        if (result?.ok) {
            await new Promise((r) => setTimeout(r, 1800));
            try { await waitTabComplete(tabId, 8000); } catch (_) { /* ignore */ }
        }
        return { ...(result || { ok: false }), host, passwordSaved: true };
    } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
    }
}

/**
 * Greenhouse (and similar) show JD + Apply above a long form.
 * Click Apply if present and scroll the real application fields into view
 * so fill + Live monitor screenshots show the form, not the job poster.
 * Also follows new tabs and can start ATS account creation.
 */
async function ensureApplyFormVisible(tabId, opts = {}) {
    try {
        await ensureScripts(tabId);
        let host = '';
        let beforeIds = new Set();
        try {
            const tab = await chrome.tabs.get(tabId);
            host = new URL(tab.url || '').hostname.replace(/^www\./i, '');
            beforeIds = new Set((await chrome.tabs.query({})).map((t) => t.id).filter(Boolean));
        } catch (_) { /* ignore */ }
        const lessons = lessonsForHost(await loadApplyLessons(), host)
            .map((l) => ({ selector: l.selector, label: l.label }))
            .slice(0, 8);

        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: (learned) => {
                const normalize = (t) => (t || '').replace(/\s+/g, ' ').trim();
                const visible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    if (r.width < 2 || r.height < 2) return false;
                    const st = window.getComputedStyle(el);
                    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
                };
                const isApplyLabel = (raw) => {
                    const t = normalize(raw);
                    if (!t || t.length > 72) return false;
                    if (/withdraw|cancel|delete|unsubscribe|share|save\s*job|sign\s*in|log\s*in|decline|accept\s*cookie|already\s*applied/i.test(t)) {
                        return false;
                    }
                    if (/^(apply|apply\s*now|apply\s*online|apply\s*for\s*this\s*job(?:\s*online)?|apply\s*for\s*this\s*position|apply\s*for\s*this\s*role|start\s*application|begin\s*application|continue\s*application)$/i.test(t)) {
                        return true;
                    }
                    if (/^apply\b/i.test(t) && t.length <= 48) return true;
                    if (/\bapply\s+for\s+this\s+job\b/i.test(t) && t.length <= 56) return true;
                    if (/\bapply\s+online\b/i.test(t) && t.length <= 40) return true;
                    return false;
                };
                const scoreLabel = (raw) => {
                    const t = normalize(raw).toLowerCase();
                    if (!isApplyLabel(t)) return 0;
                    let score = 10;
                    if (/apply for this job online/.test(t)) score += 20;
                    else if (/apply for this job/.test(t)) score += 16;
                    else if (/apply now|apply online/.test(t)) score += 12;
                    else if (/^apply$/.test(t)) score += 8;
                    if (/start application|begin application/.test(t)) score += 10;
                    return score;
                };

                // Cookie / consent banners often sit over Apply
                const consent = [...document.querySelectorAll(
                    'button, a, [role="button"], input[type="button"]'
                )].find((el) => {
                    if (!visible(el)) return false;
                    const t = normalize(el.innerText || el.textContent || el.value || '');
                    return /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|got it|ok)$/i.test(t);
                });
                if (consent) {
                    try { consent.click(); } catch (_) { /* ignore */ }
                }

                // Prefer learned selectors for this ATS host first.
                let apply = null;
                let applyLabel = '';
                let applySelector = '';
                for (const lesson of (learned || [])) {
                    if (!lesson?.selector) continue;
                    try {
                        const el = document.querySelector(lesson.selector);
                        if (el && visible(el)) {
                            apply = el;
                            applyLabel = lesson.label || normalize(el.innerText || el.value || '');
                            applySelector = lesson.selector;
                            break;
                        }
                    } catch (_) { /* ignore */ }
                }

                if (!apply) {
                    const applyCandidates = [...document.querySelectorAll(
                        'button, a, [role="button"], input[type="button"], input[type="submit"], '
                        + '[data-automation-id*="apply" i], [class*="apply" i]'
                    )];
                    let bestScore = 0;
                    for (const el of applyCandidates) {
                        if (!visible(el)) continue;
                        const t = normalize(
                            el.innerText || el.textContent || el.value
                            || el.getAttribute('aria-label') || el.getAttribute('title') || ''
                        );
                        const sc = scoreLabel(t);
                        if (sc > bestScore) {
                            bestScore = sc;
                            apply = el;
                            applyLabel = t;
                            applySelector = el.id
                                ? `#${el.id}`
                                : (el.getAttribute('data-qa')
                                    ? `[data-qa="${el.getAttribute('data-qa')}"]`
                                    : '');
                        }
                    }
                    if (!apply) {
                        apply = document.querySelector(
                            '#apply_button, .application--button, [data-qa="btn-apply"], '
                            + '[data-automation-id="adventureButton"], [data-automation-id="applyButton"], '
                            + 'a[href*="#app"], a[href*="application"], a[href*="/apply"], button[aria-label*="Apply" i]'
                        );
                        if (apply && visible(apply)) {
                            applyLabel = normalize(
                                apply.innerText || apply.value || apply.getAttribute('aria-label') || 'Apply'
                            );
                        } else {
                            apply = null;
                        }
                    }
                }

                const applyFound = !!(apply && visible(apply));
                let clicked = false;
                if (applyFound) {
                    try {
                        apply.scrollIntoView({ block: 'center', behavior: 'instant' });
                    } catch (_) { /* ignore */ }
                    try {
                        apply.focus?.();
                        apply.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                        apply.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                        apply.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        apply.click();
                        clicked = true;
                    } catch (_) {
                        try { apply.click(); clicked = true; } catch (__) { /* ignore */ }
                    }
                }
                const form =
                    document.querySelector(
                        '#application-form, form#application-form, #greenhouse-job-application, '
                        + '#application, form[action*="application"], #apply_app, '
                        + '[data-provides="application-form"], .application--form, form#apply_form, '
                        + '[data-automation-id="applyFlowPage"], [data-automation-id="createAccountPage"]'
                    )
                    || document.querySelector(
                        '#first_name, [name="first_name"], input[autocomplete="given-name"], '
                        + 'input[type="email"], input[name="email"], input[autocomplete="email"]'
                    );
                if (form) {
                    try {
                        form.scrollIntoView({ block: 'start', behavior: 'instant' });
                    } catch (_) {
                        try { form.scrollIntoView(true); } catch (__) { /* ignore */ }
                    }
                }
                const first = document.querySelector(
                    '#first_name, [name="first_name"], input[autocomplete="given-name"], '
                    + 'input[type="email"][name="email"], input[name="job_application[first_name]"]'
                );
                const r = first?.getBoundingClientRect();
                const fieldCount = document.querySelectorAll(
                    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
                ).length;
                const pageText = (document.body?.innerText || '').slice(0, 4000).toLowerCase();
                const createAccountLikely = /\b(create\s+(an?\s+)?account|sign\s*up|register|confirm\s+password)\b/.test(pageText);
                return {
                    clicked,
                    applyFound,
                    applyLabel,
                    applySelector,
                    consentClicked: !!consent,
                    scrolled: !!form,
                    firstInView: !!(r && r.top >= -40 && r.top < (window.innerHeight || 800) * 0.9),
                    hasFirstName: !!document.querySelector('#first_name, [name="first_name"], input[autocomplete="given-name"]'),
                    fieldCount,
                    createAccountLikely,
                    scrollY: window.scrollY || 0,
                    href: String(location.href || '')
                };
            },
            args: [lessons]
        });

        await new Promise((r) => setTimeout(r, clickedDelay(result)));
        let activeTabId = tabId;
        if (result?.clicked) {
            const childId = await followApplyOpenedTab(tabId, beforeIds, 4500);
            if (childId && childId !== tabId) {
                activeTabId = childId;
                try {
                    await chrome.tabs.update(activeTabId, { active: true });
                } catch (_) { /* ignore */ }
                await setQueueState({ currentTabId: activeTabId }).catch(() => {});
            }
            try {
                await waitTabComplete(activeTabId, 10000);
            } catch (_) { /* ignore */ }
            await new Promise((r) => setTimeout(r, 900));
            try { await ensureScripts(activeTabId); } catch (_) { /* ignore */ }

            // Account wall after Apply — create with saved/generated password.
            if (opts.profileEmail) {
                try {
                    const [{ result: probe }] = await chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        func: () => (document.body?.innerText || '').slice(0, 6000)
                    });
                    if (looksLikeCreateAccountPage(probe) || result?.createAccountLikely) {
                        const created = await tryCreateAtsAccount(activeTabId, opts.profileEmail);
                        result.accountCreate = created;
                        if (created?.ok) {
                            await logCourseEvent(opts.applicationId, 'ats_account_create', {
                                host,
                                clicked: !!created.clicked,
                                filledEmail: !!created.filledEmail
                            }).catch(() => {});
                        }
                    }
                } catch (_) { /* ignore */ }
            }
        }

        // Second pass after Apply click / SPA paint — re-scroll form into view.
        if (result?.clicked || !result?.firstInView) {
            try {
                const [{ result: again }] = await chrome.scripting.executeScript({
                    target: { tabId: activeTabId },
                    func: () => {
                        const form = document.querySelector(
                            '#application-form, form#application-form, #greenhouse-job-application, '
                            + '#application, #first_name, [name="first_name"], input[type="email"], '
                            + '[data-automation-id="applyFlowPage"], [data-automation-id="createAccountPage"]'
                        );
                        if (form) {
                            try { form.scrollIntoView({ block: 'start', behavior: 'instant' }); }
                            catch (_) { try { form.scrollIntoView(true); } catch (__) { /* ignore */ } }
                        }
                        const first = document.querySelector('#first_name, [name="first_name"], input[type="email"]');
                        const r = first?.getBoundingClientRect();
                        return {
                            scrolled: !!form,
                            firstInView: !!(r && r.top >= -40 && r.top < (window.innerHeight || 800) * 0.9),
                            hasFirstName: !!document.querySelector('#first_name, [name="first_name"]'),
                            scrollY: window.scrollY || 0,
                            href: String(location.href || '')
                        };
                    }
                });
                return {
                    ...(result || {}),
                    ...(again || {}),
                    clicked: !!result?.clicked,
                    tabId: activeTabId,
                    followedNewTab: activeTabId !== tabId
                };
            } catch (_) { /* ignore */ }
        }
        return {
            ...(result || { clicked: false, scrolled: false }),
            tabId: activeTabId,
            followedNewTab: activeTabId !== tabId
        };
    } catch (err) {
        console.warn('[bidder] ensureApplyFormVisible', err);
        return { clicked: false, scrolled: false, error: err?.message };
    }
}

function clickedDelay(result) {
    return result?.clicked ? 2200 : 400;
}

async function recheckFormAfterCaptcha(tabId, formWaitMs = BIDDER_DEFAULTS.formWaitMs) {
    try {
        await ensureScripts(tabId);
        const detect2 = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' });
        if (detect2?.ok && detect2.data?.ok) return true;
    } catch (_) { /* loading */ }

    const extraDeadline = Date.now() + formWaitMs;
    while (Date.now() < extraDeadline) {
        await new Promise((r) => setTimeout(r, 800));
        try {
            const d3 = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' });
            if (d3?.ok && d3.data?.ok) return true;
        } catch (_) { /* loading */ }
    }
    return false;
}

async function runBidderFillOnTab(tabId, item, prefs) {
    await acquireFillLock();
    try {
        return await runBidderFillOnTabInner(tabId, item, prefs);
    } finally {
        await clearFillLock();
    }
}

async function prepareBidderApplicationFiles(tabId, item, app, prefs) {
    await ensureScripts(tabId);
    let resumeFile = null;
    const resumeName = app.resume_filename || item.resume_filename;
    const settings = await getSettings();
    if (resumeName) {
        resumeFile = await fetchResumeBase64(settings.apiBaseUrl, resumeName, settings.token).catch(() => null);
    }
    const detect = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' }).catch(() => null);
    const formSnap = detect?.data?.form || { fileInputs: [] };
    const coverLetterFile = await maybePrepareCoverLetterFile({
        form: formSnap,
        profileId: app.profile_id || item.profile_id,
        jobDescription: app.job_description || '',
        resumeHtml: app.draft_html || '',
        companyName: app.company_name || item.company_name || '',
        jobRole: app.job_role || item.job_role || '',
        settings,
        uploadCoverLetter: !!prefs.uploadCoverLetter
    });
    return { resumeFile, coverLetterFile, formSnap, settings };
}

function mapBidderQuestions(rawQuestions) {
    return (rawQuestions || []).map((q) => ({
        id: q.id,
        label: q.label,
        kind: q.kind,
        type: q.type,
        answer_type: q.kind === 'salary' || q.answer_type === 'salary'
            ? 'salary'
            : (Array.isArray(q.options) && q.options.length ? 'choice' : (q.answer_type || 'written')),
        options: Array.isArray(q.options)
            ? q.options.map((o) => (typeof o === 'string' ? o : (o?.label || o?.value || ''))).filter(Boolean)
            : undefined
    }));
}

async function setAutofillPanelStatus(tabId, status, progress = null) {
    try {
        await sendTabMessage(tabId, {
            type: 'UPDATE_AUTOFILL_PANEL',
            status: String(status || '').slice(0, 120),
            progress: progress == null ? undefined : progress
        });
    } catch (_) { /* panel may not exist yet */ }
}

async function generateBidderAnswersForItem(item, app, questions, engineLabel, budgetMs = 50000) {
    if (!questions.length) return [];
    // Never force a 20–25s AI wait when the bid wall-clock budget is nearly gone.
    const requested = Number(budgetMs);
    const ANSWERS_BUDGET_MS = Math.min(
        50000,
        Math.max(0, Number.isFinite(requested) ? requested : 50000)
    );
    if (ANSWERS_BUDGET_MS < 8000) {
        await logCourseEvent(item.id, 'ai_skipped_budget', {
            fresh: questions.length,
            remainingMs: ANSWERS_BUDGET_MS,
            reason: 'answers_budget_too_low'
        }).catch(() => {});
        return [];
    }
    try {
        const brain = await Promise.race([
            generateBidderAnswers({
                profile_id: app.profile_id || item.profile_id,
                job_description: app.job_description || '',
                resume_html: app.draft_html || '',
                questions,
                company_name: app.company_name || item.company_name || '',
                job_role: app.job_role || item.job_role || '',
                application_id: item.id
            }),
            new Promise((_, reject) => {
                setTimeout(
                    () => reject(new Error(`AI answers timed out after ${Math.round(ANSWERS_BUDGET_MS / 1000)}s — continuing with profile fill`)),
                    ANSWERS_BUDGET_MS
                );
            })
        ]);
        const answers = brain.answers || [];
        await logCourseEvent(item.id, 'bidder_answers_ready', {
            engine: brain.engine_version || engineLabel,
            count: answers.length,
            memory_hits: brain.memory_hits || answers.filter((a) => a?.match_source === 'question_memory').length,
            studying: !!brain.studying,
            meta: brain.bidder_meta || null
        });
        // Persist Policy labels into question memory so the next bid studies them.
        try {
            for (const a of answers) {
                const lane = String(a?.lane || '');
                const src = String(a?.match_source || a?.source || '');
                if (lane !== 'policy' && !/hard_lock|question_memory|regex|fixed/.test(src)) continue;
                const label = String(a.label || '').trim();
                const answer = String(a.answer || '').trim();
                if (!label || !answer || answer.length > 160) continue;
                await upsertQuestionMemory({
                    kind: a.kind || undefined,
                    question: label,
                    answer,
                    source: 'success',
                    knockout: !!a.knockout
                }).catch(() => {});
            }
        } catch (_) { /* ignore */ }
        return answers;
    } catch (err) {
        await logCourseEvent(item.id, 'ai_failed', { error: err?.message, engine: engineLabel });
        await notify('Bidder', `AI answers failed — continuing profile fill: ${err?.message || err}`);
        return [];
    }
}

async function runAutofillEngineOnTab(tabId, item, prefs, ctx) {
    const {
        profile,
        payload,
        app,
        answers: seedAnswers,
        ats,
        engineLabel,
        filePayload
    } = ctx;

    const stayInApp = prefs.stayInApp !== false;
    const shotOpts = (extra = {}) => ({ stayInApp, ...extra });
    const pageLimit = maxPagesForAts(ats);
    const pageSettleMs = settleMsForAts(ats);
    const bidLimitMs = Number(prefs?.bidLimitMs) || bidLimitMsForAts(ats, { pageCount: pageLimit });
    const bidDeadline = Number(prefs?.bidDeadline) || (Date.now() + bidLimitMs);
    let answers = Array.isArray(seedAnswers) ? [...seedAnswers] : [];
    // Prefer early lessons queued before fill (wins over AI via merge priority).
    if (Array.isArray(prefs?.earlyFillLessons) && prefs.earlyFillLessons.length) {
        answers = mergeAnswers(answers, lessonFillsToAnswers(prefs.earlyFillLessons, 'fill_lesson_early'));
        if (prefs.earlyFillLessonMeta) {
            await logCourseEvent(item.id, 'fill_lesson_applied', {
                ...prefs.earlyFillLessonMeta,
                fill_count: prefs.earlyFillLessons.length,
                phase: 'early_merge'
            }).catch(() => {});
        }
    }
    let totalFilled = 0;
    let totalUploaded = 0;
    let pages = 0;
    let lastFp = '';
    let submitClicked = false;
    let lastFillResp = null;
    let lastRequiredComplete = null;
    let lastRequiredOk = null;
    let lastRequiredTotal = null;
    let lastMissingRequired = [];
    let budgetExceeded = false;

    await logCourseEvent(item.id, 'autofill_engine', {
        ats,
        engine: engineLabel || engineLabelForAts(ats),
        version: AUTOFILL_ENGINE,
        maxPages: pageLimit,
        settleMs: pageSettleMs,
        bidLimitMs
    });

    // Keep Live monitor + Open-tab wired to THIS apply tab for the whole autofill run.
    try {
        const tab = await chrome.tabs.get(tabId);
        const tabUrl = tab?.pendingUrl || tab?.url || '';
        await setQueueState({
            currentTabId: tabId,
            currentId: item.id,
            currentJobUrl: tabUrl || undefined
        });
    } catch (_) {
        await setQueueState({ currentTabId: tabId, currentId: item.id });
    }

    while (pages < pageLimit) {
        if (Date.now() > bidDeadline) {
            budgetExceeded = true;
            await logCourseEvent(item.id, 'bid_budget_exceeded', {
                phase: 'autofill_page_loop',
                page: pages,
                limitMs: bidLimitMs
            });
            break;
        }
        pages += 1;

        // CAPTCHA / login gate before each page fill (blocking walls only — not sitekey widgets)
        const wall = await detectCaptchaOrLogin(tabId);
        if (isBlockingCaptchaWall(wall, { formReady: true })) {
            const wait = await runCaptchaPassEngine({
                tabId,
                applicationId: item.id,
                prefs,
                wall,
                phase: `autofill_page_${pages}`,
                companyLabel: item.company_name || app.company_name || 'Job'
            });
            if (!wait.cleared) {
                throw new Error(
                    wait.stopped
                        ? 'stopped'
                        : wait.timeout
                            ? 'captcha_not_cleared'
                            : 'captcha_needs_manual'
                );
            }
        }

        // Wait briefly for SPA form fields to mount (Oracle/Workday)
        let formSnap = null;
        for (let readyTry = 0; readyTry < 6; readyTry++) {
            formSnap = await collectForm(tabId).catch(() => null);
            if (formSnap?.blocked) {
                throw new Error(formSnap.reason || 'Site blocked');
            }
            if (formFieldCount(formSnap) > 0 || formFingerprint(formSnap)) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        const fp = formFingerprint(formSnap);
        if (fp && fp === lastFp && pages > 1) {
            // Page did not change after Next — stop looping
            break;
        }
        lastFp = fp || lastFp;

        // Fresh questions on later pages → AI only when budget remains (≥12s).
        const pageQuestions = mapBidderQuestions(formSnap?.questions || []);
        const freshQs = pickNewQuestions(pageQuestions, answers);
        const remainingMs = bidDeadline - Date.now();
        if (freshQs.length && remainingMs >= 12000) {
            const more = await generateBidderAnswersForItem(
                item,
                app,
                freshQs,
                engineLabel || engineLabelForAts(ats),
                Math.min(30000, remainingMs - 5000)
            );
            answers = mergeAnswers(answers, more);
        } else if (freshQs.length) {
            await logCourseEvent(item.id, 'ai_skipped_budget', {
                page: pages,
                fresh: freshQs.length,
                remainingMs
            });
        }

        await uploadScreenshot(item.id, `autofill_page_${pages}_before`, tabId, shotOpts({ settleMs: 400 }))
            .catch(() => {});

        let fillResp = null;
        let fillErr = null;
        for (let attempt = 1; attempt <= AUTOFILL_RETRY_PER_PAGE; attempt++) {
            try {
                fillResp = await fillAndUpload(tabId, {
                    ...filePayload,
                    profile: { ...profile, ...payload.profile },
                    answers,
                    jobDescription: app.job_description || '',
                    // v3: always fill profile + answers on every page.
                    // answersOnly only on final submit polish.
                    autoSubmit: false,
                    answersOnly: useAnswersOnlyOnPage(pages),
                    engine: AUTOFILL_ENGINE
                });
                fillErr = null;
                if (
                    shouldRefillPage({
                        form: formSnap,
                        fillStats: {
                            filled: fillResp.fillStats?.filled || 0,
                            uploaded: fillResp.uploadStats?.uploaded || 0
                        },
                        attempt,
                        maxAttempts: AUTOFILL_RETRY_PER_PAGE
                    })
                ) {
                    await logCourseEvent(item.id, 'fill_retry', {
                        engine: AUTOFILL_ENGINE,
                        page: pages,
                        attempt,
                        reason: 'low_coverage',
                        filled: fillResp.fillStats?.filled || 0,
                        fields: formFieldCount(formSnap)
                    });
                    await new Promise((r) => setTimeout(r, 700));
                    continue;
                }
                break;
            } catch (err) {
                fillErr = err;
                await logCourseEvent(item.id, 'fill_retry', {
                    engine: AUTOFILL_ENGINE,
                    page: pages,
                    attempt,
                    error: err?.message
                });
                await new Promise((r) => setTimeout(r, 900));
            }
        }
        if (fillErr) throw fillErr;
        lastFillResp = fillResp;

        totalFilled += fillResp.fillStats?.filled || 0;
        totalUploaded += fillResp.uploadStats?.uploaded || 0;
        if (fillResp.fillStats && typeof fillResp.fillStats.requiredComplete === 'boolean') {
            lastRequiredComplete = fillResp.fillStats.requiredComplete;
            lastRequiredOk = fillResp.fillStats.requiredOk;
            lastRequiredTotal = fillResp.fillStats.requiredTotal;
            lastMissingRequired = Array.isArray(fillResp.fillStats.missingRequired)
                ? fillResp.fillStats.missingRequired
                : [];
        }

        await uploadScreenshot(item.id, `autofill_page_${pages}_after`, tabId, shotOpts({ settleMs: 600 }))
            .catch(() => {});

        await logCourseEvent(item.id, 'autofill_page', {
            engine: AUTOFILL_ENGINE,
            ats,
            page: pages,
            filled: fillResp.fillStats?.filled || 0,
            uploaded: fillResp.uploadStats?.uploaded || 0,
            requiredComplete: fillResp.fillStats?.requiredComplete,
            requiredOk: fillResp.fillStats?.requiredOk,
            requiredTotal: fillResp.fillStats?.requiredTotal,
            missing: fillResp.fillStats?.missingRequired || [],
            fingerprint: fp ? fp.slice(0, 120) : null
        });

        // Try Next / Continue for multi-step ATS (Workday, Oracle, etc.)
        const beforeNextFp = fp;
        const clickedNext = await clickFormNextIfAny(tabId);
        if (!clickedNext) {
            break;
        }

        await new Promise((r) => setTimeout(r, pageSettleMs));
        const afterForm = await collectForm(tabId).catch(() => null);
        const afterFp = formFingerprint(afterForm);
        if (!shouldAdvancePage({
            clickedNext: true,
            fingerprintBefore: beforeNextFp,
            fingerprintAfter: afterFp,
            pages,
            maxPages: pageLimit
        })) {
            break;
        }
        lastFp = afterFp || lastFp;
        // Continue loop for next page fill
    }

    // Do not treat a wall-clock stop as a normal FILLED / submit path.
    if (budgetExceeded) {
        throw new Error('bid_time_budget_exceeded');
    }

    // Final submit pass if enabled
    if (prefs.autoSubmit) {
        // Auto-apply matching fill lessons for this host before submit / when incomplete.
        try {
            let host = '';
            try {
                const tab = await chrome.tabs.get(tabId);
                host = new URL(tab.url || '').hostname.replace(/^www\./i, '');
            } catch (_) { /* ignore */ }
            if (host) {
                let disabledMap = {};
                try {
                    const p = await getBidderPrefs();
                    disabledMap = p?.disabledFillLessons && typeof p.disabledFillLessons === 'object'
                        ? p.disabledFillLessons
                        : {};
                } catch (_) {
                    disabledMap = {};
                }
                const local = await fillLessonsForHost(host);
                let remote = [];
                try {
                    const pack = await listBidderFillLessons({ host });
                    remote = Array.isArray(pack?.lessons) ? pack.lessons : [];
                } catch (_) { /* ignore */ }
                const merged = [...local, ...remote].filter((les) => {
                    const key = `${host}|${les.fieldKey || les.field_key || 'form'}|${les.issueKey || les.issue_key || ''}`;
                    return !disabledMap[key];
                });
                const missBlob = (lastMissingRequired || []).join(' ').toLowerCase();
                const wantLoc = /location|city/.test(missBlob) || lastRequiredComplete === false;
                let lesson = matchFillLesson(merged, {
                    fieldKey: wantLoc ? 'location' : undefined,
                    issueKey: wantLoc ? 'location|no_dropdown_match' : undefined
                });
                if (!lesson) {
                    lesson = merged.find((l) => Array.isArray(l?.actions?.fills) && l.actions.fills.length)
                        || (merged.length === 1 ? merged[0] : null);
                }
                const fills = Array.isArray(lesson?.actions?.fills) ? lesson.actions.fills : [];
                if (fills.length) {
                    const lessonAnswers = lessonFillsToAnswers(fills, 'fill_lesson');
                    answers = mergeAnswers(answers, lessonAnswers);
                    await fillAndUpload(tabId, {
                        ...filePayload,
                        profile: { ...profile, ...payload.profile },
                        answers: lessonAnswers,
                        jobDescription: app.job_description || '',
                        autoSubmit: false,
                        answersOnly: true,
                        engine: AUTOFILL_ENGINE
                    }).catch(() => null);
                    await logCourseEvent(item.id, 'fill_lesson_applied', {
                        host,
                        fieldKey: lesson.fieldKey || lesson.field_key,
                        issueKey: lesson.issueKey || lesson.issue_key,
                        source: lesson.source || 'local',
                        fill_count: fills.length,
                        phase: 'pre_submit'
                    }).catch(() => {});
                    await notify('Lumi', `Lesson applied — ${lesson.fieldKey || 'form'} @ ${host}`);
                    await setQueueState({
                        coachStatus: `Using lesson — ${lesson.fieldKey || 'form'} @ ${host}`,
                        coachAt: Date.now()
                    }).catch(() => {});
                    // Refresh required completeness after lesson
                    try {
                        const re = await sendTabMessage(tabId, { type: 'BIDDER_ENGINE_COLLECT' });
                        if (re && re.requiredComplete != null) {
                            lastRequiredComplete = !!re.requiredComplete;
                            lastRequiredOk = re.requiredOk;
                            lastRequiredTotal = re.requiredTotal;
                            lastMissingRequired = re.missingRequired || lastMissingRequired;
                        }
                    } catch (_) { /* ignore */ }
                }
            }
        } catch (lessonErr) {
            console.warn('[bidder] fill lesson apply failed', lessonErr?.message || lessonErr);
        }

        const requiredBlocked = isFillIncomplete({
            requiredComplete: lastRequiredComplete,
            requiredOk: lastRequiredOk,
            requiredTotal: lastRequiredTotal,
            missingRequired: lastMissingRequired
        });
        if (requiredBlocked) {
            await logCourseEvent(item.id, 'submit_blocked_incomplete', {
                ats,
                reason: 'required_fields_incomplete',
                engine: AUTOFILL_ENGINE,
                requiredOk: lastRequiredOk,
                requiredTotal: lastRequiredTotal,
                missing: lastMissingRequired,
                incomplete: true
            });
        } else {
        // Groq application checkout — block auto-submit when critical issues remain.
        let checkout = null;
        try {
            const snap = await collectForm(tabId).catch(() => null);
            const bidderSnap = await sendTabMessage(tabId, { type: 'BIDDER_ENGINE_COLLECT' }).catch(() => null);
            const fieldRows = Array.isArray(bidderSnap?.fields) && bidderSnap.fields.length
                ? bidderSnap.fields
                : (Array.isArray(snap?.fields) ? snap.fields : []);
            checkout = await checkoutApplicationCheck({
                application_id: item.id,
                ats,
                company_name: item.company_name || app.company_name || '',
                job_role: item.job_role || app.job_role || '',
                missing_required: lastMissingRequired || [],
                fields: fieldRows.map((f) => ({
                    id: f.id,
                    label: f.label,
                    value: f.value ?? '',
                    required: !!f.required
                })),
                answers: Array.isArray(answers)
                    ? answers.map((a) => ({
                        id: a.id,
                        label: a.label,
                        answer: a.answer || a.value || ''
                    }))
                    : []
            });
            await logCourseEvent(item.id, checkout?.ok ? 'checkout_ok' : 'checkout_blocked', {
                ats,
                summary: checkout?.summary || null,
                issues: (checkout?.issues || []).slice(0, 8),
                fix_count: Array.isArray(checkout?.fix_answers) ? checkout.fix_answers.length : 0,
                provider: checkout?.provider || null,
                skipped: !!checkout?.skipped
            }).catch(() => {});
        } catch (chkErr) {
            console.warn('[bidder] checkout check failed', chkErr?.message || chkErr);
        }

        if (checkout && checkout.ok === false && !checkout.skipped) {
            // Apply Groq fix answers once, then re-evaluate required completeness.
            const fixes = Array.isArray(checkout.fix_answers) ? checkout.fix_answers : [];
            if (fixes.length) {
                try {
                    await fillAndUpload(tabId, {
                        ...filePayload,
                        profile: { ...profile, ...payload.profile },
                        answers: [
                            ...(Array.isArray(answers) ? answers : []),
                            ...fixes.map((f) => ({
                                id: f.id || f.label,
                                label: f.label,
                                answer: f.answer,
                                answer_type: 'written',
                                source: 'groq_checkout'
                            }))
                        ],
                        jobDescription: app.job_description || '',
                        autoSubmit: false,
                        answersOnly: true,
                        engine: AUTOFILL_ENGINE
                    }).catch(() => null);
                } catch (_) { /* ignore */ }
            }
            await logCourseEvent(item.id, 'submit_blocked_incomplete', {
                ats,
                reason: 'groq_checkout_blocked',
                summary: checkout.summary || null,
                issues: (checkout.issues || []).slice(0, 8),
                engine: AUTOFILL_ENGINE,
                missing: lastMissingRequired
            });
        } else {
        const wall = await detectCaptchaOrLogin(tabId);
        if (isBlockingCaptchaWall(wall, {
            formReady: true,
            forSubmit: true,
            captchaHelper: !!prefs.captchaHelper
        })) {
            const wait = await runCaptchaPassEngine({
                tabId,
                applicationId: item.id,
                prefs,
                wall,
                phase: 'autofill_pre_submit',
                companyLabel: item.company_name || app.company_name || 'Job'
            });
            if (!wait.cleared) {
                await logCourseEvent(item.id, 'submit_blocked_incomplete', {
                    ats,
                    reason: 'captcha before submit',
                    engine: AUTOFILL_ENGINE
                });
            } else {
                const sub = await fillAndUpload(tabId, {
                    ...filePayload,
                    profile: { ...profile, ...payload.profile },
                    answers,
                    jobDescription: app.job_description || '',
                    autoSubmit: true,
                    answersOnly: useAnswersOnlyOnPage(pages, { finalSubmitPass: true }),
                    engine: AUTOFILL_ENGINE
                }).catch(() => null);
                submitClicked = !!sub?.submitStats?.clicked;
                if (submitClicked) {
                    await logCourseEvent(item.id, 'submit_clicked', sub.submitStats || {});
                }
            }
        } else {
            const sub = await sendTabMessage(tabId, { type: 'CLICK_SUBMIT' }).catch(() => null);
            submitClicked = !!sub?.clicked;
            if (submitClicked) {
                await logCourseEvent(item.id, 'submit_clicked', sub || {});
            } else if (lastFillResp) {
                // One more full fill+submit
                const finalFill = await fillAndUpload(tabId, {
                    ...filePayload,
                    profile: { ...profile, ...payload.profile },
                    answers,
                    jobDescription: app.job_description || '',
                    autoSubmit: true,
                    answersOnly: useAnswersOnlyOnPage(pages, { finalSubmitPass: true }),
                    engine: AUTOFILL_ENGINE
                });
                submitClicked = !!finalFill.submitStats?.clicked;
                totalFilled += finalFill.fillStats?.filled || 0;
                totalUploaded += finalFill.uploadStats?.uploaded || 0;
                if (finalFill.fillStats && typeof finalFill.fillStats.requiredComplete === 'boolean') {
                    lastRequiredComplete = finalFill.fillStats.requiredComplete;
                    lastRequiredOk = finalFill.fillStats.requiredOk;
                    lastRequiredTotal = finalFill.fillStats.requiredTotal;
                    lastMissingRequired = Array.isArray(finalFill.fillStats.missingRequired)
                        ? finalFill.fillStats.missingRequired
                        : lastMissingRequired;
                }
                if (submitClicked) {
                    await logCourseEvent(item.id, 'submit_clicked', finalFill.submitStats || {});
                } else {
                    await logCourseEvent(item.id, 'submit_blocked_incomplete', {
                        ats,
                        reason: 'autofill did not click submit — review form manually',
                        engine: AUTOFILL_ENGINE,
                        requiredOk: lastRequiredOk,
                        requiredTotal: lastRequiredTotal,
                        missing: lastMissingRequired
                    });
                }
            }
        }
        } // end checkout ok → submit
        } // end !requiredBlocked
    }

    await uploadScreenshot(item.id, 'pre_submit', tabId, shotOpts({ settleMs: 1000 })).catch(() => {});
    const minFillForReady = 5;
    const fillLooksComplete = lastRequiredComplete === true
        || (lastRequiredComplete !== false && (
            submitClicked
            || totalFilled >= minFillForReady
            || (totalFilled + totalUploaded) >= minFillForReady
        ));
    const incomplete = lastRequiredComplete === false || !fillLooksComplete;
    if (incomplete) {
        await logCourseEvent(item.id, 'fill_incomplete', {
            ats,
            filled: totalFilled,
            uploaded: totalUploaded,
            pages,
            minFillForReady,
            engine: engineLabel || engineLabelForAts(ats),
            version: AUTOFILL_ENGINE,
            requiredOk: lastRequiredOk,
            requiredTotal: lastRequiredTotal,
            missing: lastMissingRequired,
            reason: lastRequiredComplete === false
                ? 'required_fields_incomplete'
                : 'too few fields filled — not marking FILLED'
        });
    } else {
        await logCourseEvent(item.id, 'ready_to_submit', {
            ats,
            filled: totalFilled,
            uploaded: totalUploaded,
            pages,
            engine: engineLabel || engineLabelForAts(ats),
            version: AUTOFILL_ENGINE,
            submitClicked,
            forceFilled: !!submitClicked,
            requiredComplete: lastRequiredComplete
        });
    }

    await savePackage(item.id, answers, {
        engine: engineLabel || engineLabelForAts(ats),
        ats,
        filled: totalFilled + totalUploaded,
        pages,
        version: AUTOFILL_ENGINE,
        incomplete,
        requiredOk: lastRequiredOk,
        requiredTotal: lastRequiredTotal
    });

    const normalized = normalizeFillStats({
        filled: totalFilled,
        submitClicked,
        incomplete,
        requiredComplete: lastRequiredComplete !== false && fillLooksComplete,
        requiredOk: lastRequiredOk,
        requiredTotal: lastRequiredTotal,
        missingRequired: lastMissingRequired
    });

    return {
        filled: totalFilled,
        submitClicked,
        answersList: answers,
        submitStats: { clicked: submitClicked },
        engine: engineLabel || engineLabelForAts(ats),
        ats,
        pages,
        incomplete: normalized.incomplete,
        requiredComplete: normalized.requiredComplete,
        requiredOk: normalized.requiredOk,
        requiredTotal: normalized.requiredTotal,
        missingRequired: normalized.missingRequired
    };
}

async function runBidderFillOnTabInner(tabId, item, prefs) {
    await ensureScripts(tabId);
    const payload = await getBidderApplication(item.id);
    const app = payload.application || {};
    const profile = payload.profile || {};
    const applyUrl = app.job_url || item.open_url || item.job_url || '';
    let tabUrl = applyUrl;
    try {
        const tab = await chrome.tabs.get(tabId);
        tabUrl = tab?.url || applyUrl;
    } catch (_) { /* ignore */ }
    const atsHint = resolveBidderAts({
        applyUrl,
        tabUrl,
        formAts: app.ats || item.ats || 'generic'
    });
    const bidLimitMs = Number(prefs?.bidLimitMs) || bidLimitMsForAts(atsHint);
    const bidDeadline = Number(prefs?.bidDeadline) || (Date.now() + bidLimitMs);

    let formSnap = await collectForm(tabId).catch(() => null);
    let ats = resolveBidderAts({
        applyUrl,
        tabUrl,
        formAts: formSnap?.ats
    });

    if (formSnap?.blocked || ats === 'linkedin') {
        const reason = formSnap?.reason || 'LinkedIn Easy Apply is not supported';
        // Legacy content scripts used to return blocked+greenhouse_only for Oracle etc.
        // Never treat that as a hard fail — multi-ATS autofill handles those sites.
        if (/greenhouse[_-]?only|use_autofill/i.test(String(reason)) && ats !== 'linkedin') {
            await logCourseEvent(item.id, 'autofill_engine', {
                ats,
                engine: engineLabelForAts(ats),
                fallback: 'cleared_stale_greenhouse_only_block',
                url: formSnap?.url || tabUrl || applyUrl || null
            });
        } else {
            await logCourseEvent(item.id, 'blocked_ats', {
                ats: ats === 'linkedin' ? 'linkedin' : (formSnap?.ats || ats),
                reason,
                url: formSnap?.url || tabUrl || applyUrl || null
            });
            throw new Error(reason);
        }
    }

    let engineLabel = ats === 'greenhouse'
        ? 'bidder-engine-v1'
        : engineLabelForAts(ats);

    await saveSettings({
        selectedProfileId: app.profile_id || item.profile_id,
        lastResult: {
            ...(await getSettings()).lastResult,
            applicationId: item.id,
            resumeFilename: app.resume_filename || item.resume_filename,
            jobUrl: app.job_url || item.open_url,
            fromBidder: true,
            bidderEngine: engineLabel
        }
    });

    await rememberCvForJob({
        jobUrl: app.job_url || item.open_url,
        applicationId: item.id,
        resumeFilename: app.resume_filename || item.resume_filename,
        profileId: app.profile_id || item.profile_id,
        company: app.company_name || item.company_name,
        jobTitle: app.job_role || item.job_role
    });

    // Fill name/email/phone ASAP — never wait on CV QA / AI answers for this.
    await setAutofillPanelStatus(tabId, 'Filling profile (name, email, phone)…', 12);
    await ensureApplyFormVisible(tabId).catch(() => {});
    try {
        await sendTabMessage(tabId, {
            type: 'FILL_FORM',
            payload: {
                profile: { ...profile, ...payload.profile },
                answers: [],
                autoSubmit: false,
                skipFiles: true
            }
        });
        await logCourseEvent(item.id, 'profile_fill_started', {
            ats,
            engine: engineLabel,
            early: true
        });
    } catch (err) {
        console.warn('[bidder] early profile fill', err);
    }

    // CV quality gate — only block on missing resume file. Soft issues regenerate
    // in the background so the form is not empty for minutes.
    try {
        await setAutofillPanelStatus(tabId, 'Checking CV…', 18);
        const qa = await checkBidderCv({
            application_id: item.id,
            draft_html: app.draft_html || '',
            job_description: app.job_description || '',
            resume_filename: app.resume_filename || item.resume_filename
        });
        const mustHaveFile = Array.isArray(qa?.reasons) && qa.reasons.includes('missing_resume_file');
        if (qa?.shouldRegenerate && mustHaveFile) {
            await logCourseEvent(item.id, 'cv_regenerate_needed', qa);
            await setAutofillPanelStatus(tabId, 'Generating CV (max 60s)…', 22);
            await notify('Bidder', 'No resume on file — generating CV before uploads (60s max)');
            try {
                const gen = await Promise.race([
                    generateResume({
                        profileId: app.profile_id || item.profile_id,
                        jobDescription: app.job_description || '',
                        companyName: app.company_name || item.company_name || '',
                        jobRole: app.job_role || item.job_role || '',
                        jobUrl: app.job_url || item.open_url || '',
                        coreSkills: ''
                    }),
                    new Promise((_, reject) => {
                        setTimeout(() => reject(new Error('CV generate timed out after 60s')), 60000);
                    })
                ]);
                if (gen?.resume_filename) {
                    app.resume_filename = gen.resume_filename;
                    app.draft_html = gen.draft_html || gen.resume_html || app.draft_html;
                    await logCourseEvent(item.id, 'cv_regenerated', { filename: gen.resume_filename });
                }
            } catch (err) {
                await logCourseEvent(item.id, 'cv_regenerate_failed', { error: err?.message });
            }
        } else if (qa?.shouldRegenerate) {
            await logCourseEvent(item.id, 'cv_regenerate_deferred', {
                ...qa,
                note: 'soft_quality_issue_fill_continues'
            });
            // Fire-and-forget soft regen — do not block fill
            generateResume({
                profileId: app.profile_id || item.profile_id,
                jobDescription: app.job_description || '',
                companyName: app.company_name || item.company_name || '',
                jobRole: app.job_role || item.job_role || '',
                jobUrl: app.job_url || item.open_url || '',
                coreSkills: ''
            }).then((gen) => {
                if (gen?.resume_filename) {
                    logCourseEvent(item.id, 'cv_regenerated_bg', { filename: gen.resume_filename }).catch(() => {});
                }
            }).catch((err) => {
                logCourseEvent(item.id, 'cv_regenerate_failed', { error: err?.message, bg: true }).catch(() => {});
            });
        }
    } catch (err) {
        console.warn('[bidder] cv-check', err);
    }

    let questions = [];
    let useGreenhouseEngine = ats === 'greenhouse';
    if (useGreenhouseEngine) {
        // Re-bind after CV/API work — tab may have navigated and dropped listeners.
        const collected = await sendTabMessage(tabId, { type: 'BIDDER_ENGINE_COLLECT' });
        const softHandoff = /greenhouse[_-]?only|use_autofill/i.test(
            String(collected?.reason || '')
        ) || collected?.useAutofill;
        if (!collected?.ok && softHandoff) {
            useGreenhouseEngine = false;
            ats = resolveBidderAts({ applyUrl, tabUrl, formAts: collected?.ats || formSnap?.ats || 'generic' });
            engineLabel = engineLabelForAts(ats);
            if (!formSnap) formSnap = await collectForm(tabId).catch(() => null);
            questions = mapBidderQuestions(formSnap?.questions || []);
            await logCourseEvent(item.id, 'autofill_engine', {
                ats,
                engine: engineLabel,
                fallback: 'greenhouse_collect_handoff'
            });
        } else if (!collected?.ok) {
            throw new Error(collected?.reason || collected?.error || 'Bidder collect failed');
        } else {
            questions = mapBidderQuestions(collected.questions || []);
        }
    }
    if (!useGreenhouseEngine && !questions.length) {
        if (!formSnap) formSnap = await collectForm(tabId).catch(() => null);
        questions = mapBidderQuestions(formSnap?.questions || []);
        await logCourseEvent(item.id, 'autofill_engine', { ats, engine: engineLabel });
    }

    await ensureApplyFormVisible(tabId);
    await logCourseEvent(item.id, 'answers_generating', {
        ats,
        engine: engineLabel,
        questions: questions.length
    });
    await setAutofillPanelStatus(
        tabId,
        questions.length
            ? `Drafting ${questions.length} AI answer(s)… (profile already filling)`
            : 'Preparing resume upload…',
        35
    );

    // AI answers — only when enough wall-clock budget remains (≥12s after reserve).
    const remainingForAi = bidDeadline - Date.now() - 12000;
    let answersPromise;
    if (questions.length && remainingForAi < 12000) {
        await logCourseEvent(item.id, 'ai_skipped_budget', {
            fresh: questions.length,
            remainingMs: Math.max(0, bidDeadline - Date.now()),
            reason: 'pre_fill'
        }).catch(() => {});
        answersPromise = Promise.resolve([]);
    } else {
        const answersBudgetMs = Math.min(50000, Math.max(0, remainingForAi));
        answersPromise = generateBidderAnswersForItem(
            item,
            app,
            questions,
            engineLabel,
            answersBudgetMs
        )
            .catch((err) => {
                console.warn('[bidder] answers failed; continue profile-only', err);
                return [];
            });
    }
    const prepPromise = prepareBidderApplicationFiles(tabId, item, app, prefs);

    let resumeFile = null;
    let coverLetterFile = null;
    try {
        await setAutofillPanelStatus(tabId, 'Preparing resume / cover letter files…', 40);
        const prep = await prepPromise;
        resumeFile = prep?.resumeFile || null;
        coverLetterFile = prep?.coverLetterFile || null;
    } catch (err) {
        throw err;
    }

    const shotOpts = (extra = {}) => ({ stayInApp: true, ...extra });
    const filePayload = {
        resume: resumeFile,
        coverLetter: coverLetterFile,
        skipCoverLetter: !coverLetterFile,
        filename: resumeFile?.filename,
        base64: resumeFile?.base64,
        mimeType: resumeFile?.mimeType
    };

    try {
        await ensureApplyFormVisible(tabId);
        await setAutofillPanelStatus(tabId, 'Uploading files + refreshing profile…', 55);
        await logCourseEvent(item.id, 'profile_fill_files', {
            ats,
            engine: engineLabel,
            questions: questions.length,
            parallel_answers: true
        });
        // Profile + files while AI still runs.
        await sendTabMessage(tabId, {
            type: 'FILL_FORM',
            payload: {
                ...filePayload,
                profile: { ...profile, ...payload.profile },
                answers: [],
                autoSubmit: false
            }
        }).catch(() => null);
        uploadScreenshot(item.id, 'mid_fill', tabId, shotOpts({ settleMs: 200 })).catch(() => {});
    } catch (err) {
        console.warn('[bidder] file/profile fill', err);
    }

    let answers = [];
    try {
        await setAutofillPanelStatus(tabId, 'Waiting for AI answers…', 65);
        const ans = await answersPromise;
        answers = Array.isArray(ans) ? ans : [];
    } catch (err) {
        throw err;
    }

    // Studying / fill lessons — merge AFTER AI so lesson priority wins (mergeAnswers).
    if (Array.isArray(prefs?.earlyFillLessons) && prefs.earlyFillLessons.length) {
        answers = mergeAnswers(answers, lessonFillsToAnswers(prefs.earlyFillLessons, 'fill_lesson_early'));
        await logCourseEvent(item.id, 'fill_lesson_applied', {
            ...(prefs.earlyFillLessonMeta || {}),
            fill_count: prefs.earlyFillLessons.length,
            phase: 'greenhouse_merge',
            answer_count: answers.length
        }).catch(() => {});
    }

    const memoryHits = answers.filter((a) => a?.match_source === 'question_memory' || a?.source === 'question_memory').length;
    const policyLocks = answers.filter((a) => a?.match_source === 'hard_lock' || a?.lane === 'policy').length;
    await logCourseEvent(item.id, 'studying_answer_mix', {
        total: answers.length,
        memory_hits: memoryHits,
        policy_or_lock: policyLocks,
        unique: answers.filter((a) => a?.lane === 'unique').length,
        lessons: answers.filter((a) => /fill_lesson/.test(String(a?.source || a?.match_source || ''))).length
    }).catch(() => {});

    await setAutofillPanelStatus(
        tabId,
        answers.length ? `Filling ${answers.length} answer(s)…` : 'Finishing form fill…',
        75
    );
    await ensureApplyFormVisible(tabId);

        if (!useGreenhouseEngine) {
            return await runAutofillEngineOnTab(tabId, item, prefs, {
                profile,
                payload,
                app,
                answers,
                ats,
                engineLabel,
                filePayload
            });
        }

        // Dial Country* (+1) before engine — must be trusted CDP click/type/Enter.
        try {
            const dialOk = await ensureUsDialCodeTrusted(tabId);
            await logCourseEvent(item.id, 'dial_country', { ok: !!dialOk, via: 'trusted_cdp' });
        } catch (err) {
            console.warn('[bidder] dial country', err);
        }

        let run = await sendTabMessage(tabId, {
            type: 'BIDDER_ENGINE_RUN',
            payload: {
                profile: { ...profile, ...payload.profile },
                answers,
                autoSubmit: !!prefs.autoSubmit,
                applicationId: item.id,
                jobDescription: app.job_description || '',
                bidDeadline
            }
        });

        if (!run?.ok) throw new Error(run?.error || 'Bidder engine run failed');
        const result = run.result || {};

        // Soft handoff when Greenhouse engine declines a non-GH page
        // (legacy greenhouse_only or explicit useAutofill).
        const softHandoff = !!result.useAutofill
            || /greenhouse[_-]?only|use_autofill/i.test(String(result.reason || ''));
        if (result.timeout || /bid_time_budget|budget_exceeded/i.test(String(result.reason || ''))) {
            await logCourseEvent(item.id, 'bid_budget_exceeded', {
                via: 'greenhouse_engine',
                limitMs: BID_HARD_LIMIT_MS,
                pages: result.pages,
                filled: result.filled
            }).catch(() => {});
            throw new Error('bid_time_budget_exceeded');
        }
        if (softHandoff) {
            useGreenhouseEngine = false;
            ats = resolveBidderAts({
                applyUrl,
                tabUrl,
                formAts: result.ats || formSnap?.ats || ats
            });
            engineLabel = engineLabelForAts(ats);
            await logCourseEvent(item.id, 'autofill_engine', {
                ats,
                engine: engineLabel,
                fallback: 'greenhouse_run_handoff',
                priorReason: result.reason || null
            });
            return await runAutofillEngineOnTab(tabId, item, prefs, {
                profile,
                payload,
                app,
                answers,
                ats,
                engineLabel,
                filePayload
            });
        }

        if (Array.isArray(result.attempts) && result.attempts.length) {
            try {
                await logBidderFieldAttempts(item.id, result.attempts);
            } catch (err) {
                console.warn('[bidder] field attempts', err);
            }
        }

        if (result.blocked) {
            await logCourseEvent(item.id, 'blocked_ats', result);
            throw new Error(result.reason || 'ATS blocked');
        }

        if (result.preSubmit || result.readyToSubmit) {
            await uploadScreenshot(item.id, 'pre_submit', tabId, shotOpts({ settleMs: 1000 }));
            await logCourseEvent(item.id, 'ready_to_submit', {
                requiredComplete: result.requiredComplete,
                requiredOk: result.requiredOk,
                requiredTotal: result.requiredTotal
            });
            if (prefs.autoSubmit && result.requiredComplete) {
                const preWall = await detectCaptchaOrLogin(tabId).catch(() => null);
                if (isBlockingCaptchaWall(preWall, {
                    formReady: true,
                    forSubmit: true,
                    captchaHelper: !!prefs.captchaHelper
                })) {
                    const wait = await runCaptchaPassEngine({
                        tabId,
                        applicationId: item.id,
                        prefs,
                        wall: preWall,
                        phase: 'bidder_pre_submit',
                        companyLabel: item.company_name || app.company_name || 'Job'
                    });
                    if (!wait.cleared) {
                        await logCourseEvent(item.id, 'submit_blocked_incomplete', {
                            reason: 'captcha before submit',
                            incomplete: true
                        });
                        result.submitClicked = false;
                    } else if (!result.submitClicked) {
                        const sub = await sendTabMessage(tabId, { type: 'BIDDER_ENGINE_SUBMIT', force: true });
                        result.submitClicked = !!sub?.clicked;
                        await logCourseEvent(item.id, 'submit_clicked', sub || {});
                    }
                } else if (!result.submitClicked) {
                    const sub = await sendTabMessage(tabId, {
                        type: 'BIDDER_ENGINE_SUBMIT',
                        force: true
                    });
                    result.submitClicked = !!sub?.clicked;
                    await logCourseEvent(item.id, 'submit_clicked', sub || {});
                }
            } else if (prefs.autoSubmit && !result.requiredComplete) {
                // Still try when Greenhouse enabled Submit — collector false-empties are common.
                if (!result.submitClicked) {
                    const sub = await sendTabMessage(tabId, {
                        type: 'BIDDER_ENGINE_SUBMIT',
                        force: true
                    }).catch(() => null);
                    if (sub?.clicked) {
                        result.submitClicked = true;
                        result.requiredComplete = true;
                        await logCourseEvent(item.id, 'submit_clicked', {
                            ...(sub || {}),
                            via: 'force_despite_incomplete'
                        });
                    } else {
                        await logCourseEvent(item.id, 'submit_blocked_incomplete', {
                            missing: result.missingRequired || sub?.missing || [],
                            requiredOk: result.requiredOk,
                            requiredTotal: result.requiredTotal,
                            incomplete: true,
                            reason: 'required_fields_incomplete',
                            siteReady: sub?.siteReady
                        });
                        await notify('Bidder', 'Required fields incomplete — Submit blocked; reported');
                    }
                }
            }
        }

        await logCourseEvent(item.id, 'mid_fill', {
            requiredOk: result.requiredOk,
            requiredTotal: result.requiredTotal,
            filled: result.filled,
            complete: !!result.requiredComplete,
            missing: result.missingRequired || []
        });

        // Top-up with fill.js when Greenhouse engine left required selects/essays empty.
        let topUpFilled = 0;
        if (!result.requiredComplete) {
            try {
                const topUp = await sendTabMessage(tabId, {
                    type: 'FILL_FORM',
                    payload: {
                        ...filePayload,
                        profile: { ...profile, ...payload.profile },
                        answers,
                        autoSubmit: false
                    }
                });
                topUpFilled = topUp?.fillStats?.filled || 0;
                if (topUp?.fillStats) {
                    result.filled = (result.filled || 0) + topUpFilled;
                    result.requiredComplete = !!topUp.fillStats.requiredComplete || result.requiredComplete;
                    if (Array.isArray(topUp.fillStats.missingRequired) && topUp.fillStats.missingRequired.length) {
                        result.missingRequired = topUp.fillStats.missingRequired;
                    }
                }
            } catch (err) {
                console.warn('[bidder] fill.js top-up after engine', err);
            }
            await logCourseEvent(item.id, 'mid_fill', {
                requiredOk: result.requiredOk,
                requiredTotal: result.requiredTotal,
                filled: result.filled,
                complete: !!result.requiredComplete,
                topUpFilled,
                missing: result.missingRequired || []
            });
        }

        // Top-up may have completed required fields after the first submit gate skipped.
        if (
            prefs.autoSubmit
            && result.requiredComplete
            && !result.submitClicked
        ) {
            try {
                const sub = await sendTabMessage(tabId, { type: 'BIDDER_ENGINE_SUBMIT', force: false });
                if (sub?.clicked) {
                    result.submitClicked = true;
                    await logCourseEvent(item.id, 'submit_clicked', { ...(sub || {}), afterTopUp: true });
                } else {
                    const sub2 = await sendTabMessage(tabId, { type: 'CLICK_SUBMIT' }).catch(() => null);
                    result.submitClicked = !!sub2?.clicked;
                    if (result.submitClicked) {
                        await logCourseEvent(item.id, 'submit_clicked', {
                            ...(sub2 || {}),
                            afterTopUp: true,
                            via: 'CLICK_SUBMIT'
                        });
                    }
                }
            } catch (err) {
                console.warn('[bidder] post top-up submit', err);
            }
        }

        if (result.requiredComplete || result.filled > 0) {
            // Only use awaiting_manual_submit when Auto Bidder auto-submit is OFF.
            // Incomplete required fields with autoSubmit ON → submit_blocked_incomplete.
            let fillEvent = 'fill_done';
            if (!result.requiredComplete) {
                fillEvent = prefs.autoSubmit ? 'submit_blocked_incomplete' : 'awaiting_manual_submit';
            }
            await logCourseEvent(item.id, fillEvent, {
                filled: result.filled,
                requiredOk: result.requiredOk,
                requiredTotal: result.requiredTotal,
                incomplete: !result.requiredComplete,
                autoSubmit: !!prefs.autoSubmit,
                missing: result.missingRequired || []
            });
        }

        await savePackage(item.id, answers, {
            engine: engineLabel,
            filled: result.filled,
            requiredComplete: result.requiredComplete,
            incomplete: !result.requiredComplete,
            missing: result.missingRequired || []
        });

        return {
            filled: result.filled || 0,
            submitClicked: !!result.submitClicked,
            answersList: answers,
            submitStats: { clicked: !!result.submitClicked },
            engine: engineLabel,
            requiredComplete: !!result.requiredComplete,
            requiredOk: result.requiredOk,
            requiredTotal: result.requiredTotal,
            missingRequired: result.missingRequired || [],
            incomplete: !result.requiredComplete,
            attempts: result.attempts
        };
}

// Mode 2 / Bidder: when pendingFill tab finishes loading an apply-looking form, fill it.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab?.url) return;
    try {
        if (tabShowsBrowserErrorPage(tab)) return;
        const settings = await getSettings();
        const pending = settings.pendingFill;
        if (!pending?.autoFillWhenReady || !pending.jobUrl) return;
        if (!urlsLooselyMatch(tab.url, pending.jobUrl) && !tab.url.includes(new URL(pending.jobUrl).hostname)) {
            return;
        }

        // Claim immediately so concurrent "complete" events cannot restart fill (loop guard).
        if (inflightPendingFillTabs.has(tabId)) return;
        await saveSettings({ pendingFill: { ...pending, autoFillWhenReady: false } });
        inflightPendingFillTabs.set(tabId, Date.now());

        try {
            await ensureScripts(tabId);
            await new Promise((r) => setTimeout(r, 1500));

            // Ashby Overview (JD) has no form — navigate to .../application first.
            let liveUrl = tab.url;
            try {
                liveUrl = (await chrome.tabs.get(tabId))?.url || tab.url;
            } catch (_) { /* ignore */ }
            if (isAshbyJobDescriptionUrl(liveUrl)) {
                try {
                    if (pending.applicationId) {
                        await logCourseEvent(pending.applicationId, 'ashby_open_application', {
                            from: liveUrl
                        });
                    }
                    await ensureAshbyApplicationPage(tabId, liveUrl);
                    await new Promise((r) => setTimeout(r, 2000));
                } catch (err) {
                    console.warn('[bidder] ashby pending → application', err);
                }
            }

            const detect = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' });
            if (!detect?.ok || !detect.data?.ok) {
                // One more Ashby attempt if we landed back on Overview.
                try {
                    const again = (await chrome.tabs.get(tabId))?.url || '';
                    if (isAshbyJobDescriptionUrl(again)) {
                        await ensureAshbyApplicationPage(tabId, again);
                        await new Promise((r) => setTimeout(r, 2000));
                        const detectAshby = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' })
                            .catch(() => null);
                        if (detectAshby?.ok && detectAshby.data?.ok) {
                            /* continue fill below */
                        } else {
                            const wall = await detectCaptchaOrLogin(tabId);
                            if (!(wall.captcha || wall.login)) return;
                        }
                    }
                } catch (_) { /* fall through */ }

                const wall = await detectCaptchaOrLogin(tabId);
                if (wall.captcha || wall.login) {
                    const prefs = await getBidderPrefs();
                    const wait = await runCaptchaPassEngine({
                        tabId,
                        applicationId: pending.applicationId,
                        prefs,
                        wall,
                        phase: 'pending_fill',
                        companyLabel: pending.company || 'Job'
                    });
                    if (!wait.cleared) {
                        return;
                    }
                } else {
                    const still = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' })
                        .catch(() => null);
                    if (!still?.ok || !still.data?.ok) return;
                }
            }

            const detect2 = await chrome.tabs.sendMessage(tabId, { type: 'DETECT_APPLY_FORM' }).catch(() => null);
            if (!detect2?.ok || !detect2.data?.ok) return;

            await notify('Lumi Bidder', 'Apply form detected — full fill…');

            if (pending.fromBidder && pending.applicationId) {
                const prefs = await getBidderPrefs();
                const item = {
                    id: pending.applicationId,
                    profile_id: pending.profileId,
                    resume_filename: pending.resumeFilename,
                    company_name: pending.company,
                    job_role: pending.jobRole,
                    open_url: pending.jobUrl
                };
                await new Promise((r) => setTimeout(r, 2000));
                await uploadScreenshot(pending.applicationId, 'opened', tabId, { settleMs: 1000 });
                const stats = await runBidderFillOnTab(tabId, item, {
                    ...prefs,
                    autoSubmit: pending.autoSubmit != null ? pending.autoSubmit : prefs.autoSubmit
                });
                const settleSec = Math.max(5, Number(prefs.screenshotSettleSec) || 6);
                await new Promise((r) => setTimeout(r, settleSec * 1000));
                await uploadScreenshot(pending.applicationId, 'after_fill', tabId, { settleMs: 1200 });
                await savePackage(pending.applicationId, [], { filled: stats?.filled });
                if (stats?.submitClicked) {
                    const poll = await pollDetectSubmitSuccess(tabId, {
                        totalMs: SUBMIT_SUCCESS_POLL_MS,
                        gapMs: 800
                    });
                    if (poll.ok) {
                        await markApplicationApplied(pending.applicationId);
                        await logCourseEvent(pending.applicationId, 'marked_applied', { via: 'success_text' });
                        await uploadSuccessProofScreenshot(pending.applicationId, tabId, {
                            waitMs: 1600,
                            settleMs: 900
                        });
                        try { await chrome.tabs.remove(tabId); } catch (_) {}
                    }
                }
            } else {
                await runFillOnly({ phase: 'profile', tabId });
            }
        } finally {
            inflightPendingFillTabs.delete(tabId);
        }
    } catch (err) {
        console.warn('[bidder] pendingFill watcher', err);
        inflightPendingFillTabs.delete(tabId);
    }
});

chrome.commands.onCommand.addListener((command) => {
    if (command === 'bid-generate') {
        runBidGenerate({ alsoFill: false }).catch((err) => {
            const m = String(err?.message || err || '');
            if (/Select the job description|Could not find JD|error page|Chrome error page|Open a job posting/i.test(m)) {
                console.warn('[bidder]', m);
                return;
            }
            console.error('[bidder]', err);
        });
    }
    if (command === 'bid-fill') {
        runFillOnly({ phase: 'profile' }).catch((err) => console.error('[bidder]', err));
    }
    if (command === 'bid-select-questions') {
        (async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;
            await ensureScripts(tab.id);
            await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_QUESTION_PICKER' });
        })().catch((err) => console.error('[bidder]', err));
    }
    if (command === 'bid-select-jd') {
        (async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;
            await ensureScripts(tab.id);
            await chrome.tabs.sendMessage(tab.id, { type: 'START_JD_PICK' });
            await notify('Select JD', 'Click the job description block (or highlight text), then Alt+Shift+G');
        })().catch((err) => console.error('[bidder]', err));
    }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ENSURE_US_DIAL_CODE') {
        const tabId = msg.tabId || _sender?.tab?.id;
        ensureUsDialCodeTrusted(tabId)
            .then((ok) => sendResponse({ ok: !!ok }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'GENERATE_DONE') {
        handleGenerateDone(msg.result || {})
            .then((result) => sendResponse({ ok: true, result }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'RUN_BID_GENERATE') {
        runBidGenerate({ alsoFill: !!msg.alsoFill })
            .then((result) => sendResponse({ ok: true, result }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'RUN_FILL_ONLY') {
        runFillOnly({ phase: msg.phase || 'profile' })
            .then((result) => sendResponse({ ok: true, result }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'RUN_PROFILE_AUTOFILL') {
        runFillOnly({ phase: 'profile' })
            .then((result) => sendResponse({ ok: true, result }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'RUN_ANSWER_QUESTIONS') {
        // Auto-draft on Generate (JD + CV), then fill selected fields on the apply tab.
        runFillOnly({ phase: 'answers', answerMode: 'auto' })
            .then((result) => sendResponse({ ok: true, result }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'START_JD_PICK_ACTIVE') {
        (async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) throw new Error('No active tab');
            await ensureScripts(tab.id);
            return chrome.tabs.sendMessage(tab.id, { type: 'START_JD_PICK' });
        })()
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'JD_PICKED') {
        notify('JD captured', `${(msg.job?.description || '').length} chars — press Alt+Shift+G`)
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: true }));
        return true;
    }
    if (msg?.type === 'LIST_READY') {
        (async () => {
            const settings = await getSettings();
            return listBidderReady(msg.limit || 50, msg.profileId || settings.selectedProfileId);
        })()
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_PING') {
        const version = chrome.runtime.getManifest()?.version || '0';
        sendResponse({
            ok: true,
            version,
            extensionId: chrome.runtime.id,
            engine: 'bidder-engine-v1',
            autofillEngine: AUTOFILL_ENGINE
        });
        return false;
    }
    if (msg?.type === 'BIDDER_PROBE_CAPTCHA_HELPERS') {
        probeCaptchaHelpers()
            .then((helpers) => sendResponse({ ok: true, ...helpers }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_SAVE_PREFS') {
        (async () => {
            const prefs = msg.prefs && typeof msg.prefs === 'object' ? msg.prefs : {};
            const allowed = [
                'bidderStayInApp',
                'bidderUnattended',
                'bidderCaptchaHelper',
                'bidderCaptchaHelperWaitSec',
                'bidderCaptchaGraceSec',
                'bidderAutoSubmit',
                'bidderAutoNext',
                'bidderCaptchaFocus',
                'bidderUploadCoverLetter',
                'bidderSoundEnabled',
                'bidderCapsolverApiKey',
                'bidderTwocaptchaApiKey',
                'bidderDisabledFillLessons'
            ];
            const patch = {};
            for (const key of allowed) {
                if (prefs[key] !== undefined) patch[key] = prefs[key];
            }
            if (!Object.keys(patch).length) {
                return { ok: false, error: 'No prefs to save' };
            }
            await saveSettings(patch);
            return { ok: true, saved: Object.keys(patch) };
        })()
            .then((res) => sendResponse(res))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'REINJECT_APP_BRIDGE') {
        reinjectAppBridgeIntoAppTabs()
            .then((n) => sendResponse({
                ok: true,
                injected: n,
                version: chrome.runtime.getManifest()?.version || '0',
                extensionId: chrome.runtime.id
            }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_STATUS') {
        getBidderStatus()
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'OPEN_READY') {
        openReadyApplication(msg.item)
            .then((result) => sendResponse({ ok: true, result }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'PROCESS_READY_QUEUE') {
        const jobLinkIds = Array.isArray(msg.jobLinkIds) ? msg.jobLinkIds : [];
        const applicationIds = Array.isArray(msg.applicationIds) ? msg.applicationIds : [];
        (async () => {
            let acked = false;
            try {
                // Sync web-app session into the extension before listing ready apps.
                if (msg.token) {
                    const patch = { token: String(msg.token) };
                    if (msg.user && typeof msg.user === 'object') patch.user = msg.user;
                    if (msg.selectedProfileId != null && Number(msg.selectedProfileId) > 0) {
                        patch.selectedProfileId = Number(msg.selectedProfileId);
                    }
                    await saveSettings(patch);
                }

                const st = await getQueueState();
                const status = String(st?.status || '');
                const alreadyActive = !!(
                    st?.running
                    || /^(?:running|awaiting_captcha|awaiting_email_otp|awaiting_next)$/i.test(status)
                );
                if (alreadyActive) {
                    // Soft-ack — not a hard failure. User clicked Process again while
                    // the queue is paused on CAPTCHA / email OTP or still bidding.
                    if (/awaiting_captcha|awaiting_email_otp/i.test(status) && st?.captchaTabId) {
                        try {
                            await chrome.tabs.update(st.captchaTabId, { active: true });
                            const tab = await chrome.tabs.get(st.captchaTabId);
                            if (tab?.windowId != null) {
                                await chrome.windows.update(tab.windowId, { focused: true });
                            }
                        } catch (_) { /* tab may be gone */ }
                    }
                    const message = /awaiting_email_otp/i.test(status)
                        ? 'Queue paused on email security code — Instruct Lumi with the code (tab stays open for second Submit).'
                        : /awaiting_captcha/i.test(status)
                        ? 'Queue is paused on CAPTCHA / login — solve it in the apply tab, then Resume in Live monitor. Do not click Process again.'
                        : /awaiting_next/i.test(status)
                            ? 'Queue is waiting — click Next or Resume in Live monitor (Process already started).'
                            : 'Queue already in progress — use Live monitor (Resume / Next / Stop). Do not start Process again.';
                    sendResponse({
                        ok: true,
                        alreadyRunning: true,
                        started: true,
                        queued: Number(st?.total) || 0,
                        processed: Number(st?.processed) || 0,
                        status: status || 'running',
                        message
                    });
                    return;
                }
                const summary = await processReadyQueue({
                    jobLinkIds,
                    applicationIds,
                    uploadCoverLetter: msg.uploadCoverLetter,
                    stayInApp: msg.stayInApp,
                    unattended: msg.unattended,
                    captchaGraceSec: msg.captchaGraceSec,
                    captchaHelper: msg.captchaHelper,
                    captchaHelperWaitSec: msg.captchaHelperWaitSec,
                    disabledFillLessons: msg.disabledFillLessons,
                    onReady: (early) => {
                        if (acked) return;
                        acked = true;
                        try {
                            sendResponse(early);
                        } catch (_) { /* channel closed */ }
                    }
                });
                if (!acked) {
                    acked = true;
                    if (summary && summary.ok === false) {
                        sendResponse({
                            ok: false,
                            error: summary.error || 'No ready applications to bid',
                            processed: summary.processed || 0,
                            queued: summary.queued || 0
                        });
                    } else {
                        sendResponse({ ok: true, ...(summary || {}) });
                    }
                }
            } catch (err) {
                console.warn('[bidder] PROCESS_READY_QUEUE', err);
                if (!acked) {
                    try {
                        sendResponse({ ok: false, error: err?.message || String(err) });
                    } catch (_) { /* channel closed */ }
                }
            }
        })();
        return true;
    }
    if (msg?.type === 'BIDDER_NEXT') {
        setQueueState({ nextClicked: true, status: 'running' })
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_CAPTCHA_RESUME') {
        // Human finished CAPTCHA (or wants to force continue). Does not bypass — just unblocks wait.
        (async () => {
            const prev = await getQueueState();
            const prefs = await getBidderPrefs();
            const stayInApp = prefs.stayInApp !== false && prev?.captchaStayInApp !== false;
            let tabId = prev?.captchaTabId || null;
            if (tabId) {
                try { await chrome.tabs.get(tabId); } catch { tabId = null; }
            }
            // Reopen apply URL if the background tab was closed before Resume.
            if (!tabId && (msg.url || prev?.captchaJobUrl)) {
                const url = msg.url || prev.captchaJobUrl;
                const created = await chrome.tabs.create({ url, active: true });
                tabId = created.id;
                try {
                    if (created.windowId != null) {
                        await chrome.windows.update(created.windowId, { focused: true });
                    }
                } catch (_) { /* ignore */ }
                await chrome.storage.session.set({
                    captchaUserFocusHoldUntil: Date.now() + 10 * 60 * 1000
                });
                await setQueueState({ captchaTabId: tabId, captchaTabMissing: false });
            }
            await setQueueState({
                captchaResolved: true,
                captchaForceResume: !!msg.force,
                status: 'running'
            });
            const st = await getQueueState();
            tabId = st?.captchaTabId || tabId;
            // Focus apply tab when user is finishing CAPTCHA (or caller asked).
            if (tabId && (!stayInApp || msg.focusTab || msg.force)) {
                try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
                try {
                    const tab = await chrome.tabs.get(tabId);
                    if (tab.windowId != null) {
                        await chrome.windows.update(tab.windowId, { focused: true });
                    }
                } catch (_) { /* ignore */ }
                await chrome.storage.session.set({
                    captchaUserFocusHoldUntil: Date.now() + 10 * 60 * 1000
                });
            }
            // If the wait loop died with the MV3 service worker, Resume still kicks fill after a short delay.
            if ((msg.force || msg.kick) && tabId && st?.captchaApplicationId) {
                setTimeout(() => {
                    (async () => {
                        const now = await getQueueState();
                        if (now?.captchaApplicationId !== st.captchaApplicationId) return;
                        const wall = await detectCaptchaOrLogin(tabId);
                        if ((wall.captcha || wall.login) && !msg.force) return;
                        const p2 = await getBidderPrefs();
                        await ensureScripts(tabId);
                        await runBidderFillOnTab(tabId, {
                            id: st.captchaApplicationId,
                            company_name: 'Job',
                            job_role: ''
                        }, p2);
                        await logCourseEvent(st.captchaApplicationId, 'captcha_cleared', {
                            via: 'resume_kick',
                            engine: 'captcha-pass-v9'
                        });
                        try { await chrome.storage.session.remove('captchaUserFocusHoldUntil'); } catch (_) { /* ignore */ }
                        await setQueueState({
                            status: 'running',
                            captchaKind: null,
                            captchaTabId: null,
                            captchaApplicationId: null,
                            captchaJobUrl: null
                        });
                    })().catch((err) => console.warn('[bidder] captcha resume kick', err));
                }, 1800);
            }
            sendResponse({
                ok: true,
                wasRunning: !!prev?.running,
                stayInApp,
                captchaTabId: tabId || null,
                reopened: !prev?.captchaTabId && !!tabId
            });
        })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_CAPTCHA_FOCUS_TAB') {
        (async () => {
            const st = await getQueueState();
            const cleanUrl = (raw) => {
                const s = String(raw || '').trim();
                if (!s) return '';
                if (/[?&]error=true\b/i.test(s) || /\/embed\/job_board/i.test(s)) return '';
                if (isAshbyJobDescriptionUrl(s)) return ashbyApplicationUrl(s);
                return s;
            };
            const brokenLanding = (raw) => {
                const s = String(raw || '');
                return !s
                    || /[?&]error=true\b/i.test(s)
                    || /\/embed\/job_board/i.test(s)
                    || /^chrome:\/\//i.test(s)
                    || /^about:/i.test(s);
            };
            const wantedUrl = cleanUrl(msg.url)
                || cleanUrl(st?.currentJobUrl)
                || cleanUrl(st?.captchaJobUrl);
            const wantedAppId = Number(msg.applicationId || 0) || 0;

            const ghFor = (url) => {
                try {
                    const u = new URL(url);
                    if (!/greenhouse\.io/i.test(u.hostname)) return '';
                    const forParam = (u.searchParams.get('for') || '').toLowerCase();
                    if (forParam) return forParam;
                    // job-boards.greenhouse.io/daymark/jobs/123 → daymark
                    const m = u.pathname.match(/^\/([^/]+)(?:\/|$)/);
                    if (m && !/^(embed|jobs|job_app|s)$/i.test(m[1])) return m[1].toLowerCase();
                    return '';
                } catch {
                    return '';
                }
            };
            const ghToken = (url) => {
                try {
                    const u = new URL(url);
                    if (!/greenhouse\.io/i.test(u.hostname)) return '';
                    return u.searchParams.get('token') || '';
                } catch {
                    return '';
                }
            };
            const ghJobId = (url) => {
                try {
                    const u = new URL(url);
                    if (!/greenhouse\.io/i.test(u.hostname)) return '';
                    const tok = u.searchParams.get('token') || '';
                    if (tok) return tok;
                    const m = u.pathname.match(/\/jobs\/(\d+)/i);
                    return m ? m[1] : '';
                } catch {
                    return '';
                }
            };

            const urlsLooselySameJob = (a, b) => {
                const left = String(a || '');
                const right = String(b || '');
                if (!left || !right) return false;
                if (left === right) return true;
                const t1 = ghToken(left);
                const t2 = ghToken(right);
                if (t1 && t2) return t1 === t2;
                const id1 = ghJobId(left);
                const id2 = ghJobId(right);
                const f1 = ghFor(left);
                const f2 = ghFor(right);
                // Same Greenhouse board + same job id/token (listing URL vs embed URL).
                if (f1 && f2 && f1 === f2 && id1 && id2 && id1 === id2) return true;
                // Lever: jobs.lever.co/{company}/{uuid}[/apply]
                try {
                    const u1 = new URL(left);
                    const u2 = new URL(right);
                    const h1 = u1.hostname.replace(/^www\./, '');
                    const h2 = u2.hostname.replace(/^www\./, '');
                    if (/lever\.co$/i.test(h1) && /lever\.co$/i.test(h2)) {
                        const p1 = u1.pathname.split('/').filter(Boolean);
                        const p2 = u2.pathname.split('/').filter(Boolean);
                        if (p1[0] && p2[0] && p1[0].toLowerCase() === p2[0].toLowerCase()
                            && p1[1] && p2[1] && p1[1].toLowerCase() === p2[1].toLowerCase()) {
                            return true;
                        }
                    }
                    // Ashby: *.ashbyhq.com/{org}/... job id in path
                    if (/ashbyhq\.com$/i.test(h1) && /ashbyhq\.com$/i.test(h2)) {
                        const strip = (p) => p.replace(/\/(application|apply)\/?$/i, '').replace(/\/$/, '');
                        if (strip(u1.pathname).toLowerCase() === strip(u2.pathname).toLowerCase()) return true;
                    }
                    // Workday: same host + job path segment
                    if (/myworkdayjobs\.com|workdayjobs\.com/i.test(h1) && h1 === h2) {
                        const strip = (p) => p.replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
                        if (strip(u1.pathname) === strip(u2.pathname)) return true;
                        const jobSeg = (p) => {
                            const m = p.match(/\/job\/([^/]+)/i) || p.match(/\/(\d{4,})(?:\/|$)/);
                            return m ? m[1].toLowerCase() : '';
                        };
                        const j1 = jobSeg(u1.pathname);
                        const j2 = jobSeg(u2.pathname);
                        if (j1 && j2 && j1 === j2) return true;
                    }
                    const normH = (h) => h.replace(/^www\./, '').replace(/^job-boards\./, 'boards.');
                    if (normH(h1) === normH(h2)
                        && u1.pathname.replace(/\/$/, '') === u2.pathname.replace(/\/$/, '')) {
                        return true;
                    }
                    // Same company careers host + same path prefix (custom ATS like Evio)
                    if (normH(h1) === normH(h2)) {
                        const base = (p) => p.replace(/\/(apply|application|jobs?)\/?$/i, '').replace(/\/$/, '').toLowerCase();
                        if (base(u1.pathname) && base(u1.pathname) === base(u2.pathname)) return true;
                    }
                } catch {
                    /* ignore */
                }
                return false;
            };

            const looksLikeApplyTab = (url) => {
                const s = String(url || '');
                if (!s || brokenLanding(s)) return false;
                return /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.|icims\.com|smartrecruiters\.com|bamboohr\.com|oraclecloud\.com|job-boards\.|\/apply|\/application|\/jobs\//i.test(s);
            };

            const tabMatchesWanted = (tabUrl) => {
                if (!wantedUrl) return true;
                return urlsLooselySameJob(tabUrl, wantedUrl);
            };

            async function tabAlive(id) {
                if (!id) return null;
                try {
                    return await chrome.tabs.get(id);
                } catch {
                    return null;
                }
            }

            async function focusTab(tab) {
                await chrome.tabs.update(tab.id, { active: true });
                if (tab.windowId != null) {
                    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) { /* ignore */ }
                }
            }

            let reopened = false;
            let navigated = false;
            let focusedExisting = false;
            let tabId = null;
            let tabUrl = '';

            // 0) Tab remembered for this applicationId (survives queue moving to another job)
            if (wantedAppId) {
                const mapped = Number(st?.tabsByAppId?.[String(wantedAppId)] || 0) || 0;
                if (mapped) {
                    const t = await tabAlive(mapped);
                    const u = t ? (t.pendingUrl || t.url || '') : '';
                    // NEVER focus another job's apply tab just because it "looks like apply".
                    if (t && (!wantedUrl || tabMatchesWanted(u))) {
                        await focusTab(t);
                        tabId = t.id;
                        tabUrl = u;
                        focusedExisting = true;
                    }
                }
            }

            // 1) Prefer exact Live-monitor / queue tabs — only if they match THIS job URL.
            if (!focusedExisting) {
                const preferredIds = [
                    msg.tabId,
                    wantedAppId && String(st?.currentId) === String(wantedAppId) ? st?.captchaTabId : null,
                    wantedAppId && String(st?.currentId) === String(wantedAppId) ? st?.currentTabId : null,
                    !wantedAppId ? st?.captchaTabId : null,
                    !wantedAppId ? st?.currentTabId : null
                ].map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);

                for (const id of preferredIds) {
                    const t = await tabAlive(id);
                    if (!t) continue;
                    const u = t.pendingUrl || t.url || '';
                    if (brokenLanding(u) && !looksLikeApplyTab(u)) continue;
                    if (wantedUrl && !tabMatchesWanted(u)) continue;
                    await focusTab(t);
                    tabId = t.id;
                    tabUrl = u;
                    focusedExisting = true;
                    break;
                }
            }

            // 2) Search existing apply tabs — MUST match wanted URL when provided.
            if (!focusedExisting) {
                try {
                    const bgId = (await chrome.storage.session.get(['bidderBgWindowId']))?.bidderBgWindowId;
                    const pools = [];
                    if (bgId) {
                        try { pools.push({ tabs: await chrome.tabs.query({ windowId: bgId }), bidderWin: true }); } catch (_) { /* ignore */ }
                    }
                    pools.push({ tabs: await chrome.tabs.query({}), bidderWin: false });
                    const seen = new Set();
                    const wantedTok = ghToken(wantedUrl);
                    const wantedJob = ghJobId(wantedUrl);
                    outer: for (const pool of pools) {
                        for (const t of pool.tabs || []) {
                            if (!t?.id || seen.has(t.id)) continue;
                            seen.add(t.id);
                            const u = t.pendingUrl || t.url || '';
                            if (!looksLikeApplyTab(u) && wantedUrl && !tabMatchesWanted(u)) continue;
                            if (!wantedUrl) continue;
                            const match = urlsLooselySameJob(u, wantedUrl)
                                || (wantedTok && ghToken(u) === wantedTok)
                                || (wantedJob && ghJobId(u) === wantedJob && ghFor(u) === ghFor(wantedUrl));
                            if (!match) continue;
                            await focusTab(t);
                            tabId = t.id;
                            tabUrl = u;
                            focusedExisting = true;
                            break outer;
                        }
                    }
                } catch (_) { /* ignore */ }
            }

            // 3) Last resort: open/reopen THIS job's URL — never focus a random other apply tab.
            if (!focusedExisting && msg.preferExistingTab !== false && !wantedUrl) {
                try {
                    const all = await chrome.tabs.query({});
                    const applyTabs = (all || [])
                        .filter((t) => looksLikeApplyTab(t?.pendingUrl || t?.url || ''))
                        .sort((a, b) => (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0));
                    if (applyTabs[0]?.id) {
                        await focusTab(applyTabs[0]);
                        tabId = applyTabs[0].id;
                        tabUrl = applyTabs[0].pendingUrl || applyTabs[0].url || '';
                        focusedExisting = true;
                    }
                } catch (_) { /* ignore */ }
            }

            if (!focusedExisting) {
                if (!wantedUrl) {
                    throw new Error(
                        'No live apply tab found for this job and no URL to reopen. Select the Bid course, then Process again.'
                    );
                }
                // Never open LinkedIn / non-apply source pages as the "apply tab".
                if (/linkedin\.com/i.test(wantedUrl)) {
                    throw new Error(
                        'Open tab would launch a LinkedIn/source URL, not the filled apply form. Process again so Lumi keeps the apply tab.'
                    );
                }
                let created = null;
                try {
                    const bgWin = await getOrCreateBidderBgWindow();
                    if (bgWin?.id) {
                        created = await chrome.tabs.create({
                            windowId: bgWin.id,
                            url: wantedUrl,
                            active: true
                        });
                        try { await chrome.windows.update(bgWin.id, { focused: true }); } catch (_) { /* ignore */ }
                    }
                } catch (_) { /* ignore */ }
                if (!created?.id) {
                    created = await chrome.tabs.create({ url: wantedUrl, active: true });
                }
                tabId = created.id;
                tabUrl = wantedUrl;
                reopened = true;
            }

            const patch = {
                currentTabId: tabId,
                captchaTabMissing: false
            };
            if (wantedAppId) patch.currentId = wantedAppId;
            if (wantedUrl && !/linkedin\.com/i.test(wantedUrl)) patch.currentJobUrl = wantedUrl;
            else if (tabUrl && looksLikeApplyTab(tabUrl)) patch.currentJobUrl = tabUrl;
            if (wantedAppId && tabId) {
                patch.tabsByAppId = {
                    ...(st?.tabsByAppId || {}),
                    [String(wantedAppId)]: tabId
                };
            }
            if (st?.status === 'awaiting_captcha' || st?.captchaTabId || focusedExisting || reopened) {
                patch.captchaTabId = tabId;
                if (patch.currentJobUrl) patch.captchaJobUrl = patch.currentJobUrl;
                if (wantedAppId) patch.captchaApplicationId = wantedAppId;
                if (st?.status === 'awaiting_captcha') patch.status = 'awaiting_captcha';
            }
            await setQueueState(patch);

            await chrome.storage.session.set({
                captchaUserFocusHoldUntil: Date.now() + 10 * 60 * 1000
            });
            sendResponse({
                ok: true,
                tabId,
                reopened,
                navigated,
                focusedExisting,
                applicationId: wantedAppId || null,
                url: patch.currentJobUrl || tabUrl || null
            });
        })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_CAPTCHA_SKIP') {
        (async () => {
            const st = await getQueueState();
            await setQueueState({
                captchaAbandonRequested: true,
                captchaResolved: false,
                status: st?.status === 'awaiting_captcha' ? 'awaiting_captcha' : 'running'
            });
            // If wait loop already dead, clear stuck banner + close leftover tab.
            if (st?.captchaTabId) {
                try { await chrome.tabs.remove(st.captchaTabId); } catch (_) { /* ignore */ }
            }
            try { await chrome.storage.session.remove('captchaUserFocusHoldUntil'); } catch (_) { /* ignore */ }
            if (st?.captchaApplicationId) {
                await logCourseEvent(st.captchaApplicationId, 'captcha_abandoned', {
                    via: 'user_skip',
                    engine: 'captcha-pass-v9'
                }).catch(() => {});
            }
            await setQueueState({
                status: 'running',
                captchaKind: null,
                captchaTabId: null,
                captchaApplicationId: null,
                captchaJobUrl: null,
                captchaTabMissing: false,
                captchaAbandonRequested: false,
                nextClicked: true
            });
            sendResponse({ ok: true, skipped: true });
        })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    // Manual re-run of bidder fill on the current apply tab (FILLED / incomplete / post-CAPTCHA).
    if (msg?.type === 'BIDDER_LIST_QUESTIONS') {
        (async () => {
            try {
                const st = await getQueueState();
                let tabId = Number(msg.tabId || st?.currentTabId || st?.captchaTabId || 0) || null;
                if (tabId) {
                    try { await chrome.tabs.get(tabId); } catch { tabId = null; }
                }
                if (!tabId) {
                    sendResponse({ ok: false, error: 'No apply tab open. Process or Open tab first.' });
                    return;
                }
                await ensureScripts(tabId);
                const form = await collectForm(tabId).catch(() => null);
                const questions = Array.isArray(form?.questions) ? form.questions : [];
                sendResponse({
                    ok: true,
                    tabId,
                    questions: questions.map((q) => ({
                        id: String(q.id || q.label || ''),
                        label: String(q.label || q.id || 'Question'),
                        type: q.type || 'text',
                        kind: q.kind || q.answer_type || 'written',
                        answer: ''
                    }))
                });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg?.type === 'BIDDER_APPLY_ANSWERS') {
        (async () => {
            try {
                const answersIn = Array.isArray(msg.answers) ? msg.answers : [];
                const answers = answersIn
                    .map((a) => ({
                        id: String(a?.id || a?.label || '').trim(),
                        label: String(a?.label || a?.id || '').trim(),
                        answer: String(a?.answer ?? a?.value ?? '').trim(),
                        type: a?.type || 'text',
                        kind: a?.kind || a?.answer_type || 'written'
                    }))
                    .filter((a) => a.label || a.id);
                if (!answers.length) {
                    sendResponse({ ok: false, error: 'No answers to apply' });
                    return;
                }
                const st = await getQueueState();
                const prefs = await getBidderPrefs();
                const appId = Number(
                    msg.applicationId
                    || st?.currentId
                    || st?.captchaApplicationId
                    || st?.lastApplicationId
                    || 0
                ) || null;
                let tabId = Number(msg.tabId || st?.currentTabId || st?.captchaTabId || 0) || null;
                if (tabId) {
                    try { await chrome.tabs.get(tabId); } catch { tabId = null; }
                }
                if (!tabId) {
                    sendResponse({ ok: false, error: 'No apply tab open. Process or Open tab first.' });
                    return;
                }
                await ensureScripts(tabId);
                await ensureApplyFormVisible(tabId);
                const fillResp = await fillAndUpload(tabId, {
                    answers,
                    autoSubmit: false,
                    answersOnly: true,
                    engine: 'control-panel-answers'
                });
                if (appId) {
                    await savePackage(appId, answers, {
                        filled: fillResp?.fillStats?.filled,
                        source: 'control_panel',
                        ats: fillResp?.ats || null
                    }).catch(() => {});
                    await logCourseEvent(appId, 'answers_applied_from_panel', {
                        count: answers.length,
                        filled: fillResp?.fillStats?.filled || 0
                    }).catch(() => {});
                    await uploadScreenshot(appId, 'live', tabId, {
                        settleMs: 200,
                        stayInApp: true
                    }).catch(() => {});
                }
                sendResponse({
                    ok: true,
                    filled: fillResp?.fillStats?.filled || 0,
                    tabId,
                    applicationId: appId,
                    answersCount: answers.length
                });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg?.type === 'BIDDER_INSTRUCT') {
        (async () => {
            try {
                const instruction = String(msg.instruction || '').trim();
                if (!instruction) {
                    sendResponse({ ok: false, error: 'Instruction is empty' });
                    return;
                }
                const st = await getQueueState();
                const prefs = await getBidderPrefs();
                const appId = Number(
                    msg.applicationId
                    || st?.currentId
                    || st?.captchaApplicationId
                    || st?.lastApplicationId
                    || 0
                ) || null;
                let tabId = Number(msg.tabId || st?.currentTabId || st?.captchaTabId || 0) || null;
                if (tabId) {
                    try { await chrome.tabs.get(tabId); } catch { tabId = null; }
                }
                if (!tabId) {
                    sendResponse({ ok: false, error: 'No apply tab open. Process or Open tab first.' });
                    return;
                }
                await ensureScripts(tabId);
                await ensureApplyFormVisible(tabId);

                let host = '';
                try {
                    const tab = await chrome.tabs.get(tabId);
                    host = new URL(tab.url || '').hostname.replace(/^www\./i, '');
                } catch (_) { /* ignore */ }

                const snap = await collectForm(tabId).catch(() => null);
                const bidderSnap = await sendTabMessage(tabId, { type: 'BIDDER_ENGINE_COLLECT' }).catch(() => null);
                const fieldRows = Array.isArray(bidderSnap?.fields) && bidderSnap.fields.length
                    ? bidderSnap.fields
                    : (Array.isArray(snap?.fields) ? snap.fields : []);

                await logCourseEvent(appId, 'user_instruction', {
                    instruction: instruction.slice(0, 400),
                    host,
                    field_count: fieldRows.length
                }).catch(() => {});
                await notify('Lumi', `Instruction: ${instruction.slice(0, 80)}`);

                const interpreted = await interpretBidderInstruction({
                    instruction,
                    application_id: appId,
                    host,
                    ats: snap?.ats || bidderSnap?.ats || '',
                    fields: fieldRows.map((f) => ({
                        id: f.id,
                        label: f.label,
                        value: f.value ?? '',
                        required: !!f.required
                    })),
                    missing_required: bidderSnap?.missingRequired || snap?.missingRequired || []
                });

                if (!interpreted?.ok && !interpreted?.fills?.length && !interpreted?.clickSubmit) {
                    sendResponse({
                        ok: false,
                        error: interpreted?.summary || interpreted?.error || 'Could not apply instruction',
                        summary: interpreted?.summary || null
                    });
                    return;
                }

                const fills = Array.isArray(interpreted.fills) ? interpreted.fills : [];
                let filled = 0;
                // Keep alphanumeric Greenhouse codes (e.g. wFY53Ht3) — do NOT strip letters.
                let otpCode = String(
                    interpreted.emailOtp
                    || fills.find((f) => f.answer_type === 'email_otp' || /security|otp|verif|code/i.test(f.label || ''))?.answer
                    || ''
                ).replace(/[^A-Za-z0-9]/g, '').trim();
                if (!otpCode) {
                    const m = instruction.match(
                        /(?:(?:this\s+is\s+(?:the\s+)?)?code|security\s*code|otp)\s*(?:is|:|=)?\s*([A-Za-z0-9]{4,12})\b/i
                    ) || instruction.match(/^\s*([A-Za-z0-9]{4,12})\s*$/);
                    if (m?.[1]) otpCode = m[1];
                }

                // Prefer dedicated OTP injector (Greenhouse React) over generic written fill.
                if (otpCode && otpCode.length >= 4 && otpCode.length <= 12) {
                    let otpOk = false;
                    const r = await fillEmailSecurityCode(tabId, otpCode).catch(() => null);
                    otpOk = !!r?.filled;
                    if (otpOk) filled += 1;
                    if (!otpOk) {
                        const fillResp = await fillAndUpload(tabId, {
                            answers: [{
                                id: fills[0]?.id || 'email_otp',
                                label: fills[0]?.label || 'Security code',
                                answer: otpCode,
                                answer_type: 'written',
                                source: 'user_instruct'
                            }],
                            autoSubmit: false,
                            answersOnly: true,
                            engine: 'instruct-lumi-otp'
                        });
                        filled += fillResp?.fillStats?.filled || 0;
                    }
                    await new Promise((r) => setTimeout(r, 600));
                } else if (fills.length) {
                    const fillResp = await fillAndUpload(tabId, {
                        answers: fills.map((f) => ({
                            id: f.id || f.label,
                            label: f.label,
                            answer: f.answer,
                            answer_type: 'written',
                            source: 'user_instruct'
                        })),
                        autoSubmit: false,
                        answersOnly: true,
                        engine: 'instruct-lumi'
                    });
                    filled = fillResp?.fillStats?.filled || 0;
                }

                let submitClicked = false;
                if (interpreted.clickSubmit || otpCode || fills.length) {
                    // Always force after OTP — required-field scan often still sees empty React inputs.
                    const force = !!(interpreted.clickSubmit || otpCode);
                    const sub = await sendTabMessage(tabId, {
                        type: 'BIDDER_ENGINE_SUBMIT',
                        force
                    }).catch(() => null);
                    submitClicked = !!sub?.clicked;
                    if (!submitClicked) {
                        const sub2 = await sendTabMessage(tabId, { type: 'CLICK_SUBMIT' }).catch(() => null);
                        submitClicked = !!sub2?.clicked || !!sub2?.submitStats?.clicked;
                    }
                    // Greenhouse sometimes uses Confirm / Verify instead of Submit
                    if (!submitClicked && otpCode) {
                        const conf = await clickPostOtpSubmit(tabId).catch(() => null);
                        submitClicked = !!conf?.clicked;
                    }
                }

                await saveFillLesson({
                    host,
                    fieldKey: interpreted.fieldKey || 'form',
                    issueKey: interpreted.issueKey || 'user_instruct',
                    instruction,
                    actions: { fills, clickSubmit: !!interpreted.clickSubmit },
                    ats: snap?.ats || '',
                    source: 'user_instruct'
                }).catch(() => {});
                await saveBidderFillLesson({
                    host,
                    field_key: interpreted.fieldKey || 'form',
                    issue_key: interpreted.issueKey || 'user_instruct',
                    instruction,
                    actions: { fills, clickSubmit: !!interpreted.clickSubmit },
                    ats: snap?.ats || '',
                    source: 'user_instruct'
                }).catch(() => {});

                if (appId) {
                    await logCourseEvent(appId, 'instruction_applied', {
                        filled,
                        submitClicked,
                        summary: interpreted.summary || null,
                        fieldKey: interpreted.fieldKey || null,
                        issueKey: interpreted.issueKey || null
                    }).catch(() => {});
                    await uploadScreenshot(appId, 'live', tabId, {
                        settleMs: 200,
                        stayInApp: true
                    }).catch(() => {});
                }

                let success = false;
                if (submitClicked) {
                    await new Promise((r) => setTimeout(r, 2000));
                    success = await detectSubmitSuccess(tabId);
                    if (success && appId) {
                        await markApplicationApplied(appId);
                        await logCourseEvent(appId, 'marked_applied', { via: 'instruct' }).catch(() => {});
                        await setQueueState({
                            status: 'running',
                            captchaKind: null,
                            captchaTabId: null,
                            captchaApplicationId: null,
                            coachStatus: null
                        }).catch(() => {});
                        await notify('Lumi', 'SUCCESS — thank-you');
                    } else {
                        await notify('Lumi', submitClicked
                            ? (otpCode
                                ? 'Code filled + Submit clicked — check thank-you page'
                                : 'Instruction applied — submit clicked')
                            : 'Instruction applied');
                    }
                } else {
                    await notify('Lumi', `Instruction applied · ${filled} fields`);
                }

                await setQueueState({
                    coachStatus: success
                        ? 'Learned — instruction led to SUCCESS'
                        : `Learned — ${interpreted.fieldKey || 'fix'} · ${host || 'host'}`,
                    coachAt: Date.now(),
                    lastStatusEvent: success ? 'marked_applied' : 'instruction_applied',
                    lastStatusAt: Date.now()
                }).catch(() => {});

                sendResponse({
                    ok: true,
                    filled,
                    submitClicked,
                    success,
                    tabId,
                    applicationId: appId,
                    summary: interpreted.summary || 'Instruction applied',
                    coach: success ? 'Learned — SUCCESS' : `Learned — ${interpreted.fieldKey || 'fix'}`
                });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
        })();
        return true;
    }

    if (msg?.type === 'BIDDER_REAUTOFILL') {
        (async () => {
            const st = await getQueueState();
            const prefs = await getBidderPrefs();
            const appId = Number(
                msg.applicationId
                || st?.currentId
                || st?.captchaApplicationId
                || st?.lastApplicationId
                || 0
            ) || null;
            const cleanUrl = (raw) => {
                const s = String(raw || '').trim();
                if (!s) return '';
                if (/[?&]error=true\b/i.test(s) || /\/embed\/job_board/i.test(s)) return '';
                if (isAshbyJobDescriptionUrl(s)) return ashbyApplicationUrl(s);
                return s;
            };
            const wantedUrl = cleanUrl(msg.url)
                || cleanUrl(st?.currentJobUrl)
                || cleanUrl(st?.captchaJobUrl);
            let tabId = await resolveOpenApplyTabId({
                tabId: Number(msg.tabId || st?.currentTabId || st?.captchaTabId || 0) || null,
                applicationId: appId,
                url: wantedUrl
            });
            let reopened = false;
            if (!tabId && wantedUrl) {
                const created = await chrome.tabs.create({ url: wantedUrl, active: true });
                tabId = created.id;
                reopened = true;
                try {
                    if (created.windowId != null) {
                        await chrome.windows.update(created.windowId, { focused: true });
                    }
                } catch (_) { /* ignore */ }
            }
            if (tabId) {
                await setQueueState({
                    currentTabId: tabId,
                    currentJobUrl: wantedUrl || undefined,
                    captchaTabMissing: false,
                    ...(appId
                        ? {
                            tabsByAppId: {
                                ...(st?.tabsByAppId || {}),
                                [String(appId)]: tabId
                            }
                        }
                        : {})
                });
            }
            if (!tabId || !appId) {
                sendResponse({
                    ok: false,
                    error: 'No active apply job to re-autofill. Process a job first (or Open tab), then try again.'
                });
                return;
            }
            try {
                await chrome.tabs.update(tabId, { active: true });
                const tab = await chrome.tabs.get(tabId);
                if (tab.windowId != null) {
                    await chrome.windows.update(tab.windowId, { focused: true });
                }
            } catch (_) { /* ignore */ }
            await setQueueState({
                status: 'running',
                reautofilling: true,
                currentTabId: tabId,
                currentId: appId
            });
            await logCourseEvent(appId, 'reautofill_started', {
                tabId,
                reopened,
                via: 'ui'
            }).catch(() => {});
            try {
                const injected = await ensureScripts(tabId);
                if (!injected) {
                    const still = await chrome.tabs.get(tabId).catch(() => null);
                    if (!still) throw Object.assign(new Error('Tab closed'), { tabClosed: true });
                }
                // Give a reopened / Ready panel tab a moment to paint the form.
                await new Promise((r) => setTimeout(r, reopened ? 1800 : 600));
                await ensureScripts(tabId);
                await ensureApplyFormVisible(tabId).catch(() => {});
                const result = await runBidderFillOnTab(tabId, {
                    id: appId,
                    company_name: 'Job',
                    job_role: ''
                }, {
                    ...prefs,
                    bidDeadline: Date.now() + BID_HARD_LIMIT_MS
                });
                await logCourseEvent(appId, 'reautofill_done', {
                    filled: result?.filled || 0,
                    submitClicked: !!result?.submitClicked,
                    incomplete: !!result?.incomplete,
                    requiredOk: result?.requiredOk,
                    requiredTotal: result?.requiredTotal,
                    reopened
                }).catch(() => {});
                await uploadScreenshot(appId, 'reautofill_after', tabId, { stayInApp: true }).catch(() => {});
                const prevStatus = String(st?.status || '');
                await setQueueState({
                    reautofilling: false,
                    status: /awaiting_next/i.test(prevStatus) ? 'awaiting_next' : 'running',
                    currentTabId: tabId
                });
                sendResponse({
                    ok: true,
                    filled: result?.filled || 0,
                    submitClicked: !!result?.submitClicked,
                    incomplete: !!result?.incomplete,
                    tabId,
                    applicationId: appId,
                    reopened
                });
            } catch (err) {
                await setQueueState({ reautofilling: false }).catch(() => {});
                await logCourseEvent(appId, 'reautofill_failed', {
                    error: err?.message || String(err)
                }).catch(() => {});
                throw err;
            }
        })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }

    if (msg?.type === 'BIDDER_UPDATE_STATE' || msg?.type === 'BIDDER_SUBMIT') {
        (async () => {
            const st = await getQueueState();
            const prefs = await getBidderPrefs();
            const appId = Number(
                msg.applicationId
                || st?.currentId
                || st?.captchaApplicationId
                || st?.lastApplicationId
                || 0
            ) || null;

            const cleanUrl = (raw) => {
                const s = String(raw || '').trim();
                if (!s) return '';
                if (/[?&]error=true\b/i.test(s) || /\/embed\/job_board/i.test(s)) return '';
                if (isAshbyJobDescriptionUrl(s)) return ashbyApplicationUrl(s);
                return s;
            };
            const urlHint = cleanUrl(msg.url)
                || cleanUrl(st?.currentJobUrl)
                || cleanUrl(st?.captchaJobUrl)
                || '';

            const candidateIds = [
                Number(msg.tabId || 0) || 0,
                appId ? (Number(st?.tabsByAppId?.[String(appId)] || 0) || 0) : 0,
                Number(st?.currentTabId || 0) || 0,
                Number(st?.captchaTabId || 0) || 0,
                Number(st?.lastTabId || 0) || 0
            ].filter(Boolean);

            const aliveTabs = [];
            for (const id of [...new Set(candidateIds)]) {
                try {
                    const t = await chrome.tabs.get(id);
                    if (t?.id) aliveTabs.push(t);
                } catch (_) { /* gone */ }
            }

            // Prefer a tab that already shows thank-you / Application submitted!
            // Only among URL-matching candidates when we have a job URL hint —
            // never treat "customer success" form copy on a random tab as SUCCESS.
            let tabId = null;
            const preferSuccessAmong = async (tabs) => {
                for (const t of tabs) {
                    if (!t?.id) continue;
                    if (await detectSubmitSuccess(t.id).catch(() => false)) {
                        return t.id;
                    }
                }
                return null;
            };
            const urlMatchedAlive = urlHint
                ? aliveTabs.filter((t) => {
                    const u = t.pendingUrl || t.url || '';
                    return urlsLooselyMatch(u, urlHint) || String(u).includes(
                        (() => { try { return new URL(urlHint).hostname.replace(/^www\./i, ''); } catch (_) { return ''; } })()
                    );
                })
                : aliveTabs;
            tabId = await preferSuccessAmong(urlMatchedAlive.length ? urlMatchedAlive : []);
            if (!tabId && urlHint) {
                let hintHost = '';
                try { hintHost = new URL(urlHint).hostname.replace(/^www\./i, ''); } catch (_) { /* ignore */ }
                const all = await chrome.tabs.query({}).catch(() => []);
                const hostMatched = [];
                for (const t of all || []) {
                    if (!t?.id || !t.url || /^(chrome|edge|about|devtools):/i.test(t.url)) continue;
                    const hostOk = !hintHost || String(t.url).includes(hintHost)
                        || urlsLooselyMatch(t.url, urlHint);
                    if (!hostOk) continue;
                    hostMatched.push(t);
                    if (!aliveTabs.some((a) => a.id === t.id)) aliveTabs.push(t);
                }
                tabId = await preferSuccessAmong(hostMatched);
            }
            if (!tabId) tabId = (urlMatchedAlive[0] || aliveTabs[0])?.id || null;

            if (!tabId) {
                sendResponse({
                    ok: false,
                    error: 'No apply tab open. Open tab or Process first.'
                });
                return;
            }

            // CRITICAL: detect success BEFORE ensureApplyFormVisible — that helper
            // clicks Apply again and leaves the thank-you page for a blank form.
            let detect = await detectSubmitSuccessDetail(tabId).catch(() => ({ ok: false }));
            let success = !!detect?.ok;
            if (!success) {
                await clearFalseSuccessOutlines(tabId).catch(() => {});
                await ensureScripts(tabId).catch(() => {});
                await ensureApplyFormVisible(tabId).catch(() => {});
                detect = await detectSubmitSuccessDetail(tabId).catch(() => ({ ok: false }));
                success = !!detect?.ok;
            } else {
                await ensureScripts(tabId).catch(() => {});
            }

            if (msg.type === 'BIDDER_UPDATE_STATE') {
                let requiredOk = null;
                let requiredTotal = null;
                let missing = [];
                let incomplete = null;
                if (!success) {
                    try {
                        const snap = await sendTabMessage(tabId, {
                            type: 'BIDDER_ENGINE_COLLECT'
                        }).catch(() => null);
                        const fields = Array.isArray(snap?.fields) ? snap.fields : [];
                        const required = fields.filter((f) => f.required);
                        requiredTotal = required.length;
                        const empty = required.filter((f) => !String(f.value || '').trim());
                        requiredOk = requiredTotal - empty.length;
                        missing = empty.map((f) => f.label || f.id).filter(Boolean).slice(0, 12);
                        incomplete = empty.length > 0;
                    } catch (_) { /* ignore */ }
                    // Radios-only Ashby pages may report 0 "fields" — still incomplete.
                    if (incomplete == null && /form_still_open/i.test(String(detect?.reason || ''))) {
                        incomplete = true;
                        if (requiredTotal == null) {
                            requiredTotal = Number(detect?.radioCount) || 0;
                            requiredOk = 0;
                        }
                    }
                }

                let statusEvent = 'state_refreshed';
                if (success) statusEvent = 'marked_applied';
                else if (incomplete) statusEvent = 'fill_incomplete';
                else statusEvent = 'ready_to_submit';

                if (appId) {
                    if (success) {
                        try {
                            await markApplicationApplied(appId);
                        } catch (err) {
                            console.warn('[bidder] markApplicationApplied failed', err);
                        }
                        await logCourseEvent(appId, 'marked_applied', {
                            via: 'control_update_state',
                            success: true
                        }).catch((err) => console.warn('[bidder] marked_applied log failed', err));
                        await uploadSuccessProofScreenshot(appId, tabId, {
                            stayInApp: true,
                            waitMs: 600
                        }).catch(() =>
                            uploadScreenshot(appId, 'after_submit', tabId, {
                                settleMs: 200,
                                stayInApp: true
                            })
                        );
                    } else {
                        // Clear prior false SUCCESS (customer-success regex, latch, DB applied).
                        await clearFalseSuccessOutlines(tabId).catch(() => {});
                        try {
                            await clearFalseApplicationSuccess(appId);
                        } catch (_) { /* ignore */ }
                        await logCourseEvent(appId, 'success_revoked', {
                            via: 'control_update_state',
                            reason: detect?.reason || (incomplete ? 'fill_incomplete' : 'not_thank_you'),
                            radioCount: detect?.radioCount,
                            visibleFieldCount: detect?.visibleFieldCount
                        }).catch(() => {});
                        await logCourseEvent(appId, statusEvent, {
                            via: 'control_update_state',
                            success: false,
                            incomplete: !!incomplete,
                            requiredOk,
                            requiredTotal,
                            missing
                        }).catch(() => {});
                        await uploadScreenshot(appId, 'live', tabId, {
                            settleMs: 200,
                            stayInApp: true
                        }).catch(() => {});
                    }
                }
                await setQueueState({
                    lastStatusEvent: statusEvent,
                    lastStatusAt: Date.now(),
                    lastStatusMeta: {
                        success: !!success,
                        incomplete: incomplete == null ? undefined : !!incomplete,
                        requiredOk,
                        requiredTotal,
                        missing,
                        detectReason: detect?.reason || null
                    },
                    liveShotAt: Date.now(),
                    currentTabId: tabId,
                    currentId: appId || st?.currentId,
                    ...(appId ? {
                        tabsByAppId: {
                            ...(st?.tabsByAppId || {}),
                            [String(appId)]: tabId
                        }
                    } : {})
                }).catch(() => {});

                sendResponse({
                    ok: true,
                    success: !!success,
                    revoked: !success,
                    incomplete,
                    requiredOk,
                    requiredTotal,
                    missing,
                    statusEvent,
                    detectReason: detect?.reason || null,
                    tabId,
                    applicationId: appId
                });
                return;
            }

            // BIDDER_SUBMIT — if already on thank-you, just mark SUCCESS.
            if (success) {
                if (appId) {
                    try { await markApplicationApplied(appId); } catch (_) { /* ignore */ }
                    await logCourseEvent(appId, 'marked_applied', {
                        via: 'control_submit_already_done'
                    }).catch(() => {});
                    await uploadSuccessProofScreenshot(appId, tabId, {
                        stayInApp: true,
                        waitMs: 400
                    }).catch(() => {});
                }
                await setQueueState({
                    lastStatusEvent: 'marked_applied',
                    lastStatusAt: Date.now(),
                    liveShotAt: Date.now(),
                    currentTabId: tabId
                }).catch(() => {});
                sendResponse({
                    ok: true,
                    clicked: false,
                    success: true,
                    alreadySubmitted: true,
                    tabId,
                    applicationId: appId
                });
                return;
            }

            const force = msg.force !== false;
            let sub = await sendTabMessage(tabId, {
                type: 'BIDDER_ENGINE_SUBMIT',
                force
            }).catch(() => null);
            if (!sub?.clicked) {
                sub = await sendTabMessage(tabId, { type: 'CLICK_SUBMIT' }).catch(() => null);
            }
            const clicked = !!(sub?.clicked);
            if (appId) {
                await logCourseEvent(appId, clicked ? 'submit_clicked' : 'submit_no_click', {
                    via: 'control_submit',
                    force: !!force,
                    ...(sub || {})
                }).catch(() => {});
            }
            if (!clicked) {
                await setQueueState({
                    lastStatusEvent: 'submit_no_click',
                    lastStatusAt: Date.now(),
                    lastStatusMeta: {
                        reason: sub?.reason || 'no_submit_control',
                        missing: sub?.missing || []
                    },
                    currentTabId: tabId
                }).catch(() => {});
                sendResponse({
                    ok: false,
                    clicked: false,
                    error: sub?.reason === 'required_incomplete'
                        ? `Submit blocked — missing: ${(sub.missing || []).slice(0, 4).join('; ') || 'required fields'}`
                        : (sub?.reason || sub?.error || 'Could not find Submit on the apply tab'),
                    missing: sub?.missing || [],
                    tabId,
                    applicationId: appId
                });
                return;
            }

            await new Promise((r) => setTimeout(r, 2200));
            success = await detectSubmitSuccess(tabId).catch(() => false);
            if (appId) {
                if (success) {
                    try { await markApplicationApplied(appId); } catch (_) { /* ignore */ }
                    await logCourseEvent(appId, 'marked_applied', { via: 'control_submit' }).catch(() => {});
                    await uploadSuccessProofScreenshot(appId, tabId, {
                        stayInApp: true,
                        waitMs: 800
                    }).catch(() =>
                        uploadScreenshot(appId, 'after_submit', tabId, { stayInApp: true })
                    );
                } else {
                    await logCourseEvent(appId, 'needs_manual', {
                        reason: 'submit_no_thanks',
                        via: 'control_submit'
                    }).catch(() => {});
                    await uploadScreenshot(appId, 'live', tabId, {
                        settleMs: 200,
                        stayInApp: true
                    }).catch(() => {});
                }
            }
            await setQueueState({
                lastStatusEvent: success ? 'marked_applied' : 'submit_clicked',
                lastStatusAt: Date.now(),
                liveShotAt: Date.now(),
                currentTabId: tabId
            }).catch(() => {});
            if (prefs.stayInApp) {
                try { await refocusStayInAppHome(); } catch (_) { /* ignore */ }
            }
            sendResponse({
                ok: true,
                clicked: true,
                success: !!success,
                tabId,
                applicationId: appId,
                submit: sub || null
            });
        })().catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }

    if (msg?.type === 'BIDDER_STOP') {
        setQueueState({
            stopRequested: true,
            running: false,
            status: 'stopped',
            queueEndedAt: Date.now()
        })
            .then(() => releaseQueueLock())
            .then(() => sendResponse({ ok: true }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'BIDDER_QUEUE_STATE') {
        Promise.all([getQueueState(), getUiMessageLog()])
            .then(([data, uiMessageLog]) => {
                const st = data || {};
                const appId = st.currentId || st.captchaApplicationId || st.lastApplicationId;
                const runRow = appId && st.runByAppId
                    ? st.runByAppId[String(appId)]
                    : null;
                const ownedTabId = Number(
                    (appId && st.tabsByAppId?.[String(appId)])
                    || st.currentTabId
                    || st.captchaTabId
                    || runRow?.tabId
                    || 0
                ) || null;
                sendResponse({
                    ok: true,
                    data: {
                        ...st,
                        uiMessageLog,
                        runState: st.runState || runRow?.status || null,
                        ownedTabId,
                        ownedTabUrl: st.currentJobUrl || runRow?.url || null,
                        missingRequired: runRow?.missingRequired
                            || st.lastStatusMeta?.missing
                            || st.lastStatusMeta?.missingRequired
                            || [],
                        captcha: /awaiting_captcha/i.test(String(st.status || ''))
                            || !!runRow?.captcha
                    }
                });
            })
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'SUBMITTED_OK') {
        (async () => {
            const id = msg.applicationId || (await getSettings()).lastResult?.applicationId;
            if (!id) throw new Error('No application id');
            await markApplicationApplied(id);
            await logCourseEvent(id, 'marked_applied', { via: 'submitted_ok' });
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
                await uploadSuccessProofScreenshot(id, tab.id, { waitMs: 1200, settleMs: 800 });
                try { await chrome.tabs.remove(tab.id); } catch (_) {}
            }
            return { id };
        })()
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'MARK_APPLIED') {
        markApplicationApplied(msg.applicationId)
            .then((data) => sendResponse({ ok: true, data }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'CONNECT_JOB_LINKS') {
        (async () => {
            const version = chrome.runtime.getManifest()?.version || '0';
            const injected = await reinjectAppBridgeIntoAppTabs();
            if (!injected) {
                return {
                    ok: false,
                    version,
                    error: 'No Job Links / app tab open. Open http://127.0.0.1:5173 then try again.'
                };
            }
            return { ok: true, version, injected };
        })()
            .then((data) => sendResponse(data))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    return false;
});

async function reinjectAppBridgeIntoAppTabs() {
    const patterns = [
        'http://localhost:5173/*',
        'http://127.0.0.1:5173/*',
        'http://localhost:3000/*',
        'http://127.0.0.1:3000/*'
    ];
    let tabs = [];
    try {
        tabs = await chrome.tabs.query({ url: patterns });
    } catch (_) {
        return 0;
    }
    let injected = 0;
    for (const tab of tabs) {
        if (!tab?.id) continue;
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['content/app-bridge.js']
            });
            injected += 1;
        } catch (err) {
            console.warn('[bidder] reinject app-bridge failed', tab.id, err?.message || err);
        }
    }
    return injected;
}

chrome.runtime.onInstalled.addListener((details) => {
    // Reload / update: clear stuck Autofill/Bidder locks so Process works again.
    chrome.storage.local.set({
        [FILLING_KEY]: false,
        [FILLING_AT_KEY]: 0
    }).catch(() => {});
    setQueueState({
        running: false,
        status: 'idle',
        stopRequested: false,
        error: null
    }).catch(() => {});
    // Re-inject into open Job Links tabs so the user does not need Ctrl+Shift+R.
    reinjectAppBridgeIntoAppTabs()
        .then((n) => console.log(`[bidder] reinjected app-bridge into ${n} tab(s) after ${details?.reason || 'install'}`))
        .catch(() => {});
});

chrome.runtime.onStartup?.addListener?.(() => {
    chrome.storage.local.set({
        [FILLING_KEY]: false,
        [FILLING_AT_KEY]: 0
    }).catch(() => {});
    reinjectAppBridgeIntoAppTabs().catch(() => {});
});

// Page → extension direct channel (no content-script required after Reload Lumi).
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
    const origin = String(sender?.origin || sender?.url || '');
    const allowed = /^https?:\/\/(localhost|127\.0\.0\.1):(5173|3000)(\/|$)/i.test(origin);
    if (!allowed) {
        sendResponse({ ok: false, error: 'origin_not_allowed' });
        return false;
    }
    if (msg?.type === 'BIDDER_PING') {
        sendResponse({
            ok: true,
            version: chrome.runtime.getManifest()?.version || '0',
            extensionId: chrome.runtime.id,
            engine: 'bidder-engine-v1',
            autofillEngine: AUTOFILL_ENGINE,
            via: 'external'
        });
        return false;
    }
    if (msg?.type === 'BIDDER_PROBE_CAPTCHA_HELPERS') {
        probeCaptchaHelpers()
            .then((helpers) => sendResponse({ ok: true, ...helpers, via: 'external' }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    if (msg?.type === 'REINJECT_APP_BRIDGE') {
        reinjectAppBridgeIntoAppTabs()
            .then((n) => sendResponse({
                ok: true,
                injected: n,
                version: chrome.runtime.getManifest()?.version || '0',
                extensionId: chrome.runtime.id,
                via: 'external'
            }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    }
    sendResponse({ ok: false, error: 'unsupported_external_type' });
    return false;
});

// When the service worker wakes after an update/reload, try once.
reinjectAppBridgeIntoAppTabs().catch(() => {});
