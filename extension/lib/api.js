/** Shared API helpers for the Job Apply Bidder extension. */

const TECHSTACK_TO_SKILLS = {
    python: 'Python',
    java: 'Java',
    dotnet: '.NET',
    golang: 'Golang',
    nodejs: 'Node.js',
    frontend: 'React frontend'
};

export function normalizeBaseUrl(url) {
    if (!url || typeof url !== 'string') return 'http://127.0.0.1:9017';
    return url.trim().replace(/\/+$/, '');
}

export async function getSettings() {
    const data = await chrome.storage.local.get([
        'apiBaseUrl',
        'frontendBaseUrl',
        'token',
        'user',
        'selectedProfileId',
        'selectedProfileName',
        'lastResult',
        'pendingFill',
        'pendingSamePageApply',
        'autoSubmit',
        'bidderAutoSubmit',
        'bidderAutoNext',
        'bidderCaptchaFocus',
        'bidderUnattended',
        'bidderCaptchaGraceSec',
        'bidderCaptchaHelper',
        'bidderCaptchaHelperWaitSec',
        'bidderCapsolverApiKey',
        'bidderTwocaptchaApiKey',
        'bidderSoundEnabled',
        'cvLinks',
        'activeJobSession'
    ]);
    return {
        apiBaseUrl: normalizeBaseUrl(data.apiBaseUrl || 'http://127.0.0.1:9017'),
        frontendBaseUrl: normalizeBaseUrl(data.frontendBaseUrl || 'http://127.0.0.1:5173'),
        token: data.token || null,
        user: data.user || null,
        selectedProfileId: data.selectedProfileId || null,
        selectedProfileName: data.selectedProfileName || null,
        lastResult: data.lastResult || null,
        pendingFill: data.pendingFill || null,
        pendingSamePageApply: data.pendingSamePageApply || null,
        autoSubmit: !!data.autoSubmit,
        bidderAutoSubmit: data.bidderAutoSubmit != null ? !!data.bidderAutoSubmit : true,
        bidderAutoNext: !!data.bidderAutoNext,
        bidderCaptchaFocus: data.bidderCaptchaFocus != null ? !!data.bidderCaptchaFocus : true,
        bidderUnattended: !!data.bidderUnattended,
        bidderCaptchaGraceSec: Number(data.bidderCaptchaGraceSec) >= 0
            ? Number(data.bidderCaptchaGraceSec)
            : 45,
        bidderCaptchaHelper: !!data.bidderCaptchaHelper,
        bidderCaptchaHelperWaitSec: Number(data.bidderCaptchaHelperWaitSec) >= 0
            ? Number(data.bidderCaptchaHelperWaitSec)
            : 180,
        bidderCapsolverApiKey: String(data.bidderCapsolverApiKey || ''),
        bidderTwocaptchaApiKey: String(data.bidderTwocaptchaApiKey || ''),
        bidderSoundEnabled: data.bidderSoundEnabled != null ? !!data.bidderSoundEnabled : true,
        cvLinks: data.cvLinks && typeof data.cvLinks === 'object' ? data.cvLinks : {},
        activeJobSession: data.activeJobSession || null
    };
}

export async function saveSettings(patch) {
    await chrome.storage.local.set(patch);
}

