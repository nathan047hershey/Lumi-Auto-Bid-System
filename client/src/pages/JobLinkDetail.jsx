// =============================================================================
// pages/JobLinkDetail.jsx
// =============================================================================
//
// The new "Job Link detail" page that the cron-driven auto-apply
// feature needs. Clicking a row in the JobLinks directory (from
// either the admin or user section) opens this page.
//
// Layout:
//
//   ┌─────────────────────────────┬─────────────────────────────┐
//   │ LEFT  · Job description     │ RIGHT · Candidate cards    │
//   │       · Company / role /    │        · One card per      │
//   │         region / source     │          application tied  │
//   │         URL + apply URL     │          to this job_link  │
//   │       · Tech stack + cron   │        · Status badge:     │
//   │         status indicator    │          pending / ready /  │
//   │       · "Auto-apply cron"   │          failed / applied   │
//   │         toggle / last run   │        · Match score chip  │
//   │                             │        · Buttons:           │
//   │                             │          - Profile info     │
//   │                             │          - Download resume  │
//   │                             │          - Regenerate       │
//   │                             │          - Mark applied     │
//   └─────────────────────────────┴─────────────────────────────┘
//
// The page is reachable from /admin/job-links/:id AND
// /user/job-links/:id so both admins and regular team members can
// see what the cron generated for a given job and pull the
// resume off disk.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link, useSearchParams } from 'react-router-dom';
import {
    ArrowLeft,
    Briefcase,
    Building2,
    ChevronLeft,
    ChevronRight,
    Copy,
    Check,
    Download,
    ExternalLink,
    FileText,
    Loader2,
    MapPin,
    MessageSquare,
    Pencil,
    RefreshCw,
    User as UserIcon,
    CheckCircle2,
    XCircle,
    Clock,
    Play
} from 'lucide-react';
import { adminAPI } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { cvGenerationTimeLabel } from '@/lib/cvGenerationTime';
import AppPage from '@/components/AppPage';
import { PageLoader, Loader } from '@/components/Loader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogBody
} from '@/components/ui/dialog';

// Techstack → human label. Mirrors the rest of the app so a card
// chip on the detail page matches the dropdown on the add/edit
// form.
const TECHSTACK_LABEL = {
    python:   'Python',
    java:     'Java',
    dotnet:   'C# / .NET',
    golang:   'Golang',
    nodejs:   'Node.js',
    frontend: 'Frontend'
};

function formatJobLinkTimestamp(value) {
    if (!value) return '—';
    const raw = String(value).trim();
    const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleString();
}

// Visual treatment per generation_status. Used by both the card
// header badge and the cron-status indicator.
const STATUS_META = {
    pending: {
        label: 'Pending',
        className: 'bg-muted text-muted-foreground',
        icon: Clock
    },
    generating: {
        label: 'Generating…',
        className: 'bg-blue-100 text-blue-700 border-blue-200',
        icon: Loader2
    },
    ready: {
        label: 'Ready',
        className: 'bg-green-100 text-green-700 border-green-200',
        icon: CheckCircle2
    },
    failed: {
        label: 'Failed',
        className: 'bg-red-100 text-red-700 border-red-200',
        icon: XCircle
    }
};

// ---------------------------------------------------------------------
// Profile info modal — opens when an admin / user clicks the
// "Profile info" button on a card. Renders the candidate's
// personal details, tech stacks, and a short summary so the
// caller can decide whether to regenerate / download / apply
// without leaving the detail page.
// ---------------------------------------------------------------------
function ProfileInfoModal({ profile, open, onOpenChange }) {
    if (!profile) return null;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {profile.first_name} {profile.last_name}
                    </DialogTitle>
                    <DialogDescription>
                        Candidate profile (admin-side). Read-only here —
                        edit on the profile form.
                    </DialogDescription>
                </DialogHeader>
                <DialogBody>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Field label="Email" value={profile.email} />
                        <Field label="Phone" value={profile.phone} />
                        <Field label="Location" value={
                            [profile.city, profile.state, profile.country].filter(Boolean).join(', ')
                        } />
                        <Field label="Region flag" value={profile.location_flag || 'US'} />
                        <Field label="Salary range" value={profile.salary_range} />
                        <Field label="Tech stacks" value={
                            Array.isArray(profile.techstacks) && profile.techstacks.length
                                ? profile.techstacks.map((s) => TECHSTACK_LABEL[s] || s).join(', ')
                                : '—'
                        } />
                    </div>
                    <div className="mt-4">
                        <Field label="Work experience" value={profile.work_experience} multiline />
                        <Field label="Education" value={profile.education} multiline />
                    </div>
                </DialogBody>
            </DialogContent>
        </Dialog>
    );
}

