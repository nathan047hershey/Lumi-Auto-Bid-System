import axios from 'axios';

// In development (Vite), use relative path. In production, use absolute URL.
const apiBaseUrl = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
    baseURL: apiBaseUrl,
    headers: {
        'Content-Type': 'application/json'
    }
});

// Add auth token to requests
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});

// Only these 401s mean the JWT session is gone. Other 401s (bad LLM key,
// wrong current password, failed login) must not wipe the session.
const SESSION_AUTH_ERRORS = new Set([
    'Authentication required',
    'Invalid or expired token'
]);

api.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error.response?.status;
        const message = error.response?.data?.error;
        const skip = error.config?.skipAuthRedirect;
        if (status === 401 && !skip && SESSION_AUTH_ERRORS.has(message)) {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            if (window.location.pathname !== '/login') {
                window.location.href = '/login';
            }
        }
        return Promise.reject(error);
    }
);

// Auth API
export const authAPI = {
    login: (username, password) => api.post('/auth/login', { username, password }),
    register: (username, password, role) => api.post('/auth/register', { username, password, role }),
    me: () => api.get('/auth/me')
};

// Admin API
export const adminAPI = {
    // Users
    getUsers: () => api.get('/admin/users'),
    deleteUser: (id) => api.delete(`/admin/users/${id}`),
    assignRole: (userId, role) => api.post(`/admin/users/${userId}/roles`, { role }),
    removeRole: (userId, role) => api.delete(`/admin/users/${userId}/roles/${role}`),

    // Profiles
    getProfiles: () => api.get('/admin/profiles'),
    getProfile: (id) => api.get(`/admin/profiles/${id}`),
    createProfile: (data) => api.post('/admin/profiles', data),
    updateProfile: (id, data) => api.put(`/admin/profiles/${id}`, data),
    /** Copy shared autofill answers (EEO/logistics/education) to every profile. */
    applyAutofillDefaultsToAll: (data) => api.post('/admin/profiles/autofill-defaults', data),
    deleteProfile: (id) => api.delete(`/admin/profiles/${id}`),
    duplicateProfile: (id) => api.post(`/admin/profiles/${id}/duplicate`),

    // Assignments
    getAssignments: () => api.get('/admin/assignments'),
    createAssignment: (user_id, profile_id) => api.post('/admin/assignments', { user_id, profile_id }),
    setDefaultAssignment: (id) => api.put(`/admin/assignments/${id}/default`),
    deleteAssignment: (id) => api.delete(`/admin/assignments/${id}`),

    // Applications
    getApplications: (page = 1, limit = 20, filters = {}) => api.get('/admin/applications', { params: { page, limit, ...filters } }),
    updateApplicationStatus: (id, status) => api.patch(`/admin/applications/${id}`, { status }),
    // Admin-only terminal state (completed/cancelled/rejected/in_progress).
    updateApplicationState: (id, state, reject_reason = null) =>
        api.patch(`/admin/applications/${id}/state`, { state, reject_reason }),
    deleteApplication: (id) => api.delete(`/admin/applications/${id}`),

    listBidCourses: (params = {}) => api.get('/admin/bid-courses', { params }),
    getBidCourse: (id, opts = {}) => api.get(`/admin/bid-courses/${id}`, {
        params: opts.lite ? { lite: 1 } : undefined
    }),
    clearBidCourses: () => api.post('/admin/bid-courses/clear'),
    getBidCourseScreenshot: (id, filename, opts = {}) =>
        api.get(`/admin/bid-courses/${id}/screenshots/${encodeURIComponent(filename)}`, {
            responseType: 'blob',
            params: opts.t != null ? { t: opts.t } : undefined,
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
        }),
    getAnalyze: (params = {}) => api.get('/admin/analyze', { params }),
    runAnalyze: (payload = {}) => api.post('/admin/analyze/run', payload, { timeout: 90000 }),

    // Analytics
    getStats: (params = {}) => {
        const qs = new URLSearchParams();
        if (Array.isArray(params.userIds)) {
            params.userIds.forEach((id) => qs.append('userIds', String(id)));
        } else if (typeof params.userIds === 'number') {
            qs.append('userIds', String(params.userIds));
        } else if (typeof params.userIds === 'string' && params.userIds.length) {
            qs.append('userIds', params.userIds);
        }
        if (params.period) qs.append('period', params.period);
        if (params.from) qs.append('from', params.from);
        if (params.to) qs.append('to', params.to);
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        return api.get(`/admin/stats${suffix}`);
    },

    // Interview Management
    createInterview: (application_id, data) => api.post('/admin/interviews', { application_id, ...data }),
    updateInterview: (id, data) => api.put(`/admin/interviews/${id}`, data),
    deleteInterview: (id) => api.delete(`/admin/interviews/${id}`),

    // Interview requests (admin overview)
    listInterviewRequests: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params || {})) {
            if (v !== undefined && v !== null && v !== '' && v !== 'all') {
                qs.append(k, String(v));
            }
        }
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        return api.get(`/admin/interview-requests${suffix}`);
    },
    getInterviewRequestSummary: () => api.get('/admin/interview-requests/summary'),
    updateInterviewRequestStatus: (id, status, notes) =>
        api.patch(`/admin/interview-requests/${id}/status`, { status, notes }),
    editInterviewRequest: (id, data) => api.patch(`/admin/interview-requests/${id}`, data),

    // Milestone workflow (admin-side, 2026-07). Admins can list / add /
    // edit / remove / complete / uncomplete / approve / pay milestones
    // regardless of role.
    listMilestonesAdmin: (applicationId) => api.get(`/admin/milestones/${applicationId}`),
    addMilestoneAdmin: (applicationId, payload) =>
        api.post(`/admin/milestones/${applicationId}`, payload),
    completeMilestoneAdmin: (milestoneId, payload = {}) =>
        api.post(`/admin/milestones/${milestoneId}/complete`, payload),
    uncompleteMilestoneAdmin: (milestoneId) =>
        api.post(`/admin/milestones/${milestoneId}/uncomplete`, {}),
    approveMilestoneAdmin: (milestoneId) =>
        api.post(`/admin/milestones/${milestoneId}/approve`, {}),
    unapproveMilestoneAdmin: (milestoneId) =>
        api.post(`/admin/milestones/${milestoneId}/unapprove`, {}),
    payMilestoneAdmin: (milestoneId) =>
        api.post(`/admin/milestones/${milestoneId}/pay`, {}),
    unpayMilestoneAdmin: (milestoneId) =>
        api.post(`/admin/milestones/${milestoneId}/unpay`, {}),
    editMilestoneAdmin: (milestoneId, payload) =>
        api.patch(`/admin/milestones/${milestoneId}`, payload),
    deleteMilestoneAdmin: (milestoneId) =>
        api.delete(`/admin/milestones/${milestoneId}`),
    assignDeveloper: (interviewRequestId, developerId) =>
        api.post(`/admin/interview-requests/${interviewRequestId}/assign-developer`, { developer_id: developerId || null }),
    setApplicationFlags: (applicationId, { success, failed, cancelled }) =>
        api.patch(`/admin/applications/${applicationId}/flags`, { success: !!success, failed: !!failed, cancelled: !!cancelled }),
    listDevelopers: () => api.get('/admin/developers'),
    listDeveloperProfiles: (q) =>
        api.get('/admin/developers/profiles', { params: q ? { q } : {} }),
    // Admin override of the developer-self-edit endpoint. Lets an
    // admin update a developer's contact info, technical skills, or
    // availability without requiring the developer to be logged in.
    // Mirrors the same validation contract (email + Telegram required).
    updateDeveloperProfile: (id, payload) =>
        api.put(`/admin/developers/${id}/profile`, payload),
    // Admin override of the developer resume upload. Same on-disk
    // format as the developer-self-edit endpoint — just a target
    // user id instead of `req.user.id`. Used from the admin
    // Developers page when an admin needs to attach / replace a
    // developer's resume (e.g. on behalf of a departed dev).
    uploadDeveloperResume: (id, filename, content) =>
        api.post(`/admin/developers/${id}/profile/resume`, { filename, content }),

    // Caller Management
    getCallers: () => api.get('/admin/callers'),
    assignCaller: (application_id, caller_id) => api.post('/admin/caller-assignments', { application_id, caller_id }),
    unassignCaller: (caller_id, application_id) => api.delete(`/admin/caller-assignments/${caller_id}/${application_id}`),
    getCallerAssignments: (application_id) => api.get(`/admin/caller-assignments/${application_id}`),

    // Resume Download
    downloadResume: async (filename) => {
        const response = await api.get(`/admin/resumes/${filename}`, {
            responseType: 'blob'
        });
        // Create download link
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
    },

    // Settings
    getSettings: () => api.get('/admin/settings'),
    updateSettings: (data) => api.put('/admin/settings', data),
    testSettings: (data = {}) => api.post('/admin/settings/test', data, { skipAuthRedirect: true }),

    // Resume templates (admin upload / delete)
    listTemplates: () => api.get('/admin/resume-templates'),
    listUserTemplates: () => api.get('/admin/user-templates'),
    getTemplate: (id) => api.get(`/admin/resume-templates/${id}`),
    uploadTemplate: async (file, { name, description } = {}) => {
        // Read the file as base64 (no multipart dependency on the server).
        const file_base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        return api.post('/admin/resume-templates', {
            name: name || file.name.replace(/\.docx$/i, ''),
            description: description || '',
            filename: file.name,
            file_base64
        });
    },
    deleteTemplate: (id) => api.delete(`/admin/resume-templates/${id}`),
    downloadTemplate: (id) => api.get(`/admin/resume-templates/${id}/download`, { responseType: 'blob' }),
    reExtractTemplate: (id) => api.post(`/admin/resume-templates/${id}/re-extract`),
    applyTemplate: (id, profile_id = null) => api.post(`/admin/resume-templates/${id}/apply`, { profile_id }),
    // Fetch the rendered HTML of the source DOCX template (so the
    // admin sees the actual template content rendered, not a mock).
    // Returns the raw HTML string. We use `transformResponse: []`
    // so axios doesn't try to JSON-parse it.
    previewTemplateHtml: (id) => api.post(`/admin/resume-templates/${id}/preview-html`, {}, {
        responseType: 'text',
        transformResponse: [(d) => d]
    }),
    // Render the source DOCX to a downloadable PDF (kept for parity
    // with previous behaviour — the inline modal uses /preview-html).
    previewTemplate: (id) => api.post(`/admin/resume-templates/${id}/preview`, {}, { responseType: 'blob' }),

    // Job Links (shared team directory)
    //
    // Endpoint routing on the server:
    //   - Any authenticated user (admin / manager / caller / user /
    //     developer) can read, create, update, and delete rows.
    //     This matches the policy that adding a job link is a team
    //     activity, not an admin-only one.
    //   - The on-demand `/scrape` endpoint stays admin-only because
    //     it makes outbound requests to LinkedIn from the server's
    //     IP — we don't want non-admins to be able to burst fetches.
    listJobLinks: (page = 1, limit = 10, filters = {}) =>
        api.get('/job-links', { params: { page, limit, ...filters } }),
    getJobLink: (id) => api.get(`/job-links/${id}`),
    getJobLinkCronStatus: () => api.get('/job-links/cron-status'),
    createJobLink: (payload) => api.post('/job-links', payload),
    updateJobLink: (id, payload) => api.patch(`/job-links/${id}`, payload),
    deleteJobLink: (id) => api.delete(`/job-links/${id}`),
    // New detail-page endpoints. The detail page renders
    // /job-links/:id/applications which returns the job_link +
    // joined profile rows for every auto / user application.
    getJobLinkApplications: (id, filters = {}) =>
        api.get(`/job-links/${id}/applications`, { params: filters }),
    regenerateApplication: (jobLinkId, appId) =>
        api.post(`/job-links/${jobLinkId}/applications/${appId}/regenerate`),
    // Manually enqueue a resume-generation message for a single
    // (profile, job_link) pair. Idempotent server-side: if an
    // application row already exists, the existing id is
    // returned and the message is re-enqueued. Used by the
    // "Matched profiles" panel on the detail page.
    generateForProfile: (jobLinkId, profileId) =>
        api.post(`/admin/job-links/${jobLinkId}/generate/${profileId}`),
    markApplicationApplied: (jobLinkId, appId) =>
        api.post(`/job-links/${jobLinkId}/applications/${appId}/apply`),
    // Bulk "Apply to this whole job" — flips every still-pending
    // application under the job_link to 'applied' AND closes the
    // job_link itself (is_available=0). Open to any auth user.
    markJobLinkApplied: (id) => api.post(`/job-links/${id}/apply`),
    // Auto-apply cron tunables (admin-only). GET returns the
    // current config, defaults, and bounds; PUT patches any
    // subset of the keys (intervalMs, maxJobsPerTick,
    // maxProfilesPerJob, staleGeneratingMs, runOnBoot). Values
    // are clamped server-side to BOUNDS so a typo can't blow
    // up the pipeline.
    getAutoApplyConfig: () => api.get('/admin/auto-apply/config'),
    updateAutoApplyConfig: (patch) => api.put('/admin/auto-apply/config', patch),
    // Trigger one cron tick on demand (admin-only).
    triggerAutoApply: () => api.post('/admin/auto-apply/trigger'),
    // Live RabbitMQ queue snapshot (depth, in-flight,
    // processed/failed totals). Used by the detail-page admin
    // card to show how many resume-generation jobs are
    // queued or being processed by the worker.
    getAutoApplyQueue: () => api.get('/admin/auto-apply/queue'),
    // Job-detail fetch queue (separate worker that runs the
    // per-row scraper when a new job_link is added). Polled by
    // the JobLinks list page so the user sees "Pending: 3 ·
    // Worker: processing" the moment they hit "Add new job
    // link".
    getJobLinksQueue: () => api.get('/admin/job-links/queue'),
    // Force re-scrape JD for a job link (pending/failed/success/dead → pending + enqueue).
    refetchJobLink: (id) => api.post(`/job-links/${id}/refetch`),
    // Enqueue CVs for matching profiles that do not yet have an application
    // (new profiles added after the job was first processed).
    reconcileJobLinkCvs: (id) => api.post(`/job-links/${id}/reconcile-cvs`),
    reconcileJobLinksCvs: (ids) => api.post('/job-links/reconcile-cvs', { ids })
};