async function request(path, { method = 'GET', body, token, apiBaseUrl, timeout = 60000 } = {}) {
    const settings = await getSettings();
    const base = normalizeBaseUrl(apiBaseUrl || settings.apiBaseUrl);
    const auth = token ?? settings.token;
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let res;
    try {
        res = await fetch(`${base}${path}`, {
            method,
            headers,
            body: body != null ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`Request timed out after ${Math.round(timeout / 1000)}s`);
        }
        const msg = String(err?.message || err || '');
        if (/Failed to fetch|NetworkError|ECONNREFUSED|fetch failed/i.test(msg)) {
            throw new Error(
                `Cannot reach API at ${base} — start the server (npm run server) and keep API URL as http://127.0.0.1:9017`
            );
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }

    let data = null;
    const text = await res.text();
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { error: text || res.statusText };
    }

    if (!res.ok) {
        const err = new Error(data?.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

export async function login(username, password, apiBaseUrl) {
    const data = await request('/auth/login', {
        method: 'POST',
        body: { username, password },
        apiBaseUrl,
        token: null
    });
    await saveSettings({
        apiBaseUrl: normalizeBaseUrl(apiBaseUrl),
        token: data.token,
        user: data.user
    });
    return data;
}

export async function me() {
    return request('/auth/me');
}

export async function listProfiles() {
    return request('/user/profiles');
}

export async function generateResume({
    profileId,
    jobDescription,
    companyName,
    jobRole,
    jobUrl,
    coreSkills,
    fontFamily = '__random__'
}) {
    return request('/user/generate-resume', {
        method: 'POST',
        body: {
            profile_id: profileId,
            job_description: jobDescription,
            company_name: companyName || '',
            job_role: jobRole || '',
            job_url: jobUrl || '',
            core_skills: Array.isArray(coreSkills) ? coreSkills.join(', ') : (coreSkills || ''),
            font_family: fontFamily
        }
    });
}

/** Regenerate CV for an existing pending application (updates same row). */
export async function regenerateResume({
    applicationId,
    jobDescription,
    companyName,
    jobRole,
    jobUrl,
    coreSkills,
    fontFamily = '__random__'
}) {
    return request('/user/regenerate-resume', {
        method: 'POST',
        body: {
            application_id: applicationId,
            job_description: jobDescription || '',
            company_name: companyName || '',
            job_role: jobRole || '',
            job_url: jobUrl || '',
            core_skills: Array.isArray(coreSkills) ? coreSkills.join(', ') : (coreSkills || ''),
            font_family: fontFamily
        },
        timeout: 120000
    });
}

/** Autofill / Mode-2 answers (not Bidder brain). */
export async function generateAnswers({
    profile_id,
    job_description,
    resume_html,
    resume_content,
    questions,
    company_name,
    job_role,
    application_id
}) {
    return request('/user/generate-answers', {
        method: 'POST',
        body: {
            profile_id,
            job_description: job_description || '',
            resume_html: resume_html || resume_content || '',
            questions: Array.isArray(questions) ? questions : [],
            company_name: company_name || '',
            job_role: job_role || '',
            application_id: application_id || null
        },
        timeout: 60000
    });
}

/** Generate a cover-letter DOCX when the apply form requires a cover letter upload. */
export async function generateCoverLetter({
    profile_id,
    job_description,
    resume_html,
    company_name,
    job_role
}) {
    return request('/user/generate-cover-letter', {
        method: 'POST',
        body: {
            profile_id,
            job_description: job_description || '',
            resume_html: resume_html || '',
            company_name: company_name || '',
            job_role: job_role || ''
        },
        timeout: 60000
    });
}

export async function generateBidderAnswers(payload) {
    return request('/user/bidder/brain/answers', {
        method: 'POST',
        body: payload,
        timeout: 60000
    });
}

/** Groq pre-submit checkout — review filled form before auto-submit. */
export async function checkoutApplicationCheck(payload) {
    return request('/user/bidder/checkout-check', {
        method: 'POST',
        body: payload || {},
        timeout: 45000
    });
}

/** Interpret user instruction when stuck at FILLED. */
export async function interpretBidderInstruction(payload) {
    return request('/user/bidder/brain/instruct', {
        method: 'POST',
        body: payload || {},
        timeout: 45000
    });
}

export async function getBidderAssistantContext(params = {}) {
    const q = new URLSearchParams();
    if (params.profile_id) q.set('profile_id', String(params.profile_id));
    if (params.host) q.set('host', String(params.host));
    const qs = q.toString();
    return request(`/user/bidder/brain/assistant-context${qs ? `?${qs}` : ''}`);
}

export async function listBidderFillLessons(params = {}) {
    const q = new URLSearchParams();
    if (params.profile_id) q.set('profile_id', String(params.profile_id));
    if (params.host) q.set('host', String(params.host));
    const qs = q.toString();
    return request(`/user/bidder/brain/fill-lessons${qs ? `?${qs}` : ''}`);
}

export async function saveBidderFillLesson(payload) {
    return request('/user/bidder/brain/fill-lessons', {
        method: 'POST',
        body: payload || {}
    });
}

export async function upsertQuestionMemory(payload) {
    return request('/user/bidder/brain/question-memory/upsert', {
        method: 'POST',
        body: payload || {}
    });
}

export async function checkBidderCv(payload) {
    return request('/user/bidder/brain/cv-check', { method: 'POST', body: payload });
}

export async function logBidderFieldAttempts(applicationId, attempts) {
    return request('/user/bidder/brain/field-attempts', {
        method: 'POST',
        body: { application_id: applicationId, attempts }
    });
}

export async function getBidderEngineVersion() {
    return request('/user/bidder/brain/version');
}

export async function listBidderReady(limit = 50, profileId = null, jobLinkIds = null) {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    if (profileId) q.set('profile_id', String(profileId));
    if (Array.isArray(jobLinkIds) && jobLinkIds.length) {
        q.set('job_link_ids', jobLinkIds.map((id) => String(id)).join(','));
    }
    return request(`/user/bidder/ready?${q.toString()}`);
}

export async function logBidCourseEvent(payload) {
    return request('/user/bid-courses/event', { method: 'POST', body: payload });
}

export async function uploadBidScreenshot(payload) {
    return request('/user/bid-courses/screenshot', {
        method: 'POST',
        body: payload,
        timeout: 30000
    });
}

export async function saveBidPackage(payload) {
    return request('/user/bid-courses/package', { method: 'POST', body: payload });
}

export async function getBidderStatus() {
    return request('/user/bidder/status');
}

export async function markJobLinkExpired(jobLinkId, extra = {}) {
    const id = Number(jobLinkId);
    if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'invalid_job_link_id' };
    return request(`/job-links/${id}/expired`, {
        method: 'POST',
        body: {
            reason: extra.reason || 'expired',
            snippet: extra.snippet || null,
            url: extra.url || null
        }
    });
}

export async function markApplicationApplied(applicationId) {
    return request(`/user/applications/${applicationId}`, {
        method: 'PATCH',
        body: { status: 'applied' }
    });
}

export async function clearFalseApplicationSuccess(applicationId) {
    return request(`/user/applications/${applicationId}`, {
        method: 'PATCH',
        body: { status: 'pending' }
    });
}

export async function getBidderApplication(id) {
    return request(`/user/bidder/applications/${id}`);
}

export async function getLatestBidderApplication(profileId) {
    const q = profileId ? `?profile_id=${encodeURIComponent(profileId)}` : '';
    return request(`/user/bidder/latest${q}`);
}

/** Find an already-generated CV for this apply-page URL (no regenerate). */
export async function getBidderApplicationByJobUrl(jobUrl, profileId) {
    const params = new URLSearchParams();
    params.set('url', jobUrl || '');
    if (profileId) params.set('profile_id', String(profileId));
    return request(`/user/bidder/by-job-url?${params.toString()}`);
}

/** Log fill course for analytics learning (answers, salary, timing). */
export async function logBidCourseFill(payload) {
    return request('/user/bid-courses/fill', {
        method: 'POST',
        body: payload
    });
}

export function buildUploadResumeFilename(profileOrNames, ext = '.docx') {
    const firstRaw = profileOrNames?.first_name ?? profileOrNames?.firstName ?? profileOrNames?.first ?? '';
    const lastRaw = profileOrNames?.last_name ?? profileOrNames?.lastName ?? profileOrNames?.last ?? '';
    const sanitize = (name, maxLen = 40) => {
        let s = String(name || '').replace(/[^A-Za-z0-9]+/g, '_');
        s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
        if (!s) return '';
        if (s.length > maxLen) s = s.substring(0, maxLen).replace(/_+$/g, '');
        return s;
    };
    const first = sanitize(firstRaw) || 'Candidate';
    const last = sanitize(lastRaw);
    const base = last ? `${first}_${last}` : first;
    const safeExt = String(ext || '.docx').startsWith('.') ? String(ext) : `.${ext}`;
    return `${base}${safeExt}`;
}

/** Derive First_Last.docx from archive resume_First_Last_Company_ts.docx when needed. */
export function cleanResumeUploadName(filename, profile = null) {
    if (profile?.first_name || profile?.last_name) {
        const fromProfile = buildUploadResumeFilename(profile);
        if (fromProfile && !/^resume_/i.test(fromProfile)) return fromProfile;
    }
    const fn = String(filename || '').trim();
    if (!fn) return 'Candidate.docx';
    if (!/^resume_/i.test(fn) && !/_\d{10,}\./.test(fn)) {
        // Already looks clean enough — keep basename
        const base = fn.split(/[/\\]/).pop() || fn;
        if (/^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z][A-Za-z0-9]*){0,2}\.(docx?|pdf)$/i.test(base)) {
            return base;
        }
    }
    // Tolerate spaces in archive tokens: resume_Vinh_ Ly_Company_ts.docx
    const m = fn.match(/^resume_([^_]+)_([^_]+)_/i);
    if (m) {
        return buildUploadResumeFilename({
            first_name: String(m[1] || '').trim(),
            last_name: String(m[2] || '').trim()
        });
    }
    const ext = (fn.match(/\.(docx?|pdf)$/i) || ['.docx'])[0];
    return `Candidate${ext.startsWith('.') ? ext : `.${ext}`}`;
}