function Field({ label, value, multiline = false }) {
    return (
        <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
            </div>
            <div className={`text-sm ${multiline ? 'whitespace-pre-wrap' : ''}`}>
                {value || <span className="text-muted-foreground">—</span>}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------
// One card per application. The card carries the candidate's
// identifying info (avatar initials, name, role summary) plus
// the four actions the user spec calls for: info modal, download
// resume, regenerate, mark applied.
// ---------------------------------------------------------------------
function ApplicationCard({ application, onChanged }) {
    const [profileOpen, setProfileOpen] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const [markingApplied, setMarkingApplied] = useState(false);
    const [localError, setLocalError] = useState(null);
    const isApplied = application.status === 'applied';

    const profile = application.profile || null;
    const status = STATUS_META[application.generation_status] || STATUS_META.pending;
    const StatusIcon = status.icon;
    const initials = profile
        ? ((profile.first_name?.[0] || '') + (profile.last_name?.[0] || '')).toUpperCase()
        : '?';
    const techstacks = Array.isArray(profile?.techstacks) ? profile.techstacks : [];

    const handleRegenerate = async () => {
        setRegenerating(true);
        setLocalError(null);
        try {
            await adminAPI.regenerateApplication(application.job_link_id, application.id);
            onChanged?.();
        } catch (err) {
            setLocalError(err.response?.data?.error || 'Regenerate failed');
        } finally {
            setRegenerating(false);
        }
    };

    const handleDownload = () => {
        if (!application.resume_filename) return;
        window.open(`/resumes/${application.resume_filename}`, '_blank', 'noopener');
    };

    const handleDownloadPdf = () => {
        if (!application.resume_filename) return;
        const pdfName = application.resume_filename.replace(/\.docx$/i, '.pdf');
        window.open(`/resumes/${encodeURIComponent(pdfName)}`, '_blank', 'noopener');
    };

    // Mark this application as applied — flips job_applications.status
    // from 'pending' to 'applied'. Pure metadata; no third-party
    // submission happens here. The caller / manager / admin can
    // track that they actually submitted it. The button is
    // disabled once the row is already marked so the action is
    // idempotent.
    const handleMarkApplied = async () => {
        if (isApplied) return;
        setMarkingApplied(true);
        setLocalError(null);
        try {
            await adminAPI.markApplicationApplied(application.job_link_id, application.id);
            onChanged?.();
        } catch (err) {
            setLocalError(err.response?.data?.error || 'Mark applied failed');
        } finally {
            setMarkingApplied(false);
        }
    };

    return (
        <Card className="overflow-hidden">
            <CardContent className="p-4">
                <div className="flex items-start gap-3">
                    {/* Avatar / initials */}
                    <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold"
                        title={profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown profile'}
                    >
                        {initials}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                                <div className="truncate font-medium">
                                    {profile ? `${profile.first_name} ${profile.last_name}` : 'Unknown profile'}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                    {techstacks.length
                                        ? techstacks.map((s) => TECHSTACK_LABEL[s] || s).join(' · ')
                                        : 'No techstack tags'}
                                    {profile?.location_flag ? ` · ${profile.location_flag}` : ''}
                                </div>
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                                <span
                                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}
                                    title={`generation_status: ${application.generation_status}`}
                                >
                                    <StatusIcon className={`h-3 w-3 ${application.generation_status === 'generating' ? 'animate-spin' : ''}`} />
                                    {status.label}
                                </span>
                                {(() => {
                                    const gen = cvGenerationTimeLabel(application);
                                    if (!gen) return null;
                                    return (
                                        <span
                                            className="font-mono text-[10px] tabular-nums text-muted-foreground"
                                            title={
                                                application.generation_status === 'ready'
                                                    ? `CV generated in ${gen}`
                                                    : `Generating for ${gen}`
                                            }
                                        >
                                            {application.generation_status === 'ready' ? `${gen}` : `${gen}…`}
                                        </span>
                                    );
                                })()}
                                {typeof application.match_score === 'number' && (
                                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-secondary-foreground">
                                        match {application.match_score.toFixed(2)}
                                    </span>
                                )}
                            </div>
                        </div>

                        {/* Status badges row */}
                        <div className="mt-2 flex flex-wrap gap-1">
                            {application.source === 'auto' && (
                                <Badge variant="outline" className="text-[10px] uppercase">
                                    auto
                                </Badge>
                            )}
                            {application.status === 'applied' && (
                                <Badge className="bg-green-600 text-white text-[10px]">
                                    applied
                                </Badge>
                            )}
                            {application.template_id && (
                                <Badge variant="outline" className="text-[10px]">
                                    template #{application.template_id}
                                </Badge>
                            )}
                            {application.font_family && (
                                <Badge variant="outline" className="text-[10px]">
                                    {application.font_family}
                                </Badge>
                            )}
                        </div>

                        {application.generation_error && application.generation_status === 'failed' && (
                            <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                                {application.generation_error}
                            </div>
                        )}

                        {localError && (
                            <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                                {localError}
                            </div>
                        )}

                        {/* Action buttons — exactly the four the user
                            spec asked for: profile info modal, download
                            resume, regenerate, mark applied. */}
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setProfileOpen(true)}
                                disabled={!profile}
                            >
                                <UserIcon className="mr-1 h-3.5 w-3.5" /> Profile info
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleDownload}
                                disabled={!application.resume_filename}
                                title={application.resume_filename || 'No resume yet'}
                            >
                                <Download className="mr-1 h-3.5 w-3.5" /> DOCX
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleDownloadPdf}
                                disabled={!application.resume_filename}
                                title="Download PDF export"
                            >
                                <FileText className="mr-1 h-3.5 w-3.5" /> PDF
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleRegenerate}
                                disabled={regenerating || application.generation_status === 'generating'}
                            >
                                {regenerating ? (
                                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                                )}
                                Regenerate
                            </Button>
                            <Button
                                size="sm"
                                variant={isApplied ? 'outline' : 'default'}
                                onClick={handleMarkApplied}
                                disabled={markingApplied || isApplied}
                                title={
                                    isApplied
                                        ? 'Already marked as applied'
                                        : 'Mark this application as applied (metadata only)'
                                }
                                className={isApplied ? 'text-green-700' : ''}
                            >
                                {markingApplied ? (
                                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                                )}
                                {isApplied ? 'Applied' : 'Mark applied'}
                            </Button>
                            </div>
                    </div>
                </div>
            </CardContent>
            <ProfileInfoModal
                profile={profile}
                open={profileOpen}
                onOpenChange={setProfileOpen}
            />
        </Card>
    );
}