// User API
export const userAPI = {
    getProfiles: () => api.get('/user/profiles'),
    getProfile: (id) => api.get(`/user/profiles/${id}`),
    setDefaultProfile: (id) => api.put(`/user/profiles/${id}/default`),
    generateResume: (profile_id, job_description, extra = {}) => api.post('/user/generate-resume', {
        profile_id,
        job_description,
        company_name: extra.company_name,
        job_role: extra.job_role,
        core_skills: extra.core_skills,
        job_url: extra.job_url,
        template_id: extra.template_id,
        font_family: extra.font_family,
        template_source: extra.template_source
    }, { timeout: 360000 }),
    regenerateResume: ({ application_id, resume_filename, job_description, template_id, font_family, template_source }) => api.post('/user/regenerate-resume', {
        application_id,
        resume_filename,
        job_description,
        template_id,
        font_family,
        template_source
    }, { timeout: 360000 }),
    checkResumeQuality: ({ resume_html, profile_id, job_description, core_skills }) =>
        api.post('/user/check-resume-quality', {
            resume_html,
            profile_id,
            job_description,
            core_skills
        }),
    listCvQualityApplications: () => api.get('/user/cv-quality/applications'),
    getCvQualityReport: (applicationId) => api.get(`/user/cv-quality/${encodeURIComponent(applicationId)}`),
    finalizeResume: (application_id) => api.post('/user/finalize-resume', { application_id }),
    generateResumePdf: ({ resume_html, profile_id, template_id, font_family, template_source }) =>
        api.post('/user/resume-pdf', {
            resume_html,
            profile_id,
            template_id,
            font_family,
            template_source
        }, { responseType: 'arraybuffer' }),
    getApplicationByFilename: (filename) => api.get(`/user/applications/by-filename/${encodeURIComponent(filename)}`),
    generateCoverLetter: (profile_id, job_description, resume_html, company_name) => api.post('/user/generate-cover-letter', { profile_id, job_description, resume_html, company_name }),
    extractCompany: (job_description) => api.post('/user/extract-company', { job_description }),
    lookupJobByUrl: (url) => api.get('/user/jobs/by-url', { params: { url } }),
    getApplications: (profileId, params = {}) => api.get(`/user/applications/${profileId}`, { params }),
    getStats: () => api.get('/user/stats'),
    getBidInsights: (params = {}) => api.get('/user/bid-insights', { params }),
    getAnalyze: (params = {}) => api.get('/user/analyze', { params }),
    runAnalyze: (payload = {}) => api.post('/user/analyze/run', payload, { timeout: 90000 }),
    listBidCourses: (params = {}) => api.get('/user/bid-courses', { params }),
    getBidCourse: (id, opts = {}) => api.get(`/user/bid-courses/${id}`, {
        params: opts.lite ? { lite: 1 } : undefined
    }),
    clearBidCourses: (payload = {}) => api.post('/user/bid-courses/clear', payload),
    correctBidCourseAnswer: (id, payload) => api.post(`/user/bid-courses/${id}/correct-answer`, payload),
    downloadResumeFolder: (params = {}) => api.get('/user/resume-folder', {
        params: { ...params, meta: 1 },
        timeout: 60000
    }),
    getBidCourseScreenshot: (id, filename, opts = {}) =>
        api.get(`/user/bid-courses/${id}/screenshots/${encodeURIComponent(filename)}`, {
            responseType: 'blob',
            params: opts.t != null ? { t: opts.t } : undefined,
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
        }),
    listBidderReady: (params = {}) => api.get('/user/bidder/ready', { params }),
    logBidCourseEvent: (payload) => api.post('/user/bid-courses/event', payload),
    logBidCourseFill: (payload) => api.post('/user/bid-courses/fill', payload),
    saveBidCoursePackage: (payload) => api.post('/user/bid-courses/package', payload),
    listBidderFillLessons: (params = {}) => api.get('/user/bidder/brain/fill-lessons', { params }),
    clearBidderFillLessons: (payload) => api.post('/user/bidder/brain/fill-lessons/clear', payload),
    listQuestionMemory: (params = {}) => api.get('/user/bidder/brain/question-memory', { params }),
    matchQuestionMemory: (payload) => api.post('/user/bidder/brain/question-memory/match', payload),
    upsertQuestionMemory: (payload) => api.post('/user/bidder/brain/question-memory/upsert', payload),
    teachQuestionMemory: (payload) => api.post('/user/bidder/brain/question-memory/teach', payload),
    disableQuestionMemory: (payload) => api.post('/user/bidder/brain/question-memory/disable', payload),
    clearQuestionMemory: (payload = {}) => api.post('/user/bidder/brain/question-memory/clear', payload),
    updateApplicationStatus: (id, status, reject_reason) => api.patch(`/user/applications/${id}`, { status, reject_reason }),
    chat: (question, job_description, resume_content, conversationHistory) => api.post('/user/chat', { question, job_description, resume_content, conversationHistory }),
    generateAnswers: (payload) => api.post('/user/generate-answers', payload, { timeout: 120000 }),

    // Resume templates (read-only on the user side)
    listTemplates: () => api.get('/user/resume-templates'),
    getTemplate: (id) => api.get(`/user/resume-templates/${id}`),

    // Per-user resume templates built with the drag-drop template
    // builder. CRUD over the user's own library.
    listUserTemplates: () => api.get('/user/user-templates'),
    getUserTemplateDefaultSpec: () => api.get('/user/user-templates/default-spec'),
    getUserTemplate: (id) => api.get(`/user/user-templates/${id}`),
    createUserTemplate: (payload) => api.post('/user/user-templates', payload),
    updateUserTemplate: (id, payload) => api.put(`/user/user-templates/${id}`, payload),
    deleteUserTemplate: (id) => api.delete(`/user/user-templates/${id}`),

    // Outlook / email OTP — forward webhook (default) + optional Graph
    getOutlookStatus: () => api.get('/user/outlook/status'),
    enableOutlookForward: (payload = {}) => api.post('/user/outlook/forward/enable', payload),
    disableOutlookForward: () => api.delete('/user/outlook/forward'),
    subscribeOutlookPush: (payload = {}) => api.post('/user/outlook/subscribe', payload),
    startOutlookDeviceCode: () => api.post('/user/outlook/device-code'),
    pollOutlookDeviceCode: (device_code) => api.post('/user/outlook/device-code/poll', { device_code }),
    syncOutlook: (payload = {}) => api.post('/user/outlook/sync', payload),
    listOutlookMessages: (params = {}) => api.get('/user/outlook/messages', { params }),
    waitOutlookOtp: (payload = {}) => api.post('/user/outlook/wait-otp', payload, { timeout: 620000 }),
    disconnectOutlookMailbox: (id) => api.delete(`/user/outlook/mailboxes/${id}`),
    disconnectOutlook: () => api.delete('/user/outlook'),
    // Free Gmail IMAP (App Password)
    connectGmailImap: (payload) => api.post('/user/gmail/imap/connect', payload),
    syncGmailImap: (payload = {}) => api.post('/user/gmail/imap/sync', payload),
    disconnectGmailImapMailbox: (id) => api.delete(`/user/gmail/imap/mailboxes/${id}`),
    disconnectGmailImap: () => api.delete('/user/gmail/imap'),

    // Interview requests (user-side). The shape is now a paginated
    // envelope (`{ rows, pagination }`) — the page renders the
    // standard Prev/Next footer. Mirrors the admin serializer: drop
    // undefined / null / '' / 'all' so we don't send empty filters
    // over the wire.
    listInterviewRequests: (params = {}) => {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params || {})) {
            if (v !== undefined && v !== null && v !== '' && v !== 'all') {
                qs.append(k, String(v));
            }
        }
        const suffix = qs.toString() ? `?${qs.toString()}` : '';
        return api.get(`/user/interview-requests${suffix}`);
    },
    getInterviewRequest: (applicationId) => api.get(`/user/interview-requests/${applicationId}`),
    upsertInterviewRequest: (payload) => api.post('/user/interview-requests', payload),
    updateInterviewRequestStatus: (applicationId, status) =>
        api.patch(`/user/interview-requests/${applicationId}/status`, { status }),
    deleteInterviewRequest: (applicationId) => api.delete(`/user/interview-requests/${applicationId}`),

    // Developer-side: interview requests assigned to me
    // (`assigned_developer_id = current user`). Used by the developer
    // dashboard to show the developer's active pipeline.
    listAssignedRequests: () => api.get('/user/developer/assigned-requests'),
    getAssignedRequestSummary: () => api.get('/user/developer/assigned-requests/summary'),

    // Developer profile (the developer manages their own technical
    // skills, availability, resume + contact channels). Email +
    // Telegram are required; the rest are optional.
    getDeveloperProfile: () => api.get('/user/developer/profile'),
    updateDeveloperProfile: (payload) =>
        api.put('/user/developer/profile', payload),
    uploadDeveloperResume: (filename, content) =>
        api.post('/user/developer/profile/resume', { filename, content }),

    // Milestone workflow (2026-07 rewrite). Old `/interview-milestones/*`
    // paths are kept as server-side aliases for backward compatibility,
    // but the canonical path is now `/milestones/*`.
    listMilestones: (applicationId) => api.get(`/user/milestones/${applicationId}`),
    addMilestone: (applicationId, payload) =>
        api.post(`/user/milestones/${applicationId}`, payload),
    completeMilestone: (applicationId, payload = {}) =>
        api.post(`/user/milestones/${applicationId}/complete`, payload),
    updateMilestone: (id, payload) =>
        api.patch(`/user/milestones/${id}`, payload),
    deleteMilestone: (id) => api.delete(`/user/milestones/${id}`),
    assignDeveloper: (interviewRequestId, developerId) =>
        api.post(`/admin/interview-requests/${interviewRequestId}/assign-developer`, { developer_id: developerId || null }),
    setApplicationFlags: (applicationId, { success, failed, cancelled }) =>
        api.patch(`/admin/applications/${applicationId}/flags`, { success: !!success, failed: !!failed, cancelled: !!cancelled }),
    listDevelopers: () => api.get('/admin/developers')
};