export async function fetchResumeBase64(apiBaseUrl, filename, token, opts = {}) {
    const settings = await getSettings();
    const base = normalizeBaseUrl(apiBaseUrl || settings.apiBaseUrl);
    const auth = token ?? settings.token;
    const res = await fetch(`${base}/resumes/${encodeURIComponent(filename)}`, {
        headers: auth ? { Authorization: `Bearer ${auth}` } : {}
    });
    if (!res.ok) throw new Error(`Failed to download resume (${res.status})`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const uploadName = cleanResumeUploadName(
        opts.uploadFilename && !/^resume_/i.test(String(opts.uploadFilename))
            ? opts.uploadFilename
            : filename,
        opts.profile || null
    );
    // Never attach archive names to ATS — always First_Last.docx.
    const safeUpload = (!uploadName || /^resume_/i.test(uploadName) || /_\d{10,}\./.test(uploadName))
        ? (opts.profile ? buildUploadResumeFilename(opts.profile) : cleanResumeUploadName(filename, opts.profile || null))
        : uploadName;
    return {
        base64: btoa(binary),
        mimeType: res.headers.get('content-type')
            || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        // Archive path may still be resume_…_ts.docx on disk; ATS sees upload name.
        filename: safeUpload || 'Candidate.docx',
        archiveFilename: filename
    };
}

export function techstacksToCoreSkills(techstacks) {
    const list = Array.isArray(techstacks) ? techstacks : [];
    const skills = list
        .map((t) => TECHSTACK_TO_SKILLS[String(t).toLowerCase()])
        .filter(Boolean);
    return [...new Set(skills)];
}

/** Pick stacks mentioned in the JD; fall back to at most 2 from the profile. */
export function inferCoreSkillsFromJd(jobDescription, profileTechstacks = []) {
    const text = String(jobDescription || '').toLowerCase();
    const rules = [
        { skill: 'Python', re: /\bpython\b|\bnumpy\b|\bscipy\b|\bpandas\b|\bdjango\b|\bflask\b|\bfastapi\b/ },
        { skill: '.NET', re: /\b\.?net\b|\bc#\b|\basp\.?\s*net\b|\bdotnet\b/ },
        { skill: 'Java', re: /\bjava\b|\bspring\b|\bjvm\b/ },
        { skill: 'Golang', re: /\bgolang\b|\bgo(?:lang)?\s*(?:developer|engineer|programmer|lang(?:uage)?)\b|\bgo\s+modules?\b/ },
        { skill: 'Node.js', re: /\bnode\.?js\b|\bnodejs\b|\bexpress\b|\bnestjs\b/ },
        { skill: 'React frontend', re: /\breact\b|\bnext\.?js\b|\btypescript\b.*\bfront/ },
        { skill: 'Ruby on Rails', re: /\bruby\b|\brails\b/ },
        { skill: 'Angular frontend', re: /\bangular\b/ }
    ];
    const fromJd = [];
    for (const r of rules) {
        if (r.re.test(text)) fromJd.push(r.skill);
    }
    if (fromJd.length) return [...new Set(fromJd)];
    const fromProfile = techstacksToCoreSkills(profileTechstacks);
    return fromProfile.slice(0, 2);
}

export function resumeDownloadUrl(apiBaseUrl, filename) {
    if (!filename) return null;
    return `${normalizeBaseUrl(apiBaseUrl)}/resumes/${encodeURIComponent(filename)}`;
}

/** Outlook inbox — wait for Greenhouse-style email security code. */
export async function waitOutlookOtp(opts = {}) {
    return request('/user/outlook/wait-otp', {
        method: 'POST',
        body: {
            timeoutMs: opts.timeoutMs ?? 180000,
            pollMs: opts.pollMs ?? 5000,
            afterIso: opts.afterIso || null,
            fromHint: opts.fromHint || 'greenhouse'
        },
        timeout: Math.max(60000, (opts.timeoutMs || 180000) + 30000)
    });
}

export async function getOutlookStatus() {
    return request('/user/outlook/status');
}