// ---------------------------------------------------------------------
// Matched profile row — shown when a profile fits this job but no
// application CV has been generated yet (or while waiting on cron).
// ---------------------------------------------------------------------
function MatchedProfileRow({ jobLinkId, match, onChanged, canGenerate = true }) {
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const profile = match.profile || {};
    const initials = ((profile.first_name?.[0] || '') + (profile.last_name?.[0] || '')).toUpperCase() || '?';

    const handleGenerate = async () => {
        if (!canGenerate) {
            setErr('Need a job description first (fix Source URL / paste JD / Refetch).');
            return;
        }
        setBusy(true);
        setErr(null);
        try {
            await adminAPI.generateForProfile(jobLinkId, profile.id);
            onChanged?.();
        } catch (e) {
            setErr(e.response?.data?.error || e.message || 'Generate failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-md border border-border/70 bg-muted/20 p-3 space-y-2">
            <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {initials}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                        {profile.first_name} {profile.last_name}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                        Match {(Number(match.score) || 0).toFixed(1)}
                        {match.has_application ? ' · queued' : ' · no CV yet'}
                    </div>
                </div>
                {!match.has_application && (
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !canGenerate}
                        title={!canGenerate ? 'Job description required' : undefined}
                        onClick={handleGenerate}
                    >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Generate'}
                    </Button>
                )}
            </div>
            {err && <p className="text-[11px] text-destructive">{err}</p>}
        </div>
    );
}

// ---------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------

/** List filters carried from Job Links (?techstack=python, etc.). */
function listFiltersFromSearchParams(searchParams) {
    const filters = {};
    const search = searchParams.get('search');
    const techstack = searchParams.get('techstack');
    const available = searchParams.get('available');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');
    if (search) filters.search = search;
    if (techstack && techstack !== 'all') filters.techstack = techstack;
    if (available && available !== 'all') filters.available = available;
    if (dateFrom) filters.date_from = dateFrom;
    if (dateTo) filters.date_to = dateTo;
    if (searchParams.get('has_generated_resume') === '1') filters.has_generated_resume = 1;
    if (searchParams.get('today') === '1') {
        const today = new Date().toISOString().split('T')[0];
        filters.date_from = today;
        filters.date_to = today;
    }
    return filters;
}

function activeFilterChips(searchParams) {
    const chips = [];
    const techstack = searchParams.get('techstack');
    const search = searchParams.get('search');
    const available = searchParams.get('available');
    if (techstack && techstack !== 'all') {
        chips.push(`Tech: ${TECHSTACK_LABEL[techstack] || techstack}`);
    }
    if (search) chips.push(`Search: ${search}`);
    if (available === '1') chips.push('Available only');
    if (available === '0') chips.push('Unavailable only');
    if (searchParams.get('has_generated_resume') === '1') chips.push('Resume generated');
    if (searchParams.get('today') === '1') chips.push('Today');
    const dateFrom = searchParams.get('date_from');
    const dateTo = searchParams.get('date_to');
    if (dateFrom && !searchParams.get('today')) chips.push(`From ${dateFrom}`);
    if (dateTo && !searchParams.get('today')) chips.push(`To ${dateTo}`);
    return chips;
}

export default function JobLinkDetail() {
    const { id } = useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const [searchParams] = useSearchParams();
    const listQuery = location.search;
    const listFilters = useMemo(
        () => listFiltersFromSearchParams(searchParams),
        [searchParams]
    );
    // Derive list vs detail prefixes. Supports classic /job-links/:id and hub /pipeline/links/:id.
    const detailPrefix = location.pathname.replace(/\/[^/]*$/, '');
    const listPath = /\/pipeline\/links$/.test(detailPrefix)
        ? detailPrefix.replace(/\/links$/, '')
        : detailPrefix;
    const { user } = useAuth();
    const jobLinkId = parseInt(id, 10);

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    // Copy-to-clipboard state for the Job description card. We
    // flip `copied` to true for ~1.5s after a successful copy so
    // the icon swaps from <Copy/> to <Check/> and the user gets
    // visual feedback without us juggling a toast.
    const [copied, setCopied] = useState(false);

    const loadRequestRef = useRef(0);
    const load = useCallback(async () => {
        const requestId = ++loadRequestRef.current;
        try {
            const res = await adminAPI.getJobLinkApplications(jobLinkId, listFilters);
            if (requestId !== loadRequestRef.current) return;
            setData(res.data?.data || null);
            setError(null);
        } catch (err) {
            if (requestId !== loadRequestRef.current) return;
            setError(err.response?.data?.error || 'Failed to load job link');
        } finally {
            if (requestId === loadRequestRef.current) {
                setLoading(false);
            }
        }
    }, [jobLinkId, listFilters]);

    useEffect(() => {
        if (!jobLinkId) return;
        setLoading(true);
        load();
    }, [jobLinkId, load]);

    // Auto-refresh while generating, OR briefly while the rail is
    // still empty (cron / inline fallback may create apps after the
    // first paint — without this poll the page stays "0" forever).
    const applications = data?.applications || [];
    const matchedProfiles = data?.matched_profiles || [];
    const cron = data?.cron || {};
    const hasInFlight = useMemo(
        () => applications.some((a) => a.generation_status === 'pending' || a.generation_status === 'generating'),
        [applications]
    );
    const waitingForFirstApps = applications.length === 0 && !!data?.job_link;
    useEffect(() => {
        if (!hasInFlight && !waitingForFirstApps) return undefined;
        const t = setInterval(load, hasInFlight ? 4000 : 5000);
        return () => clearInterval(t);
    }, [hasInFlight, waitingForFirstApps, load]);

    // Cron tunables (admin-only edit). Fetched lazily — only
    // when the user is an admin (the route is gated server-
    // side). `defaults` and `bounds` are used to render
    // friendly labels under each input and to clamp client-
    // side before sending.
    const isAdmin = user?.role === 'admin';
    const [cfg, setCfg] = useState(null);
    const [cfgDraft, setCfgDraft] = useState(null);
    const [cfgSaving, setCfgSaving] = useState(false);
    const [cfgError, setCfgError] = useState(null);
    const [triggerBusy, setTriggerBusy] = useState(false);
    const [triggerMsg, setTriggerMsg] = useState(null);
    useEffect(() => {
        if (!isAdmin) return undefined;
        let cancelled = false;
        const loadCfg = async () => {
            try {
                const res = await adminAPI.getAutoApplyConfig();
                if (cancelled) return;
                setCfg(res.data);
                setCfgDraft({
                    intervalMs: res.data.config.intervalMs,
                    maxJobsPerTick: res.data.config.maxJobsPerTick,
                    maxProfilesPerJob: res.data.config.maxProfilesPerJob,
                    staleGeneratingMs: res.data.config.staleGeneratingMs,
                    runOnBoot: res.data.config.runOnBoot
                });
            } catch (err) {
                if (cancelled) return;
                setCfgError(err.response?.data?.error || err.message);
            }
        };
        loadCfg();
        // Refresh every 30s so the displayed values stay in
        // sync if another admin tweaks them.
        const t = setInterval(loadCfg, 30000);
        return () => { cancelled = true; clearInterval(t); };
    }, [isAdmin]);

    const handleSaveCfg = async () => {
        if (!cfgDraft) return;
        setCfgSaving(true);
        setCfgError(null);
        try {
            const res = await adminAPI.updateAutoApplyConfig(cfgDraft);
            setCfg({ ...cfg, config: res.data.config });
            setCfgDraft({
                intervalMs: res.data.config.intervalMs,
                maxJobsPerTick: res.data.config.maxJobsPerTick,
                maxProfilesPerJob: res.data.config.maxProfilesPerJob,
                staleGeneratingMs: res.data.config.staleGeneratingMs,
                runOnBoot: res.data.config.runOnBoot
            });
        } catch (err) {
            setCfgError(err.response?.data?.error || err.message);
        } finally {
            setCfgSaving(false);
        }
    };

    const handleTriggerCron = async () => {
        setTriggerBusy(true);
        setTriggerMsg(null);
        try {
            const res = await adminAPI.triggerAutoApply();
            const generated = res.data?.status?.lastRunAt;
            setTriggerMsg(
                res.data?.ok && res.data?.result?.ok
                    ? `Tick fired${generated ? ' (last run: ' + new Date(generated).toLocaleTimeString() + ')' : ''}.`
                    : 'Tick already running — coalesced.'
            );
        } catch (err) {
            setTriggerMsg(`Failed: ${err.response?.data?.error || err.message}`);
        } finally {
            setTriggerBusy(false);
        }
    };

    // RabbitMQ queue snapshot — visible to every user (not
    // admin-gated). Polled every 5s so the worker indicator
    // stays accurate without hammering the broker.
    const [queue, setQueue] = useState(null);
    useEffect(() => {
        let cancelled = false;
        const loadQueue = async () => {
            try {
                const res = await adminAPI.getAutoApplyQueue();
                if (cancelled) return;
                setQueue(res.data.queue);
            } catch (err) {
                if (cancelled) return;
                // Soft-fail: keep the previous snapshot.
            }
        };
        loadQueue();
        const t = setInterval(loadQueue, 5000);
        return () => { cancelled = true; clearInterval(t); };
    }, []);

    if (loading) return <PageLoader message="Loading job link..." />;
    if (error || !data) {
        return (
            <div className="space-y-4">
                <Button variant="ghost" onClick={() => navigate(`${listPath}${listQuery}`)}>
                    <ArrowLeft className="mr-1 h-4 w-4" /> Back
                </Button>
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {error || 'Job link not found'}
                </div>
            </div>
        );
    }

    const jobLink = data.job_link;
    const apps = applications;
    const pendingMatches = matchedProfiles.filter((m) => !m.has_application);
    const cronInfo = cron;
    const filterChips = activeFilterChips(searchParams);

    // Copy-to-clipboard helper for the Job description card.
    // Uses the modern Clipboard API when available (HTTPS or
    // localhost) and falls back to a hidden <textarea> + execCommand
    // for older browsers / insecure contexts. We reset the
    // "copied" badge after ~1.5s so the user gets feedback but
    // doesn't see stale "Copied" UI after navigating away.
    const handleCopyDescription = async () => {
        const text = jobLink.job_description || '';
        if (!text) return;
        let ok = false;
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                ok = true;
            }
        } catch (_) {
            // Fall through to legacy path below.
        }
        if (!ok) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'absolute';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                ok = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (_) {
                // give up; the UI just won't flip the badge
            }
        }
        if (ok) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
    };

    return (
        <AppPage flush>
        <div className="space-y-4 px-6 py-4 lg:px-8">
            {/* Sticky toolbar — back, filters, prev/next */}
            <Card className="sticky top-0 z-20 border-border/80 bg-background/95 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/90">
                <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => navigate(`${listPath}${listQuery}`)}>
                            <ArrowLeft className="mr-1 h-4 w-4" /> Job Links
                        </Button>
                        <div className="ml-auto flex items-center gap-1">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={!data.prev_id}
                                onClick={() => data.prev_id && navigate(`${detailPrefix}/${data.prev_id}${listQuery}`)}
                                title={data.prev_id ? 'Previous job in filtered list' : 'No previous job in filtered list'}
                            >
                                <ChevronLeft className="mr-1 h-4 w-4" /> Prev
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={!data.next_id}
                                onClick={() => data.next_id && navigate(`${detailPrefix}/${data.next_id}${listQuery}`)}
                                title={data.next_id ? 'Next job in filtered list' : 'No next job in filtered list'}
                            >
                                Next <ChevronRight className="ml-1 h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
                                {jobLink.position_title || jobLink.company_name || `Job link #${jobLink.id}`}
                            </h1>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                                {jobLink.company_name && jobLink.position_title && (
                                    <span className="inline-flex items-center gap-1">
                                        <Building2 className="h-3.5 w-3.5" />
                                        {jobLink.company_name}
                                    </span>
                                )}
                                {jobLink.techstack && (
                                    <Badge variant="secondary">
                                        {TECHSTACK_LABEL[jobLink.techstack] || jobLink.techstack}
                                    </Badge>
                                )}
                                {jobLink.location_flag && (
                                    <Badge variant="outline" className="uppercase text-[10px]">
                                        {jobLink.location_flag}
                                    </Badge>
                                )}
                                {(jobLink.created_by_username || jobLink.created_at) && (
                                    <span className="text-xs">
                                        Added{jobLink.created_by_username ? ` by ${jobLink.created_by_username}` : ''}
                                        {jobLink.created_at ? ` · ${formatJobLinkTimestamp(jobLink.created_at)}` : ''}
                                    </span>
                                )}
                            </div>
                        </div>
                        {(jobLink.job_apply_url || jobLink.source_url) && (
                            <Button variant="outline" size="sm" asChild>
                                <a href={jobLink.job_apply_url || jobLink.source_url} target="_blank" rel="noopener noreferrer">
                                    Open job <ExternalLink className="ml-1 h-3.5 w-3.5" />
                                </a>
                            </Button>
                        )}
                    </div>

                    {filterChips.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
                            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                List filter
                            </span>
                            {filterChips.map((chip) => (
                                <Badge key={chip} variant="outline" className="text-[11px]">
                                    {chip}
                                </Badge>
                            ))}
                            <span className="text-[11px] text-muted-foreground">
                                · Prev/Next stay within this filter
                            </span>
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="jobright-workspace xl:grid xl:grid-cols-5 xl:gap-4">
                {/* LEFT — job description + cron */}
                <div className="jobright-main space-y-4 xl:col-span-3">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0">
                            <CardTitle className="text-base">Job description</CardTitle>
                            {/* Copy-to-clipboard button. Disabled when
                                the description is empty (still being
                                scraped). Icon flips to a check + the
                                label flips to "Copied" for ~1.5s after
                                a successful copy so the user gets
                                visual feedback without a toast. */}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleCopyDescription}
                                disabled={!jobLink.job_description}
                                title={jobLink.job_description
                                    ? 'Copy the job description to clipboard'
                                    : 'Description is empty'}
                            >
                                {copied
                                    ? <Check className="mr-1 h-3.5 w-3.5" />
                                    : <Copy className="mr-1 h-3.5 w-3.5" />}
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <div className="flex flex-wrap items-center gap-2 text-sm">
                                {jobLink.company_name && !jobLink.position_title && (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Building2 className="h-4 w-4" />
                                        {jobLink.company_name}
                                    </span>
                                )}
                                {jobLink.position_title && !jobLink.company_name && (
                                    <span className="inline-flex items-center gap-1.5">
                                        <Briefcase className="h-4 w-4" />
                                        {jobLink.position_title}
                                    </span>
                                )}
                                {jobLink.location && (
                                    <span className="inline-flex items-center gap-1.5">
                                        <MapPin className="h-4 w-4" />
                                        {jobLink.location}
                                    </span>
                                )}
                            </div>

                            {jobLink.comment ? (
                                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
                                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
                                    <div>
                                        <div className="text-[11px] font-medium uppercase tracking-wide text-amber-200/80">
                                            Comment / notes
                                        </div>
                                        <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{jobLink.comment}</p>
                                    </div>
                                </div>
                            ) : null}

                            <div className="flex flex-col gap-1 text-xs">
                                {(jobLink.job_apply_url || jobLink.source_url) && (
                                    <a
                                        href={jobLink.job_apply_url || jobLink.source_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 break-all text-primary hover:underline"
                                    >
                                        {jobLink.job_apply_url || jobLink.source_url}
                                        <ExternalLink className="h-3 w-3 shrink-0" />
                                    </a>
                                )}
                            </div>

                            <div className="mt-3 max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                                {jobLink.job_description || (
                                    <span className="text-muted-foreground">
                                        Job description not fetched yet.{' '}
                                        <button
                                            type="button"
                                            className="text-primary underline"
                                            onClick={async () => {
                                                try {
                                                    await adminAPI.refetchJobLink(jobLink.id);
                                                    alert('Refetch queued — refresh this page in a few seconds.');
                                                } catch (err) {
                                                    alert(err.response?.data?.error || err.message || 'Refetch failed');
                                                }
                                            }}
                                        >
                                            Refetch now
                                        </button>
                                    </span>
                                )}
                            </div>
                        </CardContent>
                    </Card>

                    {/* Cron status card. Tells the user whether the
                        background auto-apply worker is running, how
                        often it ticks, and when it last did work.
                        Makes the new feature feel observable. */}
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base flex items-center gap-2">
                                <Play className="h-4 w-4" /> Auto-apply cron
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex items-center gap-2">
                                <span
                                    className={`inline-flex h-2.5 w-2.5 rounded-full ${
                                        cronInfo.running ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
                                    }`}
                                    title={cronInfo.running ? 'Running' : 'Idle'}
                                />
                                <span className="font-medium">
                                    {cronInfo.running ? 'Running' : 'Idle'}
                                </span>
                                <span className="text-muted-foreground">
                                    (every {Math.round((cronInfo.intervalMs || 300000) / 60000)} min, max{' '}
                                    {cronInfo.maxJobsPerTick || 5} jobs × {cronInfo.maxProfilesPerJob || 5} profiles
                                    per tick)
                                </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                                Last run:{' '}
                                {cronInfo.lastRunAt
                                    ? new Date(cronInfo.lastRunAt).toLocaleString()
                                    : '— (first tick runs on boot)'}
                            </div>
                            {cronInfo.lastError && (
                                <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                                    Last error: {cronInfo.lastError}
                                </div>
                            )}

                            {/* Live RabbitMQ queue snapshot. Shown
                                to every user (not admin-gated) so
                                they can see how many resume-
                                generation jobs are still in the
                                backlog. The cron enqueues; the
                                single worker (prefetch=1) picks
                                them up one at a time and
                                generates the DOCX, then marks the
                                job_applications row ready. */}
                            {queue && (
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs">
                                    <span className="font-medium">
                                        Resume queue
                                    </span>
                                    <span
                                        className="inline-flex items-center gap-1"
                                        title="Messages waiting in the RabbitMQ queue"
                                    >
                                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                        {queue.connected ? 'backlog' : 'disconnected'}:{' '}
                                        <strong>{queue.queueDepth}</strong>
                                    </span>
                                    <span
                                        className="inline-flex items-center gap-1"
                                        title="Currently being processed by the worker"
                                    >
                                        <span
                                            className={`h-1.5 w-1.5 rounded-full ${
                                                queue.processingCount > 0 ? 'bg-blue-500 animate-pulse' : 'bg-gray-400'
                                            }`}
                                        />
                                        worker:{' '}
                                        <strong>
                                            {queue.processingCount > 0 ? `processing ${queue.processingCount}` : 'idle'}
                                        </strong>
                                    </span>
                                    <span
                                        className="text-muted-foreground"
                                        title="Lifetime totals since the worker started"
                                    >
                                        ✓ {queue.processedTotal} processed · ✗ {queue.failedTotal} failed
                                    </span>
                                    {queue.lastError && (
                                        <span className="text-red-700 truncate max-w-[16rem]" title={queue.lastError}>
                                            err: {queue.lastError}
                                        </span>
                                    )}
                                </div>
                            )}

                            <p className="text-xs text-muted-foreground">
                                Cron picks every fetched job_link that doesn't already have a
                                pending / generating application, scores every profile by region
                                + techstack, and enqueues up to {cronInfo.maxProfilesPerJob || 5}{' '}
                                (profile, job_link) pairs onto the RabbitMQ-backed
                                <code className="mx-1 rounded bg-muted px-1">resume_generation</code>
                                queue. The single worker (prefetch=1) processes them one at a
                                time and inserts one job_application per top match.
                            </p>

                            {/* Admin-only tunables editor. Lets
                                admins re-tune period / jobs-per-
                                tick / profiles-per-job without
                                SSH + restart. Server clamps each
                                value to BOUNDS so a fat finger
                                can't break the pipeline. */}
                            {isAdmin && cfg && cfgDraft && (
                                <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-medium">
                                            Tunables (admin)
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={handleTriggerCron}
                                            disabled={triggerBusy || cronInfo.running}
                                            title="Fire one cron tick right now (coalesced if already running)"
                                        >
                                            {triggerBusy ? (
                                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <Play className="mr-1 h-3.5 w-3.5" />
                                            )}
                                            Trigger now
                                        </Button>
                                    </div>
                                    {triggerMsg && (
                                        <div className="rounded-md border border-border bg-background px-2 py-1 text-[11px]">
                                            {triggerMsg}
                                        </div>
                                    )}
                                    <div className="grid grid-cols-2 gap-2 text-xs">
                                        <label className="flex flex-col gap-0.5">
                                            <span className="text-muted-foreground">
                                                Period (ms)
                                            </span>
                                            <input
                                                type="number"
                                                min={cfg.bounds.intervalMs.min}
                                                max={cfg.bounds.intervalMs.max}
                                                step={1000}
                                                value={cfgDraft.intervalMs}
                                                onChange={(e) =>
                                                    setCfgDraft((d) => ({
                                                        ...d,
                                                        intervalMs: Number(e.target.value)
                                                    }))
                                                }
                                                className="rounded-md border border-input bg-background px-2 py-1"
                                            />
                                            <span className="text-[10px] text-muted-foreground">
                                                ≈ {Math.round(cfgDraft.intervalMs / 60000)} min
                                            </span>
                                        </label>
                                        <label className="flex flex-col gap-0.5">
                                            <span className="text-muted-foreground">
                                                Jobs / tick
                                            </span>
                                            <input
                                                type="number"
                                                min={cfg.bounds.maxJobsPerTick.min}
                                                max={1000}
                                                value={cfgDraft.maxJobsPerTick >= 1e9 ? '' : cfgDraft.maxJobsPerTick}
                                                placeholder="All ready"
                                                onChange={(e) =>
                                                    setCfgDraft((d) => ({
                                                        ...d,
                                                        maxJobsPerTick: e.target.value === '' ? Number.MAX_SAFE_INTEGER : Number(e.target.value)
                                                    }))
                                                }
                                                className="rounded-md border border-input bg-background px-2 py-1"
                                            />
                                            <span className="text-xs text-muted-foreground">
                                                {cfgDraft.maxJobsPerTick >= 1e9
                                                    ? 'All ready jobs per tick'
                                                    : `${cfgDraft.maxJobsPerTick} jobs per tick`}
                                            </span>
                                        </label>
                                        <label className="flex flex-col gap-0.5">
                                            <span className="text-muted-foreground">
                                                Profiles / job
                                            </span>
                                            <input
                                                type="number"
                                                min={cfg.bounds.maxProfilesPerJob.min}
                                                max={1000}
                                                value={cfgDraft.maxProfilesPerJob >= 1e9 ? '' : cfgDraft.maxProfilesPerJob}
                                                placeholder="All available"
                                                onChange={(e) =>
                                                    setCfgDraft((d) => ({
                                                        ...d,
                                                        maxProfilesPerJob: e.target.value === '' ? Number.MAX_SAFE_INTEGER : Number(e.target.value)
                                                    }))
                                                }
                                                className="rounded-md border border-input bg-background px-2 py-1"
                                            />
                                            <span className="text-xs text-muted-foreground">
                                                {cfgDraft.maxProfilesPerJob >= 1e9
                                                    ? 'All available profiles per job'
                                                    : `${cfgDraft.maxProfilesPerJob} profiles per job`}
                                            </span>
                                        </label>
                                        <label className="flex flex-col gap-0.5">
                                            <span className="text-muted-foreground">
                                                Stale recover (ms)
                                            </span>
                                            <input
                                                type="number"
                                                min={cfg.bounds.staleGeneratingMs.min}
                                                max={cfg.bounds.staleGeneratingMs.max}
                                                step={1000}
                                                value={cfgDraft.staleGeneratingMs}
                                                onChange={(e) =>
                                                    setCfgDraft((d) => ({
                                                        ...d,
                                                        staleGeneratingMs: Number(e.target.value)
                                                    }))
                                                }
                                                className="rounded-md border border-input bg-background px-2 py-1"
                                            />
                                        </label>
                                        <label className="col-span-2 flex items-center gap-2 text-xs">
                                            <input
                                                type="checkbox"
                                                checked={cfgDraft.runOnBoot}
                                                onChange={(e) =>
                                                    setCfgDraft((d) => ({
                                                        ...d,
                                                        runOnBoot: e.target.checked
                                                    }))
                                                }
                                            />
                                            <span>Run one tick immediately on server boot</span>
                                        </label>
                                    </div>
                                    {cfgError && (
                                        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
                                            {cfgError}
                                        </div>
                                    )}
                                    <div className="flex items-center justify-end gap-2">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                                setCfgDraft({
                                                    intervalMs: cfg.config.intervalMs,
                                                    maxJobsPerTick: cfg.config.maxJobsPerTick,
                                                    maxProfilesPerJob: cfg.config.maxProfilesPerJob,
                                                    staleGeneratingMs: cfg.config.staleGeneratingMs,
                                                    runOnBoot: cfg.config.runOnBoot
                                                })
                                            }
                                        >
                                            Reset
                                        </Button>
                                        <Button
                                            size="sm"
                                            onClick={handleSaveCfg}
                                            disabled={cfgSaving}
                                        >
                                            {cfgSaving && (
                                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                            )}
                                            Save tunables
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                {/* RIGHT — candidate CV rail (JobRight-style) */}
                <aside className="jobright-rail xl:col-span-2">
                    <div className="jobright-rail-inner">
                        <div className="jobright-rail-header">
                            <div className="jobright-rail-header-icon">
                                <FileText className="h-4 w-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="jobright-rail-title">Candidate CVs</div>
                                <div className="jobright-rail-subtitle">
                                    Auto-generated applications for this role
                                </div>
                            </div>
                            <Badge variant="outline" className="shrink-0 text-[10px]">
                                {apps.length}
                            </Badge>
                        </div>
                        <div className="space-y-3 max-h-[calc(100vh-12rem)] overflow-y-auto pr-0.5">
                            {apps.length === 0 ? (
                                <div className="space-y-3">
                                    <div className="jobright-empty rounded-md border border-dashed border-border/60 space-y-2">
                                        <p>
                                            {!jobLink.job_description || !String(jobLink.job_description).trim()
                                                ? (jobLink.fetch_status === 'failed' || jobLink.fetch_status === 'dead'
                                                    ? `No job description yet — scrape ${jobLink.fetch_status}. Auto CV cannot run until a JD is available. Fix the Source URL or paste a description, then Refetch.`
                                                    : jobLink.fetch_status === 'pending' || jobLink.fetch_status === 'fetching'
                                                        ? 'Fetching job description… CVs will generate automatically for matching profiles once it lands.'
                                                        : 'No job description yet — paste one or set a Source URL and Refetch. Auto CV needs a JD.')
                                                : pendingMatches.length
                                                    ? `${pendingMatches.length} matching profile${pendingMatches.length === 1 ? '' : 's'} — CVs generate automatically (or tap Generate).`
                                                    : `No profiles with techstack “${jobLink.techstack || '—'}”. Add that stack on Profiles, or change this job’s tech tag.`}
                                        </p>
                                        {jobLink.fetch_error && (!jobLink.job_description || !String(jobLink.job_description).trim()) ? (
                                            <p className="text-xs text-destructive/90 break-words">
                                                {String(jobLink.fetch_error).slice(0, 240)}
                                            </p>
                                        ) : null}
                                        <Button size="sm" variant="outline" onClick={load}>
                                            <RefreshCw className="mr-1 h-3.5 w-3.5" /> Refresh
                                        </Button>
                                    </div>
                                    {pendingMatches.map((m) => (
                                        <MatchedProfileRow
                                            key={m.profile?.id || m.score}
                                            jobLinkId={jobLink.id}
                                            match={m}
                                            onChanged={load}
                                            canGenerate={!!(jobLink.job_description && String(jobLink.job_description).trim())}
                                        />
                                    ))}
                                </div>
                            ) : (
                                apps.map((a) => (
                                    <ApplicationCard
                                        key={a.id}
                                        application={a}
                                        onChanged={load}
                                    />
                                ))
                            )}
                        </div>
                    </div>
                </aside>
            </div>
        </div>
        </AppPage>
    );
}