// Caller API (Read-only)
export const callerAPI = {
    getApplications: () => api.get('/caller/applications'),
    getApplication: (id) => api.get(`/caller/applications/${id}`),
    downloadResume: async (filename) => {
        const response = await api.get(`/caller/resumes/${filename}`, {
            responseType: 'blob'
        });
        // Create download link
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
    },
    // Caller-entered profile info (free-form text, one row per caller)
    getProfile: () => api.get('/caller/profile'),
    saveProfile: (data) => api.post('/caller/profile', data),

    // Caller resume upload (base64 JSON, no multipart dependency needed
    // server-side). `file` is a browser File object.
    uploadProfileResume: async (file) => {
        const data_base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        return api.post('/caller/profile/resume', {
            filename: file.name,
            data_base64
        });
    },
    downloadProfileResume: async () => {
        const res = await api.get('/caller/profile/resume', { responseType: 'blob' });
        // Try to extract filename from Content-Disposition; fall back to
        // a sensible default.
        const cd = res.headers?.['content-disposition'] || '';
        const m = cd.match(/filename="?([^"]+)"?/i);
        const filename = m?.[1] || 'resume';
        const url = window.URL.createObjectURL(new Blob([res.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', filename);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
    },
    deleteProfileResume: () => api.delete('/caller/profile/resume')
};

// Manager API
export const managerAPI = {
    getProfiles: () => api.get('/manager/profiles'),
    getProfile: (id) => api.get(`/manager/profiles/${id}`),
    createProfile: (data) => api.post('/manager/profiles', data),
    updateProfile: (id, data) => api.put(`/manager/profiles/${id}`, data),
    applyAutofillDefaultsToAll: (data) => api.post('/manager/profiles/autofill-defaults', data),
    deleteProfile: (id) => api.delete(`/manager/profiles/${id}`),
    getUsers: () => api.get('/manager/users'),
    createUser: (data) => api.post('/manager/users', data),
    deleteUser: (id) => api.delete(`/manager/users/${id}`)
};

export default api;
