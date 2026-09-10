import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
    CheckCircle2,
    Copy,
    Download,
    FileText,
    Mail,
    RefreshCw,
    Send,
    Sparkles,
    XCircle,
    MessageCircle,
    User as UserIcon,
    Search
} from 'lucide-react';
import { userAPI } from '../../api';
import { PageLoader, Loader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/context/AuthContext';
import { writeCvQualityCache } from './CvQualityReport';
import {
    restoreGenerateSessionFromStorage,
    subscribeGenerateSession,
    startGenerateSession,
    clearGenerateSession,
    getGenerateSession,
    getGenerateFormSnapshot,
    isGenerateRunning
} from '@/lib/generateResumeSession';

// Available tech stack / core skill options for the multi-select
const SKILL_OPTIONS = [
    '.NET',
    'Python',
    'Java',
    'Golang',
    'TypeScript',
    'JavaScript',
    'HTML',
    'CSS',
    'SQL',
    'Ruby on Rails',
    'Node.js',
    'React frontend',
    'Angular frontend',
    'Linux',
    'Ansible',
    'Terraform',
    'Prometheus',
    'Grafana',
    'Jenkins',
    'GitHub Actions',
    'Docker',
    'Kubernetes',
    'Postgres',
    'MySQL',
    'MongoDB',
    'Redis',
    'TCP/IP'
];

/** Always-on baseline stacks merged into Core Skills when missing. */
const DEFAULT_BASELINE_SKILLS = [
    'TypeScript',
    'JavaScript',
    'HTML',
    'CSS',
    'SQL'
];

function toggleSkill(current, skill) {
    return current.includes(skill)
        ? current.filter(s => s !== skill)
        : [...current, skill];
}

// "applied" / "pending" / "interview" / "rejected" → display label.
// Centralised here so the Lookup badge and the success banner stay in
// sync with the rest of the app (badge variants in admin tables, etc.).
export const LOOKUP_STATUS_META = {
    pending:   { label: 'Not yet applied', variant: 'muted' },
    applied:   { label: 'Applied',         variant: 'info' },
    interview: { label: 'Interview',       variant: 'success' },
    rejected:  { label: 'Rejected',        variant: 'destructive' }
};
function formatLookupStatus(status) {
    if (!status) return 'Status unknown';
    const meta = LOOKUP_STATUS_META[status];
    return meta ? meta.label : status;
}

// Versioned key for the clipboard envelope. Bump if the shape changes
// in a backwards-incompatible way.
const JOB_DETAILS_CLIPBOARD_VERSION = 1;
const JOB_DETAILS_MAGIC = '__JOB_DETAILS_PAYLOAD__';

/** Persist Generate-page form + CV result across navigation (same tab). */
const GENERATE_DRAFT_KEY = 'job_apply_generate_draft_v1';

function readGenerateDraft() {
    try {
        const raw = sessionStorage.getItem(GENERATE_DRAFT_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : null;
    } catch {
        return null;
    }
}

function writeGenerateDraft(draft) {
    try {
        sessionStorage.setItem(
            GENERATE_DRAFT_KEY,
            JSON.stringify({ ...draft, savedAt: Date.now() })
        );
    } catch (err) {
        console.warn('[ResumeGenerator] draft save failed', err?.message || err);
    }
}

function clearGenerateDraft() {
    try {
        sessionStorage.removeItem(GENERATE_DRAFT_KEY);
    } catch {
        /* ignore */
    }
}

function draftForProfile(routeProfileId) {
    const d = readGenerateDraft();
    if (!d) return null;
    const dp = String(d.profileId || '');
    const rp = String(routeProfileId || '');
    if (dp === rp) return d;
    // Draft saved before a profile was chosen, or open /generate without :id
    if (!dp || !rp) return d;
    return null;
}

/** Prefer an in-flight generate's form snapshot, else the saved draft. */
function formSeedForProfile(routeProfileId) {
    const session = restoreGenerateSessionFromStorage() || getGenerateSession();
    if (
        session
        && session.formSnapshot
        && String(session.profileId) === String(routeProfileId || '')
    ) {
        const snap = session.formSnapshot;
        const draft = draftForProfile(routeProfileId) || {};
        return {
            ...draft,
            jobDescription: snap.jobDescription || draft.jobDescription || '',
            companyName: snap.companyName || draft.companyName || '',
            jobRole: snap.jobRole || draft.jobRole || '',
            jobUrl: snap.jobUrl || draft.jobUrl || '',
            coreSkills: Array.isArray(snap.coreSkills) && snap.coreSkills.length
                ? snap.coreSkills
                : (draft.coreSkills || []),
            selectedFont: snap.selectedFont || draft.selectedFont || 'Arial'
        };
    }
    return draftForProfile(routeProfileId);
}

// Build the JSON envelope that the paste handler will recognise.
function buildJobDetailsPayload({ companyName, jobRole, coreSkills, jobUrl, jobDescription }) {
    return JSON.stringify({
        magic: JOB_DETAILS_MAGIC,
        version: JOB_DETAILS_CLIPBOARD_VERSION,
        company_name: companyName || '',
        job_role: jobRole || '',
        core_skills: Array.isArray(coreSkills) ? coreSkills.join(', ') : (coreSkills || ''),
        job_url: jobUrl || '',
        job_description: jobDescription || ''
    });
}

// Try to extract job details from arbitrary clipboard text. Returns null
// when the text is not a recognisable payload.
function parseJobDetailsPayload(text) {
    if (!text || typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.magic === JOB_DETAILS_MAGIC) {
            return {
                company_name: obj.company_name || '',
                job_role: obj.job_role || '',
                core_skills: obj.core_skills || '',
                job_url: obj.job_url || '',
                job_description: obj.job_description || ''
            };
        }
    } catch (_) {
        // Not valid JSON; fall through.
    }
    return null;
}

/** boards.greenhouse.io/acme/jobs/123 or ?for=acme → Acme */
function extractCompanyFromJobUrl(jobUrl) {
    if (!jobUrl || typeof jobUrl !== 'string') return '';
    try {
        const u = new URL(jobUrl.trim());
        const host = u.hostname.replace(/^www\./, '').toLowerCase();
        const parts = u.pathname.split('/').filter(Boolean);
        const generic = new Set([
            'linkedin', 'indeed', 'greenhouse', 'lever', 'workday', 'ashby',
            'jobs', 'job', 'careers', 'job-boards', 'boards', 'embed'
        ]);
        let slug = '';
        const forParam = u.searchParams.get('for');
        if (forParam && !generic.has(forParam.toLowerCase())) {
            slug = forParam;
        } else if (host.includes('greenhouse.io') && parts.length >= 1) {
            slug = parts[0] === 'embed' ? (parts[1] || forParam || '') : parts[0];
        } else if ((host.includes('lever.co') || host.includes('ashbyhq.com')) && parts.length >= 1) {
            slug = parts[0];
        }
        if (!slug || generic.has(slug.toLowerCase())) return '';
        if (/^(jobs?|careers?|job-boards?|boards?|embed)$/i.test(slug)) {
            slug = parts[1] || forParam || '';
        }
        if (!slug || generic.has(slug.toLowerCase())) return '';
        return slug
            .split(/[-_]+/)
            .filter(Boolean)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    } catch {
        return '';
    }
}

/** Prefer stacks named in the JD (avoids selecting every profile stack). */
function inferCoreSkillsFromJd(jobDescription) {
    const text = String(jobDescription || '').toLowerCase();
    const rules = [
        { skill: 'Python', re: /\bpython\b|\bnumpy\b|\bscipy\b|\bpandas\b|\bdjango\b|\bflask\b|\bfastapi\b/ },
        { skill: '.NET', re: /\b\.?net\b|\bc#\b|\basp\.?\s*net\b|\bdotnet\b/ },
        { skill: 'Java', re: /\bjava\b|\bspring\b|\bjvm\b/ },
        { skill: 'Golang', re: /\bgolang\b|\bgo(?:lang)?\s*(?:developer|engineer|programmer|lang(?:uage)?)\b|\bgo\s+modules?\b/ },
        { skill: 'TypeScript', re: /\btypescript\b|\bts\b/ },
        { skill: 'JavaScript', re: /\bjavascript\b|\becmascript\b|\bes6\b/ },
        { skill: 'HTML', re: /\bhtml5?\b/ },
        { skill: 'CSS', re: /\bcss3?\b|\bsass\b|\bscss\b|\btailwind\b/ },
        { skill: 'SQL', re: /\bsql\b|\bpl\/?sql\b|\bt-sql\b/ },
        { skill: 'Node.js', re: /\bnode\.?js\b|\bnodejs\b|\bexpress\b|\bnestjs\b/ },
        { skill: 'React frontend', re: /\breact\b|\bnext\.?js\b/ },
        { skill: 'Ruby on Rails', re: /\bruby on rails\b|\brails\b/ },
        { skill: 'Angular frontend', re: /\bangular\b/ },
        { skill: 'Linux', re: /\blinux\b|\bubuntu\b|\brhel\b|\bcentos\b|\bsystemd\b/ },
        { skill: 'Ansible', re: /\bansible\b/ },
        { skill: 'Terraform', re: /\bterraform\b/ },
        { skill: 'Prometheus', re: /\bprometheus\b/ },
        { skill: 'Grafana', re: /\bgrafana\b/ },
        { skill: 'Jenkins', re: /\bjenkins\b/ },
        { skill: 'GitHub Actions', re: /\bgithub\s*actions\b|\bgha\b/ },
        { skill: 'Docker', re: /\bdocker\b/ },
        { skill: 'Kubernetes', re: /\bkubernetes\b|\bk8s\b/ },
        { skill: 'Postgres', re: /\bpostgres(?:ql)?\b/ },
        { skill: 'MySQL', re: /\bmysql\b/ },
        { skill: 'MongoDB', re: /\bmongo(?:db)?\b/ },
        { skill: 'Redis', re: /\bredis\b/ },
        { skill: 'TCP/IP', re: /\btcp\/?ip\b|\bnetworking\b/ }
    ];
    const found = [...DEFAULT_BASELINE_SKILLS];
    for (const r of rules) {
        if (r.re.test(text)) found.push(r.skill);
    }
    return [...new Set(found)].filter((s) => SKILL_OPTIONS.includes(s));
}

function generateErrorMessage(error) {
    if (!error) return 'Failed to generate resume.';
    if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
        return 'Generate timed out after 3 minutes. Try again, or shorten the job description.';
    }
    if (!error.response && error.message === 'Network Error') {
        return 'Network error — is the API running on port 9017?';
    }
    return error.response?.data?.error || error.message || 'Failed to generate resume.';
}

function ResumeGenerator() {
    const { profileId } = useParams();
    const navigate = useNavigate();
    // Current user — used by the lookup badges to decide whether the
    // "Applied by you" badge should fire (matched on `applier_id`).
    const { user: authUser } = useAuth();

    // Restore last Generate session when navigating away and back.
    const restoredDraftRef = useRef(formSeedForProfile(profileId));
    const draftReadyRef = useRef(false);
    const bootJob = restoreGenerateSessionFromStorage();
    const bootMine = !!(bootJob && String(bootJob.profileId) === String(profileId));

    const [profiles, setProfiles] = useState([]);
    const [profile, setProfile] = useState(null);
    const [jobDescription, setJobDescription] = useState(
        () => restoredDraftRef.current?.jobDescription || ''
    );
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(
        () => bootMine && bootJob.status === 'running' && bootJob.kind !== 'regenerate'
    );
    const [result, setResult] = useState(() => {
        if (bootMine && bootJob.status === 'running') return null;
        return restoredDraftRef.current?.result || null;
    });
    // Live elapsed timer while generating / regenerating, plus last finished duration.
    const [genElapsedSec, setGenElapsedSec] = useState(0);
    const genStartedAtRef = useRef(null);
    // Track the current application id separately from `result` so that
    // regenerate / applied / reject flows stay robust even if `result` is
    // mutated by other code paths.
    const [applicationId, setApplicationId] = useState(
        () => restoredDraftRef.current?.applicationId || null
    );
    // Mirror of applicationId in a ref so async click handlers always see
    // the most recent value (avoids stale-closure issues).
    const applicationIdRef = useRef(null);
    useEffect(() => { applicationIdRef.current = applicationId; }, [applicationId]);
    const [error, setError] = useState('');

    // Chat state
    const [chatMessages, setChatMessages] = useState(
        () => (Array.isArray(restoredDraftRef.current?.chatMessages)
            ? restoredDraftRef.current.chatMessages
            : [])
    );
    const [chatInput, setChatInput] = useState('');

    // Font picker only. The template is fixed (the default style spec) —
    // users pick a font, and that selection flows through to every
    // generated DOCX and PDF so the choice is reflected in the output.
    const [allowedFonts, setAllowedFonts] = useState(['Arial']);
    const [selectedFont, setSelectedFont] = useState(
        () => restoredDraftRef.current?.selectedFont || 'Arial'
    );
    const [templateFontPool, setTemplateFontPool] = useState([]);
    // User-built templates (drag-drop template builder). The picker
    // always shows the admin-uploaded default plus the user's own
    // templates; 'admin' / 'user' source lets the server know which
    // table to look the id up in.
    // Template selection is NOT a per-generation choice on this page.
// The admin sets the candidate profile's `preferred_template_id`
// in the admin ProfileForm; the resume generator just reads it and
// applies it. /user/resume-templates is still fetched below so the
// `allowed_fonts` payload lands (font IS a per-generation choice),
// but the templates array itself is now only used for an inline
// info banner ("Template set by admin: …").
const [adminTemplates, setAdminTemplates] = useState([]);
// Template the admin assigned to this profile (read from the
// profile document via /api/user/profiles). Drives the small info
// banner under the Font picker; the wire payload to /generate-
// resume does NOT send any template_id — the server falls through
// to the profile's preferred_template_id automatically.
const [assignedTemplate, setAssignedTemplate] = useState(null);
    const [chatLoading, setChatLoading] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const chatMessagesEndRef = useRef(null);
    const handleGenerateRef = useRef(null);
    const applyGeneratePayloadRef = useRef(null);
    const bidderAutoGenRef = useRef(false);
    const bidderPayloadAppliedRef = useRef(false);
    /** Once true, bidder must never auto-start Customize Resume again this page load. */
    const bidderAutoGenConsumedRef = useRef(false);
    /** Prior route profileId — only wipe form when it actually changes. */
    const prevProfileIdRef = useRef(undefined);
    const resumePreviewRef = useRef(null);
    const [samePageFillHint, setSamePageFillHint] = useState(false);
    const [assistantFillHint, setAssistantFillHint] = useState(false);
    const [formQuestionQueue, setFormQuestionQueue] = useState([]);
    const formQuestionCtxRef = useRef(null);
    const formQuestionQueueRef = useRef([]);
    const jobDescriptionRef = useRef('');
    const resultRef = useRef(null);
    const profileIdRef = useRef(profileId);
    const companyNameRef = useRef('');
    const jobRoleRef = useRef('');
    const answeringBidderRef = useRef(false);

    // Personal info modal state
    const [personalInfoOpen, setPersonalInfoOpen] = useState(false);
    const [copiedField, setCopiedField] = useState(null);

    // Cover letter state
    const [coverLetterOpen, setCoverLetterOpen] = useState(false);
    const [coverLetterGenerating, setCoverLetterGenerating] = useState(false);
    const [coverLetterResult, setCoverLetterResult] = useState(
        () => restoredDraftRef.current?.coverLetterResult || null
    );
    const [coverLetterError, setCoverLetterError] = useState('');
    // AI company detection state (independent of the generated result)
    const [detectedCompany, setDetectedCompany] = useState(
        () => restoredDraftRef.current?.detectedCompany || ''
    );
    const [detectingCompany, setDetectingCompany] = useState(false);

    // New application metadata fields
    const [companyName, setCompanyName] = useState(
        () => restoredDraftRef.current?.companyName || ''
    );
    const [jobRole, setJobRole] = useState(
        () => restoredDraftRef.current?.jobRole || ''
    );
    const [coreSkills, setCoreSkills] = useState(
        () => (Array.isArray(restoredDraftRef.current?.coreSkills)
            ? restoredDraftRef.current.coreSkills
            : [])
    );
    const [jobUrl, setJobUrl] = useState(
        () => restoredDraftRef.current?.jobUrl || ''
    );

    // Regenerate state (separate spinner so the main button is unaffected)
    const [regenerating, setRegenerating] = useState(
        () => bootMine && bootJob.status === 'running' && bootJob.kind === 'regenerate'
    );
    const [bgGenerateJob, setBgGenerateJob] = useState(
        () => (bootJob?.status === 'running' ? bootJob : null)
    );

    // Tick a live stopwatch while generate / regenerate is in flight.
    useEffect(() => {
        const busy = generating || regenerating;
        if (!busy) {
            genStartedAtRef.current = null;
            return undefined;
        }
        const session = getGenerateSession();
        genStartedAtRef.current = session?.startedAt || genStartedAtRef.current || Date.now();
        const tick = () => {
            const started = genStartedAtRef.current || Date.now();
            setGenElapsedSec(Math.max(0, (Date.now() - started) / 1000));
        };
        tick();
        const id = setInterval(tick, 100);
        return () => clearInterval(id);
    }, [generating, regenerating]);

    // Reattach in-flight generate when returning to this page (or this profile).
    useEffect(() => {
        restoreGenerateSessionFromStorage();

        const fillEmptyFromSnapshot = (snap) => {
            if (!snap || typeof snap !== 'object') return;
            if (snap.jobDescription) {
                setJobDescription((prev) => (prev && String(prev).trim() ? prev : snap.jobDescription));
            }
            if (snap.companyName) {
                setCompanyName((prev) => (prev && String(prev).trim() ? prev : snap.companyName));
            }
            if (snap.jobRole) {
                setJobRole((prev) => (prev && String(prev).trim() ? prev : snap.jobRole));
            }
            if (snap.jobUrl) {
                setJobUrl((prev) => (prev && String(prev).trim() ? prev : snap.jobUrl));
            }
            if (Array.isArray(snap.coreSkills) && snap.coreSkills.length) {
                setCoreSkills((prev) => (Array.isArray(prev) && prev.length ? prev : snap.coreSkills));
            }
            if (snap.selectedFont) {
                setSelectedFont((prev) => prev || snap.selectedFont);
            }
        };

        // Immediate restore on mount (session still in memory after SPA nav).
        const boot = getGenerateSession();
        if (boot && String(boot.profileId) === String(profileIdRef.current)) {
            fillEmptyFromSnapshot(boot.formSnapshot || getGenerateFormSnapshot());
        }

        return subscribeGenerateSession((j) => {
            setBgGenerateJob(j?.status === 'running' ? j : null);
            const mine = !!(j && String(j.profileId) === String(profileIdRef.current));
            if (!j) {
                setGenerating(false);
                setRegenerating(false);
                return;
            }
            if (!mine) {
                setGenerating(false);
                setRegenerating(false);
                return;
            }
            if (j.status === 'running') {
                setGenerating(j.kind !== 'regenerate');
                setRegenerating(j.kind === 'regenerate');
                fillEmptyFromSnapshot(j.formSnapshot);
                return;
            }
            if (j.status === 'done' && j.result) {
                applyGeneratePayloadRef.current?.(j.result, { kind: j.kind });
                fillEmptyFromSnapshot(j.formSnapshot);
                setGenerating(false);
                setRegenerating(false);
                clearGenerateSession();
                return;
            }
            if (j.status === 'error') {
                setError(j.errorMessage || 'Failed to generate resume.');
                setGenerating(false);
                setRegenerating(false);
                clearGenerateSession();
                return;
            }
            if (j.status === 'interrupted') {
                setError(
                    'CV generate stopped because the browser reloaded. Click Customize Resume to start again. '
                    + 'You can open other pages while it runs — just stay in this tab (no refresh).'
                );
                fillEmptyFromSnapshot(j.formSnapshot);
                setGenerating(false);
                setRegenerating(false);
                clearGenerateSession();
            }
        });
    }, [profileId]);

    const formatDuration = (seconds) => {
        if (seconds == null || Number.isNaN(Number(seconds))) return null;
        const s = Math.max(0, Number(seconds));
        if (s < 60) return `${s.toFixed(1)}s`;
        const mins = Math.floor(s / 60);
        const rem = (s % 60).toFixed(1);
        return `${mins}m ${rem}s`;
    };

    const markedGenerationTime = (data) => {
        const total = data?.generation_seconds != null
            ? formatDuration(data.generation_seconds)
            : (data?.generation_ms != null ? formatDuration(data.generation_ms / 1000) : null);
        if (!total) return null;
        const llm = data?.llm_ms != null ? formatDuration(data.llm_ms / 1000) : null;
        if (llm) return `Generated in ${total} (LLM ${llm})`;
        return `Generated in ${total}`;
    };

    // Applied/Reject flow state
    const [applying, setApplying] = useState(false);
    const [rejectModalOpen, setRejectModalOpen] = useState(false);
    const [rejectReason, setRejectReason] = useState('');
    const [rejectSubmitting, setRejectSubmitting] = useState(false);
    const [rejectError, setRejectError] = useState('');

    // Clipboard copy/paste feedback for job details
    const [clipboardStatus, setClipboardStatus] = useState({ type: '', message: '' });
    useEffect(() => {
        if (!clipboardStatus.message) return;
        const t = setTimeout(() => setClipboardStatus({ type: '', message: '' }), 3000);
        return () => clearTimeout(t);
    }, [clipboardStatus]);

    // URL → application lookup. When the user pastes a job link they've used
    // before, hitting "Lookup" pulls the matching application's company / role /
    // skills / description back from `job_applications.job_url` and fills the
    // form. No scraping, no AI — just a database match.
    const [lookupBusy, setLookupBusy] = useState(false);
    const [lookupStatus, setLookupStatus] = useState({ type: '', message: '' });
    // Captured when the user hits "Lookup" successfully. We keep the
    // application id, status, state, and company name around so the UI
    // can show status badges next to the button until the user changes
    // the URL again or clears the form.
    const [lookupMatched, setLookupMatched] = useState({
        applicationId: null,
        status: '',
        // Lifecycle state — drives the "Available / Unavailable" badge.
        // Values: 'in_progress' | 'completed' | 'cancelled' | 'rejected'
        state: '',
        // Stored rejection reason (used as the "Unavailable" tooltip).
        rejectReason: '',
        companyName: '',
        // id + resolved username of the user who actually applied this
        // job. Drives the "Applied by you / Not yet applied" badge.
        applierId: null,
        applierUsername: '',
        // `true` when the matched application is owned by the current user,
        // `false` when it belongs to another user (global match).
        ownedByCurrentUser: true,
        // Comma-separated usernames of the users assigned to the profile
        // that owns the matched application.
        assignedUsers: []
    });
    useEffect(() => {
        if (!lookupStatus.message) return;
        const t = setTimeout(() => setLookupStatus({ type: '', message: '' }), 4500);
        return () => clearTimeout(t);
    }, [lookupStatus]);

    const handleLookupByUrl = async () => {
        const url = (jobUrl || '').trim();
        if (!url) {
            setLookupStatus({ type: 'error', message: 'Paste a job URL first.' });
            return;
        }
        setLookupBusy(true);
        setLookupStatus({ type: '', message: '' });
        try {
            const res = await userAPI.lookupJobByUrl(url);
            const data = res?.data || {};
            if (!data.found) {
                setLookupStatus({
                    type: 'error',
                    message: 'No matching application found for this URL.'
                });
                return;
            }
            // Fill the form. Never overwrite values that the user hasn't
            // touched in the current session — easier to recognise what the
            // lookup actually changed.
            const wasEmpty = !jobDescription.trim() && !companyName.trim() && !jobRole.trim() && coreSkills.length === 0;
            let filled = [];
            if (data.company_name && !companyName) { setCompanyName(data.company_name); filled.push('company'); }
            if (data.job_role && !jobRole)         { setJobRole(data.job_role);         filled.push('role'); }
            if (data.core_skills && coreSkills.length === 0) {
                // core_skills from the DB is a single comma-separated string;
                // restore any pills that match the recognised SKILL_OPTIONS,
                // stash the raw value too so the user can adjust manually.
                const skillList = String(data.core_skills)
                    .split(/[,;|]/)
                    .map(s => s.trim())
                    .filter(Boolean);
                const matched = skillList.filter(s => SKILL_OPTIONS.includes(s));
                if (matched.length) {
                    setCoreSkills(matched);
                    filled.push(`${matched.length} skill${matched.length === 1 ? '' : 's'}`);
                } else {
                    // None of the stored skills match our checkbox list — surface
                    // the raw text so we don't silently drop information.
                    setJobDescription(prev => prev || data.core_skills);
                }
            }
            if (data.job_description && !jobDescription.trim()) {
                setJobDescription(data.job_description);
                filled.push('description');
            }
            // Remember the matched-application status so we can show a badge
            // next to the Lookup button and inside the success banner.
            const assignedUsers = Array.isArray(data.assigned_users) ? data.assigned_users : [];
            const ownedByCurrentUser = data.owned_by_current_user !== false; // default true
            setLookupMatched({
                applicationId: data.application_id || null,
                status: data.status || '',
                state: data.state || 'in_progress',
                rejectReason: data.reject_reason || '',
                companyName: data.company_name || '',
                applierId: data.applier_id || null,
                applierUsername: data.applier_username || '',
                ownedByCurrentUser,
                assignedUsers
            });

            // Build a human-friendly "applied by …" tail when the match
            // belongs to another user. This makes it clear that the
            // lookup hit a global row, not the caller's own.
            const ownerTail = ownedByCurrentUser
                ? ''
                : (assignedUsers.length
                    ? ` — applied by ${assignedUsers.join(', ')}`
                    : ' — applied by another user');

            setLookupStatus({
                type: 'success',
                message: wasEmpty
                    ? `✅ Filled from previous application #${data.application_id} (${formatLookupStatus(data.status)})${ownerTail}`
                    : `✅ ${ownedByCurrentUser ? 'Matched' : 'Global match on'} previous application #${data.application_id}${filled.length ? ` (filled: ${filled.join(', ')})` : ''} — ${formatLookupStatus(data.status)}${ownerTail}`
            });
        } catch (err) {
            console.error('[handleLookupByUrl] error', err);
            setLookupStatus({
                type: 'error',
                message: err.response?.data?.error || 'Lookup failed. Please try again.'
            });
        } finally {
            setLookupBusy(false);
        }
    };

    useEffect(() => {
        // When the route profile changes: swap candidate-bound CV output, but
        // keep the job form (company / role / JD / URL / skills). Switching
        // profiles is "same job, different candidate" — wiping the form made
        // Customize Resume look broken / "reformatted" after a switch.
        const bidderPending = (() => {
            try {
                return !!sessionStorage.getItem('job_apply_bidder_pending');
            } catch {
                return false;
            }
        })();
        const keepJobForm = bidderPending || bidderPayloadAppliedRef.current || generating || regenerating;

        const prevProfileId = prevProfileIdRef.current;
        const isFirstMount = prevProfileId === undefined;
        prevProfileIdRef.current = profileId;
        profileIdRef.current = profileId;

        // Keep showing the previous profile card until the new one loads
        // (avoid empty "Select a profile" flash that unmounts the form).
        if (!profileId) setProfile(null);

        if (!isFirstMount && prevProfileId !== profileId && !keepJobForm) {
            // Picking a profile for the first time (/generate → /generate/:id): keep the form.
            if (!prevProfileId && profileId) {
                // keep current in-memory fields; draft save effect will retarget profileId
            } else {
                const nextDraft = draftForProfile(profileId);
                // Always clear prior candidate's CV output unless this profile
                // already has a saved draft result.
                setResult(nextDraft?.result || null);
                setApplicationId(nextDraft?.applicationId || null);
                applicationIdRef.current = nextDraft?.applicationId || null;
                setChatMessages(Array.isArray(nextDraft?.chatMessages) ? nextDraft.chatMessages : []);
                setCoverLetterResult(nextDraft?.coverLetterResult || null);
                setError('');
                // Fill job fields only when the live form is empty (e.g. landed
                // on a profile with a draft). Never overwrite a filled form.
                const draftSkills = Array.isArray(nextDraft?.coreSkills) ? nextDraft.coreSkills : [];
                setJobDescription((prev) => (prev && String(prev).trim() ? prev : (nextDraft?.jobDescription || '')));
                setCompanyName((prev) => (prev && String(prev).trim() ? prev : (nextDraft?.companyName || '')));
                setJobRole((prev) => (prev && String(prev).trim() ? prev : (nextDraft?.jobRole || '')));
                setJobUrl((prev) => (prev && String(prev).trim() ? prev : (nextDraft?.jobUrl || '')));
                setCoreSkills((prev) => (Array.isArray(prev) && prev.length ? prev : draftSkills));
                if (nextDraft?.selectedFont) setSelectedFont(nextDraft.selectedFont);
                if (nextDraft?.detectedCompany) {
                    setDetectedCompany((prev) => prev || nextDraft.detectedCompany);
                }
            }
        } else if (isFirstMount) {
            // Keep restored draft; still refresh chat only if draft had none.
            if (!restoredDraftRef.current) {
                setChatMessages([]);
            }
        }

        draftReadyRef.current = true;
        setLoading(true);

        if (profileId) {
            loadProfile();
        } else {
            setLoading(false);
        }
        loadProfiles();
    }, [profileId]);

    // Persist Generate form + CV preview so leaving the page does not wipe work.
    // Keep writing while generating so company / JD / stacks survive leave/return.
    useEffect(() => {
        if (!draftReadyRef.current) return;
        const hasContent = !!(
            (jobDescription && String(jobDescription).trim())
            || (companyName && String(companyName).trim())
            || (jobRole && String(jobRole).trim())
            || (jobUrl && String(jobUrl).trim())
            || (Array.isArray(coreSkills) && coreSkills.length)
            || result
            || applicationId
            || generating
            || regenerating
        );
        if (!hasContent) return;
        writeGenerateDraft({
            profileId: profileId || null,
            jobDescription,
            companyName,
            jobRole,
            jobUrl,
            coreSkills,
            selectedFont,
            // Don't clobber a prior CV preview with null while a new run is in flight.
            result: (generating || regenerating) ? (result || readGenerateDraft()?.result || null) : result,
            applicationId: (generating || regenerating)
                ? (applicationId || readGenerateDraft()?.applicationId || null)
                : applicationId,
            chatMessages,
            coverLetterResult,
            detectedCompany
        });
    }, [
        profileId,
        jobDescription,
        companyName,
        jobRole,
        jobUrl,
        coreSkills,
        selectedFont,
        result,
        applicationId,
        chatMessages,
        coverLetterResult,
        detectedCompany,
        generating,
        regenerating
    ]);

    // Separate effect for chat scroll
    useEffect(() => {
        if (chatMessagesEndRef.current) {
            chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [chatOpen, chatMessages, chatLoading]);

    // One-shot fetcher for /user/resume-templates. We only need the
    // `allowed_fonts` payload here (the Font picker is a real
    // per-generation choice). The `templates` array is loaded too
    // so we can resolve the "assigned template" name in the info
    // banner — but the template is set by the admin on the profile,
    // not on this page.
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await userAPI.listTemplates();
                const data = res?.data || {};
                if (cancelled) return;
                if (Array.isArray(data.allowed_fonts) && data.allowed_fonts.length) {
                    setAllowedFonts(data.allowed_fonts);
                }
                if (Array.isArray(data.templates)) {
                    setAdminTemplates(data.templates);
                }
            } catch (err) {
                // Non-fatal — Font picker falls back to defaults.
                console.warn('[ResumeGenerator] failed to load templates', err);
            }
        };
        load();
        return () => { cancelled = true; };
    }, []);

    // Chrome extension / bidder bridge: paste JD into this page and
    // optionally auto-start Customize Resume so the user can watch progress.
    useEffect(() => {
        const applyBidderPayload = (data, { allowAutoGenerate = true } = {}) => {
            if (!data || typeof data !== 'object') return false;

            // After the first auto-generate has been armed/started, ignore
            // repeated extension injects so we never loop Customize Resume.
            const locked = bidderAutoGenConsumedRef.current;

            if (!locked) {
                const url = data.job_url ? String(data.job_url) : '';
                const fromUrl = extractCompanyFromJobUrl(url);
                const company = (data.company_name && String(data.company_name).trim())
                    || fromUrl
                    || '';
                if (company) setCompanyName(company);
                if (data.job_role) setJobRole(String(data.job_role));
                if (url) setJobUrl(url);
                if (data.job_description) setJobDescription(String(data.job_description));
                if (data.font_family) setSelectedFont(String(data.font_family));

                // Prefer stacks named in the JD over a full profile dump.
                const fromJd = inferCoreSkillsFromJd(data.job_description || '');
                if (fromJd.length) {
                    setCoreSkills(fromJd);
                } else if (data.core_skills) {
                    const skillList = String(data.core_skills)
                        .split(/[,;|]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    const matched = skillList.filter((s) => SKILL_OPTIONS.includes(s));
                    if (matched.length) setCoreSkills(matched);
                }
            } else {
                // Fill only blank fields — never restart generate.
                if (data.company_name) {
                    setCompanyName((prev) => (prev && prev.trim() ? prev : String(data.company_name)));
                } else if (data.job_url) {
                    const fromUrl = extractCompanyFromJobUrl(String(data.job_url));
                    if (fromUrl) {
                        setCompanyName((prev) => (prev && prev.trim() ? prev : fromUrl));
                    }
                }
                if (data.job_role) {
                    setJobRole((prev) => (prev && prev.trim() ? prev : String(data.job_role)));
                }
                if (data.job_url) {
                    setJobUrl((prev) => (prev && prev.trim() ? prev : String(data.job_url)));
                }
                if (data.job_description) {
                    setJobDescription((prev) => (prev && prev.trim() ? prev : String(data.job_description)));
                }
            }

            if (
                allowAutoGenerate
                && data.auto_generate
                && !bidderAutoGenConsumedRef.current
            ) {
                bidderAutoGenRef.current = true;
            }
            if (data.same_page_fill) setSamePageFillHint(true);
            bidderPayloadAppliedRef.current = true;
            return true;
        };

        const consumeSession = () => {
            try {
                const raw = sessionStorage.getItem('job_apply_bidder_pending');
                if (!raw) return false;
                const parsed = JSON.parse(raw);
                const ok = applyBidderPayload(parsed, { allowAutoGenerate: true });
                // Keep payload until JD actually landed (survives Strict Mode remount).
                if (ok && parsed?.job_description) {
                    sessionStorage.removeItem('job_apply_bidder_pending');
                }
                return ok;
            } catch (_) {
                return false;
            }
        };

        consumeSession();

        const onMsg = (event) => {
            if (event.data?.type === 'JOB_APPLY_BIDDER_FILL' && event.data.payload) {
                // Retries from the extension must not re-arm auto_generate.
                const isRetry = !!event.data.retry;
                applyBidderPayload(event.data.payload, { allowAutoGenerate: !isRetry });
            }
        };
        window.addEventListener('message', onMsg);

        // Extension may inject slightly after React mounts.
        const poll = setInterval(() => {
            if (bidderPayloadAppliedRef.current) {
                clearInterval(poll);
                return;
            }
            consumeSession();
        }, 400);
        const stop = setTimeout(() => clearInterval(poll), 20000);

        return () => {
            window.removeEventListener('message', onMsg);
            clearInterval(poll);
            clearTimeout(stop);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount / profile route only
    }, [profileId]);

    // Deep-link from Auto Bidder Control Panel: ?applicationId= or ?regenerate=
    useEffect(() => {
        if (!profileId) return undefined;
        let cancelled = false;
        const params = new URLSearchParams(window.location.search || '');
        const rawId = params.get('applicationId') || params.get('regenerate');
        const appId = rawId ? parseInt(rawId, 10) : NaN;
        if (!Number.isFinite(appId) || appId <= 0) return undefined;

        const hydrate = async () => {
            try {
                const { data } = await userAPI.getApplications(profileId, { limit: 100, page: 1 });
                if (cancelled) return;
                const list = Array.isArray(data?.applications) ? data.applications : (Array.isArray(data) ? data : []);
                const app = list.find((a) => Number(a.id) === appId);
                if (!app) return;

                setApplicationId(app.id);
                applicationIdRef.current = app.id;
                if (app.company_name) {
                    setCompanyName((prev) => (prev && prev.trim() && !/^unknown$/i.test(prev)
                        ? prev
                        : String(app.company_name)));
                }
                if (app.job_role) {
                    setJobRole((prev) => (prev && prev.trim() ? prev : String(app.job_role)));
                }
                if (app.job_url) {
                    setJobUrl((prev) => (prev && prev.trim() ? prev : String(app.job_url)));
                }
                if (app.job_description) {
                    setJobDescription((prev) => (prev && prev.trim() ? prev : String(app.job_description)));
                }
                if (app.core_skills) {
                    const skillList = String(app.core_skills)
                        .split(/[,;|]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    const matched = skillList.filter((s) => SKILL_OPTIONS.includes(s));
                    if (matched.length) {
                        setCoreSkills((prev) => (Array.isArray(prev) && prev.length ? prev : matched));
                    }
                }
                if (app.resume_filename || app.draft_html) {
                    setResult((prev) => prev || {
                        application_id: app.id,
                        resume_filename: app.resume_filename || null,
                        draft_html: app.draft_html || null,
                        company_name: app.company_name || '',
                        job_role: app.job_role || ''
                    });
                }
            } catch (err) {
                console.warn('[ResumeGenerator] applicationId hydrate failed', err);
            }
        };
        hydrate();
        return () => { cancelled = true; };
    }, [profileId]);

    // Prefill company from job URL whenever the URL is set and company is empty.
    useEffect(() => {
        if (!jobUrl || (companyName && companyName.trim() && !/^unknown$/i.test(companyName))) return;
        const fromUrl = extractCompanyFromJobUrl(jobUrl);
        if (fromUrl) setCompanyName(fromUrl);
    }, [jobUrl, companyName]);

    // After bidder payload lands and profile is ready, start generate ONCE.
    useEffect(() => {
        if (!bidderAutoGenRef.current) return;
        if (bidderAutoGenConsumedRef.current) return;
        if (loading || !profile || generating || regenerating) return;
        if (!jobDescription.trim() || !(Array.isArray(coreSkills) ? coreSkills : []).length) return;

        bidderAutoGenRef.current = false;
        bidderAutoGenConsumedRef.current = true;

        const t = setTimeout(() => {
            handleGenerateRef.current?.();
        }, 300);
        return () => clearTimeout(t);
    }, [loading, profile, jobDescription, coreSkills, generating, regenerating]);

    const loadProfiles = async () => {
        try {
            const response = await userAPI.getProfiles();
            const list = Array.isArray(response.data) ? response.data : [];
            setProfiles(list);
            if (!profileId) {
                const preferred = list.find((p) => p.is_default) || list[0];
                if (preferred?.id) {
                    navigate(`/user/generate/${preferred.id}`, { replace: true });
                    return;
                }
                setLoading(false);
            }
        } catch (error) {
            console.error('Failed to load profiles:', error);
            setProfiles([]);
            setLoading(false);
        }
    };

    const loadProfile = async () => {
        const requestedId = profileId;
        try {
            const response = await userAPI.getProfile(requestedId);
            if (String(profileIdRef.current) !== String(requestedId)) return;
            setProfile(response.data);
            // Resolve the admin-assigned template name. The server
            // JOINs the right template table based on
            // preferred_template_kind ('admin' = resume_templates,
            // 'user' = user_resume_templates) so the name lands
            // here regardless of which kind the admin picked.
            // When `preferred_template_id` is null the JOIN
            // returns no row and we fall back to "System default".
            const tid = response.data?.preferred_template_id;
            const tname = response.data?.preferred_template_name;
            const tkind = response.data?.preferred_template_kind || 'admin';
            if (tid != null && tname) {
                setAssignedTemplate({
                    id: tid,
                    name: tname,
                    is_default: !!response.data?.preferred_template_is_default,
                    kind: tkind,
                    owner: response.data?.preferred_template_owner || null
                });
                // Seed the Font picker from the assigned template's body
                // font so template-builder choices aren't overwritten by
                // the hardcoded Arial default on every generate.
                if (tkind === 'user' && tid != null) {
                    try {
                        const tplRes = await userAPI.getUserTemplate(tid);
                        if (String(profileIdRef.current) !== String(requestedId)) return;
                        const spec = tplRes?.data?.template?.style_spec || {};
                        const pool = Array.isArray(spec.body?.font_pool) && spec.body.font_pool.length
                            ? spec.body.font_pool
                            : (spec.body?.font || spec.fonts?.body ? [spec.body?.font || spec.fonts?.body] : []);
                        setTemplateFontPool(pool.filter(Boolean));
                        // Prefer the template body font (stable). Only keep
                        // "__random__" if the user already chose it.
                        const bodyFont = spec.body?.font || spec.fonts?.body || pool[0];
                        setSelectedFont((prev) => (
                            prev && prev !== '__random__' ? prev : (bodyFont || 'Arial')
                        ));
                    } catch (tplErr) {
                        console.warn('[ResumeGenerator] failed to load template font', tplErr);
                        setTemplateFontPool([]);
                    }
                } else {
                    setTemplateFontPool([]);
                }
            } else {
                setAssignedTemplate(null);
            }
        } catch (error) {
            console.error('Failed to load profile:', error);
            if (String(profileIdRef.current) === String(requestedId)) {
                navigate('/user/generate');
            }
        } finally {
            if (String(profileIdRef.current) === String(requestedId)) {
                setLoading(false);
            }
        }
    };

    // Triggered by the profile selector <select>. Clears prior CV output,
    // switches the route to the new profile, and keeps the job form intact.
    const handleProfileSelect = (e) => {
        const value = e?.target?.value;
        if (!value) return;
        if (String(value) === String(profileId)) return;
        // Clear current generation output when switching profiles (job form stays).
        setResult(null);
        setApplicationId(null);
        applicationIdRef.current = null;
        setError('');
        navigate(`/user/generate/${value}`);
    };

    // Helper: treat anything that is not a positive integer as "missing".
    const isValidAppId = (v) => Number.isInteger(v) && v > 0;

    const applyGeneratePayload = (data, { kind } = {}) => {
        if (!data) return;
        if (data.resume_html && !data.resume_content) data.resume_content = data.resume_html;
        if (data.resume_content && !data.resume_html) data.resume_html = data.resume_content;
        if (data.font_family && data.font_family !== '__random__') {
            setSelectedFont(data.font_family);
        }
        if (kind === 'regenerate') {
            setResult((prev) => ({
                ...(prev || {}),
                ...data,
                resume_content: data.resume_html || data.resume_content,
                resume_html: data.resume_html || data.resume_content,
                preview_css: data.preview_css || prev?.preview_css || ''
            }));
        } else {
            setResult(data);
        }
        if (data.company_name && data.company_name !== 'Unknown') {
            setCompanyName((prev) => (prev && prev.trim() && prev !== 'Unknown' ? prev : data.company_name));
        }
        if (data.job_role) {
            setJobRole((prev) => (prev && String(prev).trim() ? prev : data.job_role));
        }
        if (data.job_url) {
            setJobUrl((prev) => (prev && String(prev).trim() ? prev : data.job_url));
        }
        if (data.job_description) {
            setJobDescription((prev) => (prev && String(prev).trim() ? prev : data.job_description));
        }
        if (data.core_skills) {
            const skillList = String(data.core_skills)
                .split(/[,;|]/)
                .map((s) => s.trim())
                .filter(Boolean);
            if (skillList.length) {
                setCoreSkills((prev) => (Array.isArray(prev) && prev.length ? prev : skillList));
            }
        }
        const resolvedId = isValidAppId(data.application_id) ? data.application_id : null;
        if (resolvedId) {
            setApplicationId(resolvedId);
            applicationIdRef.current = resolvedId;
            setResult((prev) => ({ ...(prev || {}), application_id: resolvedId }));
        }
        if (data.quality_report) {
            writeCvQualityCache({
                application_id: resolvedId || data.application_id,
                company_name: data.company_name || companyName,
                job_role: data.job_role || jobRole,
                profile_id: profileId,
                quality_report: data.quality_report
            });
        }
        setTimeout(() => {
            resumePreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
        try {
            sessionStorage.setItem('job_apply_bidder_show_preview', '1');
        } catch (_) { /* ignore */ }
        if (!data.validation?.pass) {
            setError(
                `Stack check noted issues after ${data.validation_attempts || 1} pass(es). `
                + 'Preview below is still usable — click Regenerate if you want another draft.'
            );
        }
        if (data.quality_report && !data.quality_report.pass) {
            setError((prev) => {
                const q = `CV quality ${data.quality_report.grade} (${data.quality_report.score}%): `
                    + `${data.quality_report.critical_count || 0} critical issue(s). Open CV Quality report.`;
                return prev ? `${prev} ${q}` : q;
            });
        }
        if (!(data.resume_html || data.resume_content)) {
            setError((prev) => prev || 'Generate finished but no resume HTML was returned. Try Regenerate.');
        }
        if (kind !== 'regenerate') {
            try {
                window.postMessage({
                    type: 'JOB_APPLY_BIDDER_GENERATE_DONE',
                    result: {
                        application_id: resolvedId || data.application_id || null,
                        resume_filename: data.resume_filename || null,
                        resume_html: data.resume_html || data.resume_content || '',
                        resume_content: data.resume_content || data.resume_html || '',
                        company_name: companyName || data.company_name || '',
                        job_role: jobRole || data.job_role || '',
                        job_url: jobUrl || data.job_url || '',
                        validation_pass: data.validation?.pass ?? null,
                        is_finalized: !!(data.is_finalized || data.resume_filename),
                        profile_id: parseInt(profileId, 10) || null
                    }
                }, '*');
            } catch (bridgeErr) {
                console.warn('[handleGenerate] extension notify failed', bridgeErr);
            }
        }
    };
    applyGeneratePayloadRef.current = applyGeneratePayload;

    const handleGenerate = async () => {
        const skills = Array.isArray(coreSkills)
            ? coreSkills
            : String(coreSkills || '').split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
        if (!Array.isArray(coreSkills)) setCoreSkills(skills);

        if (!jobDescription.trim()) {
            setError('Please enter a job description');
            return;
        }
        if (skills.length === 0) {
            setError('Select at least one tech stack for this job so the CV can be checked against it');
            return;
        }
        if (!profileId) {
            setError('Select a profile before generating');
            return;
        }
        if (isGenerateRunning()) return;

        setError('');
        setResult(null);
        setApplicationId(null);
        applicationIdRef.current = null;

        let companyForRequest = (companyName || '').trim();
        if (!companyForRequest || /^unknown$/i.test(companyForRequest)) {
            const fromUrl = extractCompanyFromJobUrl(jobUrl);
            if (fromUrl) {
                companyForRequest = fromUrl;
                setCompanyName(fromUrl);
            }
        }

        const activeProfileId = profileId;
        startGenerateSession({
            kind: 'generate',
            profileId: activeProfileId,
            formSnapshot: {
                jobDescription,
                companyName: companyForRequest || companyName,
                jobRole,
                jobUrl,
                coreSkills: skills,
                selectedFont
            },
            run: async () => {
                const response = await userAPI.generateResume(parseInt(activeProfileId, 10), jobDescription, {
                    company_name: companyForRequest,
                    job_role: jobRole,
                    core_skills: skills.join(', '),
                    job_url: jobUrl,
                    font_family: selectedFont
                });
                const data = response.data || {};
                if (data.resume_html && !data.resume_content) data.resume_content = data.resume_html;
                if (data.resume_content && !data.resume_html) data.resume_html = data.resume_content;
                let resolvedId = isValidAppId(data.application_id) ? data.application_id : null;
                if (!resolvedId && data.resume_filename) {
                    try {
                        const lookup = await userAPI.getApplicationByFilename(data.resume_filename);
                        if (isValidAppId(lookup.data?.id)) {
                            resolvedId = lookup.data.id;
                        }
                    } catch (lookupErr) {
                        console.warn('[handleGenerate] by-filename lookup failed', lookupErr);
                    }
                }
                if (resolvedId) data.application_id = resolvedId;
                return data;
            }
        });
    };
    handleGenerateRef.current = handleGenerate;

    const isResumeFinalized = (data) => !!(data?.is_finalized || data?.resume_filename);

    const handleCopyJobDetails = async () => {
        const payload = buildJobDetailsPayload({
            companyName,
            jobRole,
            coreSkills,
            jobUrl,
            jobDescription
        });
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(payload);
            } else {
                // Fallback for older browsers / non-secure contexts
                const textarea = document.createElement('textarea');
                textarea.value = payload;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(textarea);
                if (!ok) throw new Error('execCommand copy failed');
            }
            setClipboardStatus({ type: 'success', message: '✅ Job details copied to clipboard' });
        } catch (err) {
            console.error('[handleCopyJobDetails] error', err);
            setClipboardStatus({ type: 'error', message: '❌ Failed to copy job details' });
        }
    };

    const handlePasteJobDetails = async () => {
        try {
            let text = '';
            if (navigator.clipboard?.readText) {
                text = await navigator.clipboard.readText();
            } else {
                text = window.prompt('Paste your job details JSON here:') || '';
            }
            const parsed = parseJobDetailsPayload(text);
            if (!parsed) {
                setClipboardStatus({
                    type: 'error',
                    message: '❌ Clipboard does not contain job details (use Copy first).'
                });
                return;
            }
            setCompanyName(parsed.company_name);
            setJobRole(parsed.job_role);
            // Restore skill checkboxes; keep only the ones we recognise
            const skillList = parsed.core_skills
                ? parsed.core_skills.split(',').map(s => s.trim()).filter(Boolean)
                : [];
            const validSkills = skillList.filter(s => SKILL_OPTIONS.includes(s));
            setCoreSkills(validSkills);
            setJobUrl(parsed.job_url);
            setJobDescription(parsed.job_description);
            setClipboardStatus({
                type: 'success',
                message: '✅ Job details pasted from clipboard'
            });
        } catch (err) {
            console.error('[handlePasteJobDetails] error', err);
            setClipboardStatus({
                type: 'error',
                message: err.name === 'NotAllowedError'
                    ? '❌ Clipboard read permission denied'
                    : '❌ Failed to paste job details'
            });
        }
    };

    const handleRegenerate = async () => {
        // Resolve a usable identifier: prefer the state, then the ref, then
        // the result object, then fall back to the resume filename.
        const idFromState = isValidAppId(applicationId) ? applicationId : null;
        const idFromRef = isValidAppId(applicationIdRef.current) ? applicationIdRef.current : null;
        const idFromResult = isValidAppId(result?.application_id) ? result.application_id : null;
        const idToUse = idFromState ?? idFromRef ?? idFromResult;
        const filenameFallback = result?.resume_filename || null;

        console.log('[handleRegenerate] clicked', {
            applicationId,
            applicationIdRef: applicationIdRef.current,
            resultApplicationId: result?.application_id,
            filenameFallback,
            using: idToUse
        });

        if (!idToUse && !filenameFallback) {
            setError('Please generate a resume first');
            return;
        }
        if (!jobDescription.trim()) {
            setError('Please enter a job description');
            return;
        }
        if (isGenerateRunning()) return;

        setError('');
        startGenerateSession({
            kind: 'regenerate',
            profileId,
            formSnapshot: {
                jobDescription,
                companyName,
                jobRole,
                jobUrl,
                coreSkills: Array.isArray(coreSkills) ? coreSkills : [],
                selectedFont
            },
            run: async () => {
                const response = await userAPI.regenerateResume({
                    application_id: idToUse || undefined,
                    resume_filename: filenameFallback || undefined,
                    job_description: jobDescription,
                    core_skills: coreSkills.join(', '),
                    font_family: selectedFont,
                });
                return response.data || {};
            }
        });
    };

    const resetForNewApplication = () => {
        clearGenerateDraft();
        setResult(null);
        setApplicationId(null);
        applicationIdRef.current = null;
        setError('');
        setJobDescription('');
        setCompanyName('');
        setJobRole('');
        setCoreSkills([]);
        setJobUrl('');
        setCoverLetterResult(null);
        setCoverLetterError('');
        setDetectedCompany('');
        setChatMessages([]);
        setLookupMatched({
            applicationId: null,
            status: '',
            state: '',
            rejectReason: '',
            companyName: '',
            applierId: null,
            applierUsername: '',
            ownedByCurrentUser: true,
            assignedUsers: []
        });
        setLookupStatus({ type: '', message: '' });
    };

    const handleApplied = async () => {
        // Try the same three sources, and if all are missing, attempt a
        // recovery via the resume filename.
        let idToUse = isValidAppId(applicationId) ? applicationId
            : isValidAppId(applicationIdRef.current) ? applicationIdRef.current
            : isValidAppId(result?.application_id) ? result.application_id
            : null;

        if (!idToUse && result?.resume_filename) {
            try {
                const lookup = await userAPI.getApplicationByFilename(result.resume_filename);
                if (isValidAppId(lookup.data?.id)) {
                    idToUse = lookup.data.id;
                    setApplicationId(idToUse);
                    applicationIdRef.current = idToUse;
                }
            } catch (lookupErr) {
                console.warn('[handleApplied] by-filename lookup failed', lookupErr);
            }
        }

        console.log('[Mark as Applied] clicked', {
            applicationId,
            applicationIdRef: applicationIdRef.current,
            resultApplicationId: result?.application_id,
            using: idToUse
        });
        if (!idToUse) {
            console.warn('[Mark as Applied] missing application_id');
            setError('Please generate a resume first');
            return;
        }
        if (!window.confirm(`Mark this application as APPLIED for ${result.company_name || 'this company'}?`)) return;

        setApplying(true);
        setError('');
        try {
            const res = await userAPI.updateApplicationStatus(idToUse, 'applied');
            console.log('[Mark as Applied] success', res?.data);
            resetForNewApplication();
        } catch (error) {
            console.error('[Mark as Applied] error', error);
            const message = error.response?.data?.error || error.message || 'Failed to mark as applied';
            setError(message);
            window.alert('Failed to mark as applied: ' + message);
        } finally {
            setApplying(false);
        }
    };

    const openRejectModal = () => {
        setRejectReason('');
        setRejectError('');
        setRejectModalOpen(true);
    };

    const closeRejectModal = () => {
        if (rejectSubmitting) return;
        setRejectModalOpen(false);
        setRejectReason('');
        setRejectError('');
    };

    const submitReject = async () => {
        let idToUse = isValidAppId(applicationId) ? applicationId
            : isValidAppId(applicationIdRef.current) ? applicationIdRef.current
            : isValidAppId(result?.application_id) ? result.application_id
            : null;

        if (!idToUse && result?.resume_filename) {
            try {
                const lookup = await userAPI.getApplicationByFilename(result.resume_filename);
                if (isValidAppId(lookup.data?.id)) {
                    idToUse = lookup.data.id;
                    setApplicationId(idToUse);
                    applicationIdRef.current = idToUse;
                }
            } catch (lookupErr) {
                console.warn('[submitReject] by-filename lookup failed', lookupErr);
            }
        }

        if (!idToUse) {
            setRejectError('Please generate a resume first');
            return;
        }
        if (!rejectReason.trim()) {
            setRejectError('Please provide a reject reason');
            return;
        }
        setRejectError('');
        setRejectSubmitting(true);
        try {
            await userAPI.updateApplicationStatus(idToUse, 'rejected', rejectReason.trim());
            setRejectModalOpen(false);
            resetForNewApplication();
        } catch (error) {
            setRejectError(error.response?.data?.error || 'Failed to mark as rejected');
        } finally {
            setRejectSubmitting(false);
        }
    };

    const downloadResume = async (filename, meta = {}) => {
        if (!filename && !meta.application_id) return;
        try {
            const params = {
                filename: filename || undefined,
                profile_id: meta.profile_id || profile?.id || profileId || undefined,
                application_id: meta.application_id || result?.application_id || undefined,
                company_name: meta.company_name || companyName || result?.company_name || '',
                job_role: meta.job_role || jobRole || result?.job_role || '',
                open: 1
            };
            await userAPI.downloadResumeFolder(params);
            const qs = new URLSearchParams();
            Object.entries(params).forEach(([k, v]) => {
                if (v != null && v !== '' && k !== 'open') qs.set(k, String(v));
            });
            window.open(`/api/user/resume-folder?${qs.toString()}`, '_blank');
        } catch (err) {
            console.warn('Folder download failed, falling back to file:', err?.message || err);
            if (filename) window.open(`/resumes/${filename}`, '_blank');
        }
    };

    const pdfFilenameFromDocx = (docxFilename) => {
        if (!docxFilename) return null;
        return String(docxFilename).replace(/\.docx$/i, '.pdf');
    };

    const resolvePdfFilename = (data) => {
        if (data?.resume_pdf_filename) return data.resume_pdf_filename;
        return pdfFilenameFromDocx(data?.resume_filename);
    };

    const downloadSavedPdf = (data) => {
        const pdfName = resolvePdfFilename(data);
        if (!pdfName) return false;
        window.open(`/resumes/${encodeURIComponent(pdfName)}`, '_blank');
        return true;
    };

    // PDF generation state (separate spinner so it doesn't block other actions)
    const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

    const downloadResumeAsPdf = async () => {
        const html = result?.resume_html || result?.resume_content;
        if (!html) return;

        // Prefer a PDF already saved next to the DOCX during finalize.
        if (downloadSavedPdf(result)) {
            return;
        }

        if (!profileId) return;

        setIsGeneratingPdf(true);
        try {
            const response = await userAPI.generateResumePdf({
                resume_html: html,
                profile_id: parseInt(profileId),
                // Always send the resolved font from the last generate — never
                // re-roll "__random__" so PDF matches the preview/DOCX.
                font_family: result?.font_family || selectedFont,
                template_id: result?.template_id || assignedTemplate?.id,
                template_source: assignedTemplate?.kind || 'admin'
            });

            const blob = new Blob([response.data], { type: 'application/pdf' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            const baseName = (result?.resume_filename || 'resume')
                .replace(/\.docx$/i, '')
                .replace(/[^a-zA-Z0-9_\-]+/g, '_');
            a.href = url;
            a.download = `${baseName}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (err) {
            console.error('PDF generation failed:', err);
            let msg = err.message || 'Unknown error';
            if (err.response?.data instanceof ArrayBuffer) {
                try {
                    const text = new TextDecoder().decode(err.response.data);
                    const parsed = JSON.parse(text);
                    msg = parsed.error || msg;
                } catch (_) { /* keep default */ }
            } else if (err.response?.data?.error) {
                msg = err.response.data.error;
            }
            alert(`Failed to export PDF: ${msg}`);
        } finally {
            setIsGeneratingPdf(false);
        }
    };

    const [resumeCopied, setResumeCopied] = useState(false);
    const [linkedInCopied, setLinkedInCopied] = useState(false);
    const resumeCopyTimerRef = useRef(null);
    const linkedInCopyTimerRef = useRef(null);

    const htmlResumeToPlainText = (html, { linkedin = false } = {}) => {
        let text = html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<br\s*\/?>/gi, linkedin ? ' ' : '\n')
            .replace(/<\/p>/gi, linkedin ? ' ' : '\n\n')
            .replace(/<\/div>/gi, linkedin ? ' ' : '\n')
            .replace(/<\/li>/gi, linkedin ? ' ' : '\n')
            .replace(/<li[^>]*>/gi, linkedin ? '' : '• ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");

        if (linkedin) {
            text = text.replace(/\s+/g, ' ').trim();
        } else {
            text = text.replace(/\n{3,}/g, '\n\n').trim();
        }
        return text;
    };

    const copyResumeContent = async () => {
        const html = result?.resume_html || result?.resume_content;
        if (!html) return;
        try {
            const text = htmlResumeToPlainText(html);

            const blobHtml = new Blob([html], { type: 'text/html' });
            const blobText = new Blob([text], { type: 'text/plain' });
            if (navigator.clipboard && window.ClipboardItem) {
                await navigator.clipboard.write([
                    new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobText })
                ]);
            } else {
                await navigator.clipboard.writeText(text);
            }
            setResumeCopied(true);
            if (resumeCopyTimerRef.current) clearTimeout(resumeCopyTimerRef.current);
            resumeCopyTimerRef.current = setTimeout(() => setResumeCopied(false), 2000);
        } catch (err) {
            console.error('Copy failed:', err);
            // Fallback: use execCommand
            try {
                const ta = document.createElement('textarea');
                ta.value = result.resume_content || htmlResumeToPlainText(html);
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                setResumeCopied(true);
                if (resumeCopyTimerRef.current) clearTimeout(resumeCopyTimerRef.current);
                resumeCopyTimerRef.current = setTimeout(() => setResumeCopied(false), 2000);
            } catch (_) { /* swallow */ }
        }
    };

    const copyResumeForLinkedIn = async () => {
        const html = result?.resume_html || result?.resume_content;
        if (!html) return;
        try {
            const text = htmlResumeToPlainText(html, { linkedin: true });
            await navigator.clipboard.writeText(text);
            setLinkedInCopied(true);
            if (linkedInCopyTimerRef.current) clearTimeout(linkedInCopyTimerRef.current);
            linkedInCopyTimerRef.current = setTimeout(() => setLinkedInCopied(false), 2000);
        } catch (err) {
            console.error('LinkedIn copy failed:', err);
            alert('Failed to copy resume for LinkedIn');
        }
    };

    useEffect(() => { jobDescriptionRef.current = jobDescription; }, [jobDescription]);
    useEffect(() => { resultRef.current = result; }, [result]);
    useEffect(() => { profileIdRef.current = profileId; }, [profileId]);
    useEffect(() => { companyNameRef.current = companyName; }, [companyName]);
    useEffect(() => { jobRoleRef.current = jobRole; }, [jobRole]);
    useEffect(() => { formQuestionQueueRef.current = formQuestionQueue; }, [formQuestionQueue]);

    // Extension fill: profile already filled on apply tab; written Qs land here with Answer buttons.
    useEffect(() => {
        const onMsg = async (event) => {
            if (event.source !== window) return;
            if (event.data?.type !== 'JOB_APPLY_BIDDER_ANSWER_QUESTIONS') return;
            const payload = event.data.payload || {};
            const questions = Array.isArray(payload.questions) ? payload.questions : [];
            const requestId = payload.requestId || null;
            const mode = payload.mode || 'interactive';

            const reply = (body) => {
                window.postMessage({
                    type: 'JOB_APPLY_BIDDER_ANSWERS_READY',
                    requestId,
                    ...body
                }, '*');
            };

            if (!questions.length) {
                reply({ error: 'No questions to answer', payload: { answers: [], profile: {} } });
                return;
            }

            const pid = parseInt(payload.profile_id || profileIdRef.current, 10);
            if (!pid) {
                reply({ error: 'No profile on Generate page' });
                return;
            }

            const written = questions.filter(
                (q) => q.kind !== 'salary' && q.answer_type !== 'salary'
            );
            const salaryQs = questions.filter(
                (q) => q.kind === 'salary' || q.answer_type === 'salary'
            );
            if (!written.length && !salaryQs.length) {
                reply({ payload: { answers: [], skipped: [], profile: {} } });
                return;
            }

            formQuestionCtxRef.current = {
                requestId,
                reply,
                profile_id: pid,
                job_description: payload.job_description || jobDescriptionRef.current || '',
                resume_html: payload.resume_html
                    || resultRef.current?.resume_html
                    || resultRef.current?.resume_content
                    || '',
                company_name: payload.company_name || companyNameRef.current || '',
                job_role: payload.job_role || jobRoleRef.current || '',
                application_id: payload.application_id || resultRef.current?.application_id || null
            };

            answeringBidderRef.current = true;
            setAssistantFillHint(true);
            setChatOpen(true);
            setFormQuestionQueue(written.map((q) => ({
                id: String(q.id || q.label),
                label: q.label || q.id,
                type: q.type || 'text',
                kind: q.kind || 'question',
                answer: '',
                answering: false,
                error: ''
            })));

            setChatMessages((prev) => [
                ...prev,
                {
                    role: 'assistant',
                    content:
                        mode === 'auto'
                            ? `CV ready. Auto-drafting ${written.length || questions.length} answer(s) from JD + CV…`
                            : `Profile fields were autofilled on the apply tab.\n\n`
                              + `${written.length} written question(s) below — click Answer on each, edit if needed, then Fill on apply form.`
                }
            ]);

            // Auto mode (after CV finishes): draft all answers and send back without clicks.
            if (mode === 'auto') {
                const ctx = formQuestionCtxRef.current;
                setChatLoading(true);
                try {
                    const apiQuestions = [...written, ...salaryQs].map((q) => ({
                        id: String(q.id || q.label),
                        label: q.label || q.id,
                        type: q.type || 'text',
                        kind: q.kind || 'question',
                        answer_type: (q.kind === 'salary' || q.answer_type === 'salary') ? 'salary' : 'written'
                    }));
                    const res = await userAPI.generateAnswers({
                        profile_id: ctx.profile_id,
                        job_description: ctx.job_description,
                        resume_html: ctx.resume_html,
                        questions: apiQuestions.length ? apiQuestions : written.map((q) => ({
                            id: String(q.id || q.label),
                            label: q.label || q.id,
                            type: q.type || 'text',
                            kind: q.kind || 'question',
                            answer_type: 'written'
                        })),
                        company_name: ctx.company_name,
                        job_role: ctx.job_role,
                        application_id: ctx.application_id
                    });
                    const data = res?.data || {};
                    const answers = Array.isArray(data.answers) ? data.answers : [];
                    const skipped = Array.isArray(data.skipped) ? data.skipped : [];
                    setFormQuestionQueue(written.map((q) => {
                        const id = String(q.id || q.label);
                        const hit = answers.find((a) => String(a.id) === id);
                        return {
                            id,
                            label: q.label || q.id,
                            type: q.type || 'text',
                            kind: q.kind || 'question',
                            answer: hit?.answer || '',
                            answering: false,
                            error: hit?.answer ? '' : 'No answer returned'
                        };
                    }));
                    const filledN = answers.filter((a) => (a.answer || '').trim()).length;
                    const lines = answers
                        .filter((a) => (a.answer || '').trim())
                        .map((a) => `**${a.label || a.id}**\n${a.answer || ''}`)
                        .join('\n\n');
                    const skipNote = skipped.length
                        ? `\n\nSkipped ${skipped.length}: ${skipped.map((s) => s.label || s.id).join('; ')}`
                        : '';
                    setChatMessages((prev) => [
                        ...prev,
                        {
                            role: 'assistant',
                            content: filledN
                                ? `Auto-drafted ${filledN} answer(s) — filling apply form…\n\n${lines}${skipNote}`
                                : `Auto-drafted 0 answer(s). Provider: ${data.provider || 'unknown'} / ${data.model || '?'}.${skipNote}\n\nTry Answer again, or draft manually below.`
                        }
                    ]);
                    reply({
                        payload: {
                            answers,
                            skipped,
                            profile: data.profile || {},
                            provider: data.provider || null,
                            model: data.model || null,
                            written_filled: data.written_filled ?? filledN,
                            written_count: data.written_count ?? written.length
                        }
                    });
                    answeringBidderRef.current = false;
                    setAssistantFillHint(false);
                    formQuestionCtxRef.current = null;
                } catch (err) {
                    const message = err.response?.data?.error || err.message || 'Failed to draft answers';
                    setChatMessages((prev) => [
                        ...prev,
                        { role: 'assistant', content: `Auto-answer failed: ${message}` }
                    ]);
                    reply({ error: message, payload: { answers: [], profile: {} } });
                    answeringBidderRef.current = false;
                } finally {
                    setChatLoading(false);
                }
            }
        };

        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
    }, []);

    const answerOneFormQuestion = async (questionId) => {
        const ctx = formQuestionCtxRef.current;
        if (!ctx?.profile_id) return;
        const row = formQuestionQueueRef.current.find((q) => q.id === questionId);
        if (!row || row.answering) return;

        setFormQuestionQueue((prev) => prev.map((q) => (
            q.id === questionId ? { ...q, answering: true, error: '' } : q
        )));

        try {
            const res = await userAPI.generateAnswers({
                profile_id: ctx.profile_id,
                job_description: ctx.job_description,
                resume_html: ctx.resume_html,
                questions: [{
                    id: row.id,
                    label: row.label,
                    type: row.type,
                    kind: row.kind || 'question',
                    answer_type: 'written'
                }],
                company_name: ctx.company_name,
                job_role: ctx.job_role,
                application_id: ctx.application_id
            });
            const data = res?.data || {};
            const hit = (data.answers || []).find((a) => String(a.id) === String(row.id))
                || (data.answers || [])[0];
            const text = (hit?.answer || '').trim();
            if (!text) throw new Error('Empty answer from AI');

            setFormQuestionQueue((prev) => prev.map((q) => (
                q.id === questionId ? { ...q, answer: text, answering: false, error: '' } : q
            )));
            setChatMessages((prev) => [
                ...prev,
                { role: 'user', content: row.label },
                { role: 'assistant', content: text }
            ]);
        } catch (err) {
            const message = err.response?.data?.error || err.message || 'Failed to answer';
            setFormQuestionQueue((prev) => prev.map((q) => (
                q.id === questionId ? { ...q, answering: false, error: message } : q
            )));
        }
    };

    const sendFormAnswersToApply = () => {
        const ctx = formQuestionCtxRef.current;
        if (!ctx?.reply) return;
        const queue = formQuestionQueueRef.current;
        const answers = queue
            .filter((q) => (q.answer || '').trim())
            .map((q) => ({
                id: q.id,
                label: q.label,
                answer: q.answer.trim(),
                answer_type: 'written',
                source: 'api'
            }));
        if (!answers.length) {
            setChatMessages((prev) => [
                ...prev,
                { role: 'assistant', content: 'Answer at least one question before filling the form.' }
            ]);
            return;
        }
        ctx.reply({
            payload: {
                answers,
                skipped: queue
                    .filter((q) => !(q.answer || '').trim())
                    .map((q) => ({ id: q.id, label: q.label, reason: 'not_answered' })),
                profile: {},
                written_filled: answers.length,
                written_count: queue.length
            }
        });
        answeringBidderRef.current = false;
        setAssistantFillHint(false);
        setChatMessages((prev) => [
            ...prev,
            {
                role: 'assistant',
                content: `Sent ${answers.length} answer(s) to the apply tab — filling now.`
            }
        ]);
        formQuestionCtxRef.current = null;
        setFormQuestionQueue([]);
    };

    const cancelFormQuestionQueue = () => {
        const ctx = formQuestionCtxRef.current;
        if (ctx?.reply) {
            ctx.reply({ error: 'Cancelled on Generate page', payload: { answers: [], profile: {} } });
        }
        answeringBidderRef.current = false;
        setAssistantFillHint(false);
        formQuestionCtxRef.current = null;
        setFormQuestionQueue([]);
    };

    useEffect(() => () => {
        if (resumeCopyTimerRef.current) clearTimeout(resumeCopyTimerRef.current);
        if (linkedInCopyTimerRef.current) clearTimeout(linkedInCopyTimerRef.current);
    }, []);

    const handleSendMessage = async (e, presetQuestion) => {
        if (e?.preventDefault) e.preventDefault();
        const userMessage = (presetQuestion || chatInput).trim();
        if (!userMessage || chatLoading) return;

        if (!jobDescription.trim() && !(result?.resume_content || result?.resume_html)) {
            setChatMessages(prev => [...prev, {
                role: 'assistant',
                content: 'Paste a job description on the left first, then ask me about requirements, fit, salary, or interview prep.'
            }]);
            setChatOpen(true);
            return;
        }

        setChatInput('');
        setChatLoading(true);
        setChatOpen(true);
        setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);

        try {
            const resumeText = result?.resume_content
                || (result?.resume_html ? String(result.resume_html).replace(/<[^>]+>/g, ' ') : '');
            const response = await userAPI.chat(userMessage, jobDescription, resumeText, chatMessages);
            setChatMessages(prev => [...prev, { role: 'assistant', content: response.data.answer }]);
        } catch (error) {
            console.error('Chat error:', error);
            setChatMessages(prev => [...prev, {
                role: 'assistant',
                content: error.response?.data?.error || 'Sorry, I encountered an error. Please try again.'
            }]);
        } finally {
            setChatLoading(false);
        }
    };

    const CHAT_QUICK_PROMPTS = [
        'What are the must-have requirements for this job?',
        'Does my background fit this role? Where are the gaps?',
        'Suggest 5 interview questions they might ask.',
        'How should I answer “tell me about yourself” for this job?',
        'What salary range is reasonable for this role?'
    ];

    const copyToClipboard = (text, fieldName) => {
        if (!text || text === '-') return;
        navigator.clipboard.writeText(text).then(() => {
            setCopiedField(fieldName);
            setTimeout(() => setCopiedField(null), 2000);
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    };

    // Cover letter handlers
    const handleGenerateCoverLetter = async () => {
        console.log('Generating cover letter...', {
            hasResult: !!result,
            hasResumeHtml: !!result?.resume_html,
            jobDescLength: jobDescription?.length
        });

        if (!result?.resume_html) {
            setCoverLetterError('Please generate a resume first');
            return;
        }
        setCoverLetterError('');
        setCoverLetterGenerating(true);
        setCoverLetterResult(null);

        try {
            console.log('Calling API with profileId:', profileId);
            const response = await userAPI.generateCoverLetter(
                parseInt(profileId),
                jobDescription,
                result.resume_html,
                companyName  // user-supplied company name → baked into filename
            );
            console.log('API Response:', response.data);
            setCoverLetterResult(response.data);
        } catch (error) {
            console.error('Cover letter error:', error);
            setCoverLetterError(error.response?.data?.error || error.message || 'Failed to generate cover letter');
        } finally {
            setCoverLetterGenerating(false);
        }
    };

    const handleDetectCompany = async () => {
        if (!jobDescription?.trim()) {
            setCoverLetterError('Please enter a job description first');
            return;
        }
        setCoverLetterError('');
        setDetectingCompany(true);
        try {
            const response = await userAPI.extractCompany(jobDescription);
            setDetectedCompany(response.data.company_name);
        } catch (error) {
            console.error('Detect company error:', error);
            setCoverLetterError(error.response?.data?.error || error.message || 'Failed to detect company');
        } finally {
            setDetectingCompany(false);
        }
    };

    const closeCoverLetterModal = () => {
        setCoverLetterOpen(false);
        setDetectedCompany('');
        setCoverLetterError('');
    };

    const downloadCoverLetterDocx = (filename) => {
        window.open(`/resumes/${filename}`, '_blank');
    };

    const copyCoverLetter = () => {
        if (!coverLetterResult?.cover_letter_text) return;
        navigator.clipboard.writeText(coverLetterResult.cover_letter_text).then(() => {
            alert('Cover letter copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    };

    if (loading) {
        return <PageLoader message="Loading resume generator..." />;
    }

    // Show profile selector if no profile selected
    if (!profile && profiles.length > 0) {
        return (
            <AppPage
                icon={FileText}
                title="Generate Resume"
                description="Select a profile to generate resume"
            >
                <div className="card">
                    <div className="form-group">
                        <label className="form-label">Select Profile</label>
                        <select
                            className="form-select"
                            value={profileId || ''}
                            onChange={handleProfileSelect}
                        >
                            <option value="">-- Select a profile --</option>
                            {profiles.map(p => (
                                <option key={p.id} value={p.id}>
                                    {p.first_name} {p.last_name} ({p.email}){p.is_default ? ' — Default' : ''}
                                </option>
                            ))}
                        </select>
                    </div>

                    {profiles.length === 0 && (
                        <p className="text-muted">No profiles assigned to you yet.</p>
                    )}
                </div>
            </AppPage>
        );
    }

    // No profiles at all
    if (!profile && profiles.length === 0 && !profileId) {
        return (
            <AppPage
                icon={FileText}
                title="Generate Resume"
                description="Contact your administrator to get candidate profiles assigned to you."
            >
                <div className="card">
                    <div className="empty-state">
                        <div className="empty-state-icon">📝</div>
                        <h3>No profiles assigned</h3>
                        <p>Contact your administrator to get candidate profiles assigned to you.</p>
                    </div>
                </div>
            </AppPage>
        );
    }

    return (
        <AppPage
            icon={FileText}
            title="Generate Resume"
            description={`${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() || 'Tailor a CV to the job'}
            className="!max-w-none"
        >
            <div className="mb-4">
                <PageCommandBar
                    actions={
                        <>
                            <select
                                className="form-select h-10 min-w-[12rem] rounded-xl border border-white/10 bg-black/20 px-3 text-sm"
                                value={profileId || ''}
                                onChange={handleProfileSelect}
                                disabled={generating || regenerating || isGenerateRunning()}
                            >
                                <option value="">-- Switch Profile --</option>
                                {profiles.map(p => (
                                    <option key={p.id} value={p.id}>
                                        {p.first_name} {p.last_name}{p.is_default ? ' (Default)' : ''}
                                    </option>
                                ))}
                            </select>
                            <button
                                className="btn btn-secondary h-10"
                                onClick={() => setPersonalInfoOpen(true)}
                                title="Personal Info"
                            >
                                <UserIcon className="h-4 w-4" />
                            </button>
                            {result && (
                                <button
                                    className="btn btn-secondary h-10"
                                    onClick={() => setChatOpen(true)}
                                    title="Ask about the job, resume fit, or interview prep"
                                >
                                    <MessageCircle className="h-4 w-4" />
                                    <span className="hidden sm:inline">Ask AI</span>
                                </button>
                            )}
                        </>
                    }
                />
            </div>
            {assistantFillHint && (
                <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                    Profile was autofilled on the apply tab. Use <strong>Answer</strong> on each written question below, then <strong>Fill on apply form</strong>.
                </div>
            )}
            {formQuestionQueue.length > 0 && (
                <div className="mb-4 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-3 shadow-sm">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="font-medium text-sm">Apply-form questions</div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                onClick={cancelFormQuestionQueue}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                onClick={sendFormAnswersToApply}
                                disabled={!formQuestionQueue.some((q) => (q.answer || '').trim())}
                            >
                                Fill on apply form
                            </button>
                        </div>
                    </div>
                    <div className="space-y-3">
                        {formQuestionQueue.map((q) => (
                            <div key={q.id} className="rounded border border-border/80 bg-background p-3">
                                <div className="mb-2 text-sm font-medium">{q.label}</div>
                                <textarea
                                    className="input w-full text-sm"
                                    rows={q.type === 'textarea' ? 3 : 2}
                                    value={q.answer}
                                    placeholder="Click Answer to draft from JD + CV…"
                                    onChange={(e) => setFormQuestionQueue((prev) => prev.map((row) => (
                                        row.id === q.id ? { ...row, answer: e.target.value } : row
                                    )))}
                                />
                                {q.error && (
                                    <div className="mt-1 text-xs text-danger">{q.error}</div>
                                )}
                                <div className="mt-2 flex justify-end">
                                    <button
                                        type="button"
                                        className="btn btn-sm btn-primary"
                                        disabled={q.answering}
                                        onClick={() => answerOneFormQuestion(q.id)}
                                    >
                                        {q.answering ? 'Answering…' : (q.answer ? 'Re-answer' : 'Answer')}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {samePageFillHint && (
                <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                    Extension linked this generate to the job page. When the CV finishes, review the preview below, then press Alt+Shift+Q / F on the apply form (autofill no longer interrupts the generate course).
                </div>
            )}
            {result && (result.resume_html || result.resume_content || result.resume_filename) && !generating && (
                <div className="mb-4 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm flex flex-wrap items-center justify-between gap-2">
                    <span>
                        <strong>CV ready.</strong>
                        {result.company_name ? ` ${result.company_name}` : ''}
                        {result.application_id ? ` · App #${result.application_id}` : ''}
                        {' — preview is below.'}
                    </span>
                    <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => resumePreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    >
                        Jump to preview
                    </button>
                </div>
            )}
            {bgGenerateJob?.status === 'running' && String(bgGenerateJob.profileId) !== String(profileId) && (
                <div className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                    A CV is still generating for another profile.
                    {' '}
                    <Link className="font-semibold underline" to={`/user/generate/${bgGenerateJob.profileId}`}>
                        Open that generate page
                    </Link>
                    {' '}to watch it finish.
                </div>
            )}
            <div className="jobright-workspace">
                {/* LEFT — Job posting (JobRight main pane) */}
                <div className="jobright-main">
                    <div className="jobright-job-panel">
                        {(companyName || jobRole || jobUrl) && (
                            <div className="jobright-job-panel-head">
                                <div className="min-w-0">
                                    {jobRole && (
                                        <div className="jobright-job-panel-title">{jobRole}</div>
                                    )}
                                    {companyName && (
                                        <div className="jobright-job-panel-company">{companyName}</div>
                                    )}
                                    {jobUrl && (
                                        <a
                                            href={jobUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="mt-1 block truncate text-xs text-primary hover:underline"
                                        >
                                            {jobUrl}
                                        </a>
                                    )}
                                </div>
                                <div className="flex shrink-0 gap-2">
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={handleCopyJobDetails}
                                        title="Copy all job details"
                                    >
                                        <Copy className="h-3.5 w-3.5" />
                                        Copy
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={handlePasteJobDetails}
                                        title="Paste job details"
                                    >
                                        Paste
                                    </button>
                                </div>
                            </div>
                        )}

                        <div className="jobright-job-panel-body compact-form">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <h3 className="text-[13px] font-semibold tracking-tight text-foreground">Job details</h3>
                                <div className="flex gap-1.5">
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleCopyJobDetails}>
                                        <Copy className="h-3.5 w-3.5" /> Copy
                                    </button>
                                    <button type="button" className="btn btn-secondary btn-sm" onClick={handlePasteJobDetails}>
                                        Paste
                                    </button>
                                </div>
                            </div>

                            {clipboardStatus.message && (
                                <div className={clipboardStatus.type === 'error' ? 'alert alert-error' : 'alert alert-success'}>
                                    {clipboardStatus.message}
                                </div>
                            )}

                            {error && <div className="alert alert-error">{error}</div>}

                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="form-group mb-0">
                                    <label className="form-label">Company</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        value={companyName}
                                        onChange={(e) => setCompanyName(e.target.value)}
                                        placeholder="e.g. Acme Corp"
                                        disabled={generating}
                                    />
                                </div>
                                <div className="form-group mb-0">
                                    <label className="form-label">Role / Title</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        value={jobRole}
                                        onChange={(e) => setJobRole(e.target.value)}
                                        placeholder="e.g. Senior Software Engineer"
                                        disabled={generating}
                                    />
                                </div>
                            </div>

                            <div className="form-group mb-0">
                                <label className="form-label">Job URL</label>
                                <div className="flex items-stretch gap-2">
                                    <input
                                        type="url"
                                        className="form-input min-w-0 flex-1"
                                        value={jobUrl}
                                        onChange={(e) => {
                                            setJobUrl(e.target.value);
                                            if (lookupMatched.applicationId) {
                                                setLookupMatched({
                                                    applicationId: null,
                                                    status: '',
                                                    state: '',
                                                    rejectReason: '',
                                                    companyName: '',
                                                    applierId: null,
                                                    applierUsername: '',
                                                    ownedByCurrentUser: true,
                                                    assignedUsers: []
                                                });
                                                setLookupStatus({ type: '', message: '' });
                                            }
                                        }}
                                        placeholder="https://..."
                                        disabled={generating || lookupBusy}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !lookupBusy && !generating) {
                                                e.preventDefault();
                                                handleLookupByUrl();
                                            }
                                        }}
                                    />
                                    <button
                                        type="button"
                                        className="btn btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap"
                                        onClick={handleLookupByUrl}
                                        disabled={generating || lookupBusy || !jobUrl.trim()}
                                        title="Search job_applications for a matching job_url and fill the form from there"
                                    >
                                        {lookupBusy ? (
                                            <>
                                                <Loader size="sm" />
                                                <span>Searching…</span>
                                            </>
                                        ) : (
                                            <>
                                                <Search className="h-4 w-4" />
                                                <span>Lookup</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                                {lookupMatched.applicationId && (
                                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                        {(() => {
                                            const userRejected = lookupMatched.status === 'rejected';
                                            const adminClosed = !!lookupMatched.state && lookupMatched.state !== 'in_progress';
                                            const reason = (lookupMatched.rejectReason || '').trim();
                                            let label, tooltip, fg, bg, border;
                                            if (userRejected) {
                                                label = '✕ Rejected';
                                                tooltip = reason
                                                    ? `You rejected this application — ${reason}`
                                                    : 'You rejected this application.';
                                                fg = '#fecaca';
                                                bg = 'rgba(239, 68, 68, 0.22)';
                                                border = '1px solid rgba(239, 68, 68, 0.55)';
                                            } else if (adminClosed) {
                                                label = '🚫 Unavailable';
                                                tooltip = reason
                                                    ? `Unavailable — ${reason}`
                                                    : `Unavailable (state: ${lookupMatched.state})`;
                                                fg = '#fecaca';
                                                bg = 'rgba(239, 68, 68, 0.18)';
                                                border = '1px solid rgba(239, 68, 68, 0.45)';
                                            } else {
                                                label = '✅ Available';
                                                tooltip = 'Available — this job is still open to apply.';
                                                fg = '#bbf7d0';
                                                bg = 'rgba(16, 185, 129, 0.18)';
                                                border = '1px solid rgba(16, 185, 129, 0.45)';
                                            }
                                            return (
                                                <span
                                                    title={tooltip}
                                                    style={{
                                                        fontSize: '0.65rem',
                                                        padding: '0.15rem 0.5rem',
                                                        borderRadius: '9999px',
                                                        fontWeight: 600,
                                                        letterSpacing: '0.02em',
                                                        whiteSpace: 'nowrap',
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.25rem',
                                                        color: fg,
                                                        background: bg,
                                                        border
                                                    }}
                                                >
                                                    {label}
                                                </span>
                                            );
                                        })()}
                                        {(() => {
                                            const myId = authUser?.id ?? authUser?.userId ?? null;
                                            const appliedByMe = !!myId && Number(lookupMatched.applierId) === Number(myId);
                                            if (appliedByMe) {
                                                return (
                                                    <span
                                                        title={`You applied to this job (application #${lookupMatched.applicationId}).`}
                                                        style={{
                                                            fontSize: '0.65rem',
                                                            padding: '0.15rem 0.5rem',
                                                            borderRadius: '9999px',
                                                            fontWeight: 600,
                                                            letterSpacing: '0.02em',
                                                            whiteSpace: 'nowrap',
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            gap: '0.25rem',
                                                            color: '#bae6fd',
                                                            background: 'rgba(14, 165, 233, 0.18)',
                                                            border: '1px solid rgba(14, 165, 233, 0.45)'
                                                        }}
                                                    >
                                                        ✓ Applied
                                                    </span>
                                                );
                                            }
                                            return (
                                                <span
                                                    title="You have not applied to this job yet — generate + apply below."
                                                    style={{
                                                        fontSize: '0.65rem',
                                                        padding: '0.15rem 0.5rem',
                                                        borderRadius: '9999px',
                                                        fontWeight: 600,
                                                        letterSpacing: '0.02em',
                                                        whiteSpace: 'nowrap',
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.25rem',
                                                        color: '#cbd5e1',
                                                        background: 'rgba(148, 163, 184, 0.18)',
                                                        border: '1px solid rgba(148, 163, 184, 0.45)'
                                                    }}
                                                >
                                                    ◇ Not yet applied
                                                </span>
                                            );
                                        })()}
                                    </div>
                                )}
                                {lookupStatus.message && (
                                    <p
                                        role="status"
                                        aria-live="polite"
                                        className="mt-1 mb-0 text-xs"
                                        style={{
                                            color:
                                                lookupStatus.type === 'error'
                                                    ? 'var(--error, #ef4444)'
                                                    : 'var(--success, #10b981)'
                                        }}
                                    >
                                        {lookupStatus.message}
                                    </p>
                                )}
                            </div>

                    {/* Reject-reason panel — shown under the Job URL input
                        once the lookup has resolved an application whose
                        status the user previously marked as 'rejected'.
                        Displays the stored reason so the user can recall
                        why they dropped this job before regenerating /
                        re-applying. Renders nothing for non-rejected rows
                        so the form stays clean during a normal flow. */}
                    {lookupMatched.applicationId &&
                        lookupMatched.status === 'rejected' &&
                        (lookupMatched.rejectReason || '').trim() && (
                            <div
                                className="form-group"
                                style={{ marginTop: '0.5rem' }}
                            >
                                <div
                                    role="note"
                                    title="This application was previously marked as rejected."
                                    style={{
                                        display: 'flex',
                                        gap: '0.5rem',
                                        alignItems: 'flex-start',
                                        border: '1px solid rgba(239, 68, 68, 0.45)',
                                        background: 'rgba(239, 68, 68, 0.10)',
                                        color: '#fecaca',
                                        borderRadius: '0.4rem',
                                        padding: '0.6rem 0.75rem',
                                        fontSize: '0.8rem',
                                        lineHeight: 1.4
                                    }}
                                >
                                    <span aria-hidden="true" style={{ fontSize: '1rem', lineHeight: 1 }}>
                                        ✕
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div
                                            style={{
                                                fontWeight: 600,
                                                fontSize: '0.75rem',
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.02em',
                                                marginBottom: '0.2rem',
                                                color: '#fecaca'
                                            }}
                                        >
                                            Previously rejected
                                        </div>
                                        <div style={{ whiteSpace: 'pre-wrap' }}>
                                            {lookupMatched.rejectReason.trim()}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                            <div className="form-group mb-0">
                                <label className="form-label">Job description</label>
                                <textarea
                                    className="form-textarea jobright-jd-scroll"
                                    value={jobDescription}
                                    onChange={(e) => setJobDescription(e.target.value)}
                                    placeholder="Paste the full job description here…"
                                    rows={5}
                                    disabled={generating}
                                />
                            </div>

                            <div className="form-group mb-0">
                                <div className="mb-1 flex items-baseline justify-between gap-2">
                                    <label className="form-label mb-0">Tech stack</label>
                                    <span className="text-[10px] tabular-nums text-muted-foreground">
                                        {coreSkills.length} selected
                                    </span>
                                </div>
                                <div className="generate-skill-grid">
                                    {SKILL_OPTIONS.map((skill) => {
                                        const checked = coreSkills.includes(skill);
                                        return (
                                            <label
                                                key={skill}
                                                className={cn('generate-skill-item', checked && 'is-checked')}
                                                style={{
                                                    cursor: generating ? 'not-allowed' : 'pointer',
                                                    opacity: generating ? 0.6 : 1
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => setCoreSkills(prev => toggleSkill(prev, skill))}
                                                    disabled={generating}
                                                />
                                                <span>{skill}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>

                    {/* Template info banner. Template selection is NOT a
                        per-generation choice on this page — the admin
                        sets the candidate profile's preferred template
                        in the admin ProfileForm, and the resume
                        generator uses that template. This banner just
                        tells the user WHICH template will be used so
                        they're not in the dark. If the admin hasn't
                        set one, we show "System default" so the
                        generator still works. */}
                    <div
                        className="form-group"
                        style={{
                            padding: '0.6rem 0.75rem',
                            border: '1px solid var(--border, #e5e7eb)',
                            borderRadius: '6px',
                            background: 'var(--muted, #f9fafb)',
                            color: 'var(--text-muted, #6b7280)',
                            fontSize: '0.8125rem',
                            lineHeight: 1.45
                        }}
                    >
                        <div style={{ fontWeight: 600, color: 'var(--text, #111827)', marginBottom: '0.15rem' }}>
                            Template
                        </div>
                        {assignedTemplate ? (
                            <>
                                <span>
                                    Using <strong style={{ color: 'var(--text, #111827)' }}>{assignedTemplate.name}</strong>
                                    {assignedTemplate.is_default ? ' (default)' : ''}
                                    {assignedTemplate.kind === 'user' && assignedTemplate.owner ? (
                                        <span style={{ marginLeft: '0.4rem', color: 'var(--text-muted)' }}>
                                            · by {assignedTemplate.owner}
                                        </span>
                                    ) : null}
                                </span>
                                <div style={{ fontSize: '0.75rem', marginTop: '0.2rem', display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.75rem', alignItems: 'center' }}>
                                    <span>Set by admin in the candidate profile.</span>
                                    <Link
                                        to={assignedTemplate.kind === 'user'
                                            ? `/user/templates/${assignedTemplate.id}`
                                            : '/user/templates'}
                                        className="text-primary hover:underline"
                                        style={{ fontWeight: 600 }}
                                    >
                                        {assignedTemplate.kind === 'user' ? 'Edit this template' : 'Open Template Builder'}
                                    </Link>
                                </div>
                            </>
                        ) : (
                            <>
                                <span>
                                    Using <strong style={{ color: 'var(--text, #111827)' }}>System default</strong> template.
                                </span>
                                <div style={{ fontSize: '0.75rem', marginTop: '0.2rem', display: 'flex', flexWrap: 'wrap', gap: '0.35rem 0.75rem', alignItems: 'center' }}>
                                    <span>No template is set on this profile.</span>
                                    <Link to="/user/templates" className="text-primary hover:underline" style={{ fontWeight: 600 }}>
                                        Open Template Builder
                                    </Link>
                                </div>
                            </>
                        )}
                    </div>

                            <div className="form-group mb-0">
                                <label className="form-label">Font</label>
                                <select
                                    className="form-select"
                                    value={selectedFont}
                                    onChange={(e) => setSelectedFont(e.target.value)}
                                    disabled={generating}
                                >
                                    <option value="__random__">
                                        Random from template
                                        {templateFontPool.length > 1
                                            ? ` (${templateFontPool.length} fonts)`
                                            : ''}
                                    </option>
                                    {(templateFontPool.length
                                        ? templateFontPool
                                        : allowedFonts
                                    ).map((f) => (
                                        <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
                                    ))}
                                    {templateFontPool.length > 0 && allowedFonts
                                        .filter((f) => !templateFontPool.includes(f))
                                        .map((f) => (
                                            <option key={`all-${f}`} value={f} style={{ fontFamily: f }}>{f}</option>
                                        ))}
                                </select>
                                {templateFontPool.length > 1 && selectedFont === '__random__' && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Each generate picks one of: {templateFontPool.join(', ')}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* MIDDLE — CV preview */}
                <aside className="jobright-rail" ref={resumePreviewRef}>
                    <div className="jobright-rail-inner">
                        <div className="jobright-rail-header">
                            <div className="jobright-rail-header-icon">
                                <FileText className="h-4 w-4" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="jobright-rail-title">CV Preview</div>
                                <div className="jobright-rail-subtitle truncate">
                                    {profile?.first_name} {profile?.last_name}
                                    {result?.company_name ? ` · ${result.company_name}` : ''}
                                </div>
                            </div>
                        </div>

                        <button
                            className="btn btn-gradient w-full"
                            onClick={handleGenerate}
                            disabled={
                                generating
                                || regenerating
                                || loading
                                || !profile
                                || !jobDescription.trim()
                                || !(Array.isArray(coreSkills) ? coreSkills : []).length
                            }
                        >
                            {generating ? (
                                <>
                                    <Loader size="sm" />
                                    Generating… {formatDuration(genElapsedSec)}
                                </>
                            ) : (
                                <>
                                    <Sparkles className="h-4 w-4" />
                                    Customize Resume
                                </>
                            )}
                        </button>

                        {error && (
                            <div className="alert alert-error text-sm">{error}</div>
                        )}

                        {generating && (
                            <div className="jobright-generating">
                                <Loader size="xl" />
                                <p className="font-mono text-2xl tabular-nums">{formatDuration(genElapsedSec)}</p>
                                <p className="text-xs text-muted-foreground">
                                    Drafting CV… You can open other pages — this keeps running.
                                </p>
                            </div>
                        )}

                        {!result && !generating && (
                            <div className="jobright-empty">
                                <FileText className="h-8 w-8 opacity-40" />
                                <p>CV preview appears here after you customize.</p>
                            </div>
                        )}

                        {result && (result.resume_html || result.resume_content) && !generating && (
                            <>
                                <div className={cn(
                                    'jobright-status-pill',
                                    isResumeFinalized(result)
                                        ? 'border-success/40 bg-success/10 text-success'
                                        : 'border-warning/40 bg-warning/10'
                                )}>
                                    {isResumeFinalized(result) ? (
                                        <>
                                            <strong>CV ready</strong>
                                            {result.quality_report && (
                                                <span className="ml-1">
                                                    · {result.quality_report.grade} ({result.quality_report.score}%)
                                                </span>
                                            )}
                                            {markedGenerationTime(result) && (
                                                <span className="ml-1 opacity-80">· {markedGenerationTime(result)}</span>
                                            )}
                                        </>
                                    ) : (
                                        <strong>Review draft</strong>
                                    )}
                                </div>

                                <div className="jobright-preview-scroll">
                                    {result.preview_css ? (
                                        <style>
                                            {String(result.preview_css)
                                                .replace(/\bbody\s*\{/g, '.jobright-preview-scroll .resume-preview {')
                                                .replace(/(^|})\s*([^@{}][^{]*)\{/g, (full, brace, sel) => {
                                                    const scoped = String(sel)
                                                        .split(',')
                                                        .map((s) => {
                                                            const t = s.trim();
                                                            if (!t) return t;
                                                            if (t.includes('.resume-preview')) return t;
                                                            return `.jobright-preview-scroll .resume-preview ${t}`;
                                                        })
                                                        .join(', ');
                                                    return `${brace}\n${scoped} {`;
                                                })}
                                        </style>
                                    ) : null}
                                    <div
                                        className="resume-preview"
                                        style={{
                                            fontFamily: result.font_family
                                                ? `"${result.font_family}", Arial, sans-serif`
                                                : undefined,
                                            fontSize: '11px',
                                            lineHeight: 1.35,
                                            background: '#fff',
                                            color: '#111',
                                            padding: '0.75rem',
                                            borderRadius: '0.35rem'
                                        }}
                                        dangerouslySetInnerHTML={{ __html: result.resume_html || result.resume_content }}
                                    />
                                </div>

                                <div className="flex flex-wrap gap-1.5">
                                    <button
                                        className="btn btn-primary btn-sm"
                                        onClick={() => downloadResume(result.resume_filename)}
                                        disabled={!isResumeFinalized(result)}
                                    >
                                        <Download className="h-3.5 w-3.5" />
                                        DOCX
                                    </button>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={downloadResumeAsPdf}
                                        disabled={isGeneratingPdf || !(result?.resume_html || result?.resume_content)}
                                    >
                                        {isGeneratingPdf ? <Loader size="sm" /> : <FileText className="h-3.5 w-3.5" />}
                                        PDF
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={handleRegenerate}
                                        disabled={regenerating}
                                    >
                                        {regenerating ? <Loader size="sm" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                        Regen
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => setCoverLetterOpen(true)}
                                    >
                                        <Mail className="h-3.5 w-3.5" />
                                        Cover
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-success btn-sm"
                                        onClick={handleApplied}
                                        disabled={applying || regenerating || !isResumeFinalized(result)}
                                    >
                                        {applying ? <Loader size="sm" /> : <Send className="h-3.5 w-3.5" />}
                                        Applied
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-danger btn-sm"
                                        onClick={openRejectModal}
                                        disabled={applying || regenerating}
                                    >
                                        <XCircle className="h-3.5 w-3.5" />
                                        Reject
                                    </button>
                                </div>
                            </>
                        )}

                        {result && !(result.resume_html || result.resume_content) && !generating && (
                            <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs">
                                Generate finished but CV HTML is empty.
                                {result.resume_filename ? (
                                    <button type="button" className="ml-1 underline" onClick={() => downloadResume(result.resume_filename)}>
                                        Download DOCX
                                    </button>
                                ) : null}
                            </div>
                        )}
                    </div>
                </aside>

                {/* THIRD — always-on Assistant (Ask AI) */}
                <aside className="jobright-assistant">
                    <div className="jobright-assistant-inner">
                        <div className="jobright-rail-header">
                            <div className="jobright-rail-header-icon">
                                <MessageCircle className="h-4 w-4" />
                            </div>
                            <div>
                                <div className="jobright-rail-title">Assistant</div>
                                <div className="jobright-rail-subtitle">
                                    Job fit, interview prep, salary
                                </div>
                            </div>
                        </div>

                        {!jobDescription.trim() && (
                            <p className="text-[11px] text-amber-200/80">
                                Paste a job description first for better answers.
                            </p>
                        )}

                        {chatMessages.length === 0 && (
                            <div className="flex flex-wrap gap-1.5">
                                {CHAT_QUICK_PROMPTS.slice(0, 4).map((q) => (
                                    <button
                                        key={q}
                                        type="button"
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 text-left text-[10px] leading-snug text-white/55 hover:border-primary/40 hover:bg-primary/10 hover:text-white"
                                        onClick={() => handleSendMessage(null, q)}
                                        disabled={chatLoading}
                                    >
                                        {q.length > 48 ? `${q.slice(0, 48)}…` : q}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div className="jobright-assistant-messages">
                            {chatMessages.length === 0 && (
                                <div className="flex h-full min-h-[10rem] flex-col items-center justify-center px-3 text-center text-[11px] text-white/35">
                                    <MessageCircle className="mb-2 h-7 w-7 opacity-40" />
                                    <p className="font-medium text-white/50">Ask about this job</p>
                                    <p className="mt-1">Requirements, fit gaps, interview questions…</p>
                                </div>
                            )}
                            {chatMessages.map((msg, index) => (
                                <div
                                    key={index}
                                    className={cn(
                                        'jobright-assistant-bubble',
                                        msg.role === 'user' ? 'user' : 'assistant'
                                    )}
                                >
                                    <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide opacity-60">
                                        {msg.role === 'user' ? 'You' : 'Assistant'}
                                    </div>
                                    {msg.content}
                                </div>
                            ))}
                            {chatLoading && (
                                <div className="jobright-assistant-bubble assistant">
                                    <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide opacity-60">
                                        Assistant
                                    </div>
                                    <Loader size="sm" />
                                </div>
                            )}
                            <div ref={chatMessagesEndRef} />
                        </div>

                        <form
                            onSubmit={handleSendMessage}
                            className="flex items-end gap-1.5"
                        >
                            <textarea
                                className="form-input min-h-[3.25rem] flex-1 resize-none text-xs"
                                placeholder="Ask about the JD or your CV…"
                                value={chatInput}
                                onChange={(e) => setChatInput(e.target.value)}
                                disabled={chatLoading}
                                rows={2}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSendMessage(e);
                                    }
                                }}
                            />
                            <button
                                type="submit"
                                className="btn btn-primary h-[3.25rem] min-w-[3.5rem] px-3"
                                disabled={chatLoading || !chatInput.trim()}
                            >
                                {chatLoading ? <Loader size="sm" /> : 'Ask'}
                            </button>
                        </form>
                    </div>
                </aside>
            </div>

            {/* Chat Modal — Job Apply Assistant */}
            {chatOpen && (
                <div className="modal-overlay" onClick={() => setChatOpen(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '640px', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
                        <div className="modal-header">
                            <h2 className="modal-title flex items-center gap-2">
                                <MessageCircle className="h-5 w-5 text-primary" />
                                Lumi Assistant
                            </h2>
                            <button className="modal-close" onClick={() => setChatOpen(false)}>✕</button>
                        </div>
                        <div className="modal-body" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '1rem', overflow: 'hidden' }}>
                            <p className="text-muted mb-md" style={{ fontSize: '0.75rem' }}>
                                Ask about the job description, resume fit, salary, or interview prep.
                                {!jobDescription.trim() && (
                                    <span className="ml-1 text-warning">Paste a job description first for best answers.</span>
                                )}
                            </p>

                            {chatMessages.length === 0 && (
                                <div className="mb-3 flex flex-wrap gap-1.5">
                                    {CHAT_QUICK_PROMPTS.map((q) => (
                                        <button
                                            key={q}
                                            type="button"
                                            className="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-left text-xs hover:border-primary/50 hover:bg-primary/5"
                                            onClick={() => handleSendMessage(null, q)}
                                            disabled={chatLoading}
                                        >
                                            {q}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {/* Chat Messages */}
                            <div style={{
                                flex: 1,
                                overflowY: 'auto',
                                marginBottom: '1rem',
                                padding: '0.5rem',
                                backgroundColor: 'var(--bg-secondary)',
                                borderRadius: '8px',
                                minHeight: '280px'
                            }}>
                                {chatMessages.length === 0 && (
                                    <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem 1rem', fontSize: '0.875rem' }}>
                                        <MessageCircle className="mx-auto mb-2 h-8 w-8 opacity-40" />
                                        <p className="font-medium">Job application assistant</p>
                                        <p style={{ fontSize: '0.75rem', marginTop: '0.35rem' }}>
                                            Pick a suggested question above or type your own.
                                        </p>
                                    </div>
                                )}
                                {chatMessages.map((msg, index) => (
                                    <div key={index} style={{
                                        marginBottom: '0.75rem',
                                        padding: '0.75rem',
                                        borderRadius: '8px',
                                        backgroundColor: msg.role === 'user' ? 'var(--primary)' : 'var(--bg-primary)',
                                        color: msg.role === 'user' ? 'white' : 'var(--text-primary)',
                                        marginLeft: msg.role === 'user' ? '2rem' : '0',
                                        marginRight: msg.role === 'assistant' ? '2rem' : '0'
                                    }}>
                                        <div style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '0.25rem' }}>
                                            {msg.role === 'user' ? 'You' : 'Assistant'}
                                        </div>
                                        <div style={{ fontSize: '0.875rem', whiteSpace: 'pre-wrap' }}>
                                            {msg.content}
                                        </div>
                                    </div>
                                ))}
                                {chatLoading && (
                                    <div style={{
                                        padding: '0.75rem',
                                        borderRadius: '8px',
                                        backgroundColor: 'var(--bg-primary)',
                                        marginRight: '2rem'
                                    }}>
                                        <div style={{ fontSize: '0.7rem', opacity: 0.7, marginBottom: '0.25rem' }}>Assistant</div>
                                        <Loader size="sm" />
                                    </div>
                                )}
                                <div ref={chatMessagesEndRef} />
                            </div>

                            <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                                <textarea
                                    className="form-input"
                                    placeholder="e.g. What are the must-have skills? How should I prep for the interview?"
                                    value={chatInput}
                                    onChange={(e) => setChatInput(e.target.value)}
                                    disabled={chatLoading}
                                    style={{ flex: 1, resize: 'none', minHeight: '60px' }}
                                    autoFocus
                                    rows={2}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleSendMessage(e);
                                        }
                                    }}
                                />
                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                    disabled={chatLoading || !chatInput.trim()}
                                    style={{ height: '60px', minWidth: '4.5rem' }}
                                >
                                    {chatLoading ? <Loader size="sm" /> : 'Ask'}
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            )}

            {/* Personal Info Modal */}
            {personalInfoOpen && (
                <div className="modal-overlay" onClick={() => setPersonalInfoOpen(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">👤 Personal Information</h2>
                            <button className="modal-close" onClick={() => setPersonalInfoOpen(false)}>✕</button>
                        </div>
                        <div className="modal-body">
                            <div style={{ display: 'grid', gap: '1rem' }}>
                                {/* Name */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Name</div>
                                        <div style={{ fontWeight: '500' }}>{profile?.first_name} {profile?.middle_name} {profile?.last_name}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(`${profile?.first_name} ${profile?.middle_name} ${profile?.last_name}`, 'name')}
                                    >
                                        {copiedField === 'name' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* Email */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Email</div>
                                        <div>{profile?.email || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile?.email, 'email')}
                                        disabled={!profile?.email}
                                    >
                                        {copiedField === 'email' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* Phone */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Phone</div>
                                        <div>{profile?.phone || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile?.phone, 'phone')}
                                        disabled={!profile?.phone}
                                    >
                                        {copiedField === 'phone' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* Location */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Location</div>
                                        <div>{[profile?.address, profile?.city, profile?.state, profile?.country, profile?.postal_code].filter(Boolean).join(', ') || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard([profile?.address, profile?.city, profile?.state, profile?.country, profile?.postal_code].filter(Boolean).join(', '), 'location')}
                                        disabled={![profile?.address, profile?.city, profile?.state, profile?.country, profile?.postal_code].filter(Boolean).length}
                                    >
                                        {copiedField === 'location' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* LinkedIn */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>LinkedIn</div>
                                        <div style={{ wordBreak: 'break-all' }}>{profile?.linkedin_url || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile?.linkedin_url, 'linkedin')}
                                        disabled={!profile?.linkedin_url}
                                    >
                                        {copiedField === 'linkedin' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* GitHub */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>GitHub</div>
                                        <div style={{ wordBreak: 'break-all' }}>{profile?.github_url || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile?.github_url, 'github')}
                                        disabled={!profile?.github_url}
                                    >
                                        {copiedField === 'github' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* Birthdate */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Birthdate</div>
                                        <div>{profile?.birthdate || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile?.birthdate, 'birthdate')}
                                        disabled={!profile?.birthdate}
                                    >
                                        {copiedField === 'birthdate' ? '✓' : '📋'}
                                    </button>
                                </div>

                                {/* Salary Range */}
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', backgroundColor: 'var(--bg-secondary)', borderRadius: '4px' }}>
                                    <div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Salary Range</div>
                                        <div>{profile?.salary_range || '-'}</div>
                                    </div>
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile?.salary_range, 'salary_range')}
                                        disabled={!profile?.salary_range}
                                    >
                                        {copiedField === 'salary_range' ? '✓' : '📋'}
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-primary" onClick={() => setPersonalInfoOpen(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Reject Modal */}
            {rejectModalOpen && (
                <div className="modal-overlay" onClick={closeRejectModal}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">❌ Reject Application</h2>
                            <button className="modal-close" onClick={closeRejectModal} disabled={rejectSubmitting}>✕</button>
                        </div>
                        <div className="modal-body">
                            <p className="text-muted mb-md" style={{ fontSize: '0.875rem' }}>
                                Please provide a reason for rejecting this application for
                                <strong> {result?.company_name || 'this job'}</strong>.
                            </p>
                            {rejectError && <div className="alert alert-error mb-md">{rejectError}</div>}
                            <div className="form-group">
                                <label className="form-label">Reject Reason</label>
                                <textarea
                                    className="form-textarea"
                                    value={rejectReason}
                                    onChange={(e) => setRejectReason(e.target.value)}
                                    placeholder="e.g. Candidate lacks required experience with the core tech stack, profile not aligned with role..."
                                    rows={5}
                                    disabled={rejectSubmitting}
                                    autoFocus
                                />
                            </div>
                        </div>
                        <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                            <button
                                className="btn btn-secondary"
                                onClick={closeRejectModal}
                                disabled={rejectSubmitting}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={submitReject}
                                disabled={rejectSubmitting || !rejectReason.trim()}
                                style={{ backgroundColor: '#dc2626', borderColor: '#dc2626' }}
                            >
                                {rejectSubmitting ? (
                                    <>
                                        <Loader size="sm" />
                                        Confirming...
                                    </>
                                ) : (
                                    'Confirm Reject'
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Cover Letter Modal */}
            {coverLetterOpen && (
                <div className="modal-overlay" onClick={closeCoverLetterModal}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '800px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">✉️ Cover Letter</h2>
                            <button className="modal-close" onClick={closeCoverLetterModal}>✕</button>
                        </div>
                        <div className="modal-body" style={{ flex: 1, overflow: 'auto', padding: '1rem' }}>
                            {coverLetterError && <div className="alert alert-error mb-md">{coverLetterError}</div>}

                            {!coverLetterResult && !coverLetterGenerating && (
                                <div style={{ textAlign: 'center', padding: '2rem' }}>
                                    <p className="mb-lg">Generate a personalized cover letter based on the job description and your resume.</p>

                                    {detectedCompany && (
                                        <div className="alert alert-info mb-md" style={{ display: 'inline-block', padding: '0.5rem 1rem' }}>
                                            🪄 Detected company: <strong>{detectedCompany}</strong>
                                        </div>
                                    )}

                                    <div className="flex gap-md" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                                        <button
                                            className="btn btn-primary btn-lg"
                                            onClick={handleGenerateCoverLetter}
                                            disabled={!result?.resume_html}
                                        >
                                            ✨ Generate Cover Letter
                                        </button>
                                        <button
                                            className="btn btn-secondary btn-lg"
                                            onClick={handleDetectCompany}
                                            disabled={detectingCompany || !jobDescription?.trim()}
                                            title="Use AI to extract the company name from the job description"
                                        >
                                            {detectingCompany ? '⏳ Detecting…' : '🪄 Detect Company'}
                                        </button>
                                    </div>
                                    {!result?.resume_html && (
                                        <p className="text-muted mt-md" style={{ fontSize: '0.875rem' }}>
                                            Please generate a resume first
                                        </p>
                                    )}
                                </div>
                            )}

                            {coverLetterGenerating && (
                                <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
                                    <Loader size="xl" />
                                    <p className="font-medium">Generating cover letter...</p>
                                    <p className="text-sm text-muted-foreground">
                                        This may take a moment
                                    </p>
                                </div>
                            )}

                            {coverLetterResult && !coverLetterGenerating && (
                                <>
                                    <div className="alert alert-success mb-md">
                                        ✅ Cover letter generated for <strong>{coverLetterResult.company_name}</strong>!
                                    </div>

                                    <div style={{
                                        backgroundColor: 'var(--bg-secondary)',
                                        padding: '1rem',
                                        borderRadius: '8px',
                                        maxHeight: '400px',
                                        overflow: 'auto',
                                        whiteSpace: 'pre-wrap',
                                        fontSize: '0.875rem',
                                        lineHeight: '1.6',
                                        marginBottom: '1rem'
                                    }}>
                                        {coverLetterResult.cover_letter_text}
                                    </div>

                                    <div className="flex gap-md" style={{ flexWrap: 'wrap' }}>
                                        <button
                                            className="btn btn-primary"
                                            onClick={handleGenerateCoverLetter}
                                            title="Re-run the AI to generate a new cover letter"
                                        >
                                            🔄 Generate Cover Letter
                                        </button>
                                        <button
                                            className="btn btn-primary"
                                            onClick={() => downloadCoverLetterDocx(coverLetterResult.cover_letter_filename)}
                                        >
                                            📥 Download DOCX
                                        </button>
                                        <button
                                            className="btn btn-secondary"
                                            onClick={copyCoverLetter}
                                        >
                                            📋 Copy to Clipboard
                                        </button>
                                        <button
                                            className="btn btn-secondary"
                                            onClick={() => {
                                                // Download as TXT
                                                const blob = new Blob([coverLetterResult.cover_letter_text], { type: 'text/plain' });
                                                const url = URL.createObjectURL(blob);
                                                const a = document.createElement('a');
                                                a.href = url;
                                                a.download = coverLetterResult.cover_letter_filename.replace('.docx', '.txt');
                                                a.click();
                                                URL.revokeObjectURL(url);
                                            }}
                                        >
                                            📄 Download TXT
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-primary" onClick={closeCoverLetterModal}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </AppPage>
    );
}

export default ResumeGenerator;
