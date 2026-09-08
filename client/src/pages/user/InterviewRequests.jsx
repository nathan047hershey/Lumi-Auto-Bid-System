// User-side interview-request dashboard.
//
// Goal: give the user a single page to triage every recruiter reply they've
// captured — see which interview-requests are open, scheduled, completed, or
// cancelled, jump back into the application, and adjust the lifecycle if
// they recorded something incorrectly (e.g. clicked "scheduled" too early).
//
// Data is pulled from the existing GET /user/interview-requests endpoint
// and the same status PATCH endpoint the table view uses, so this page
// stays in sync with the modal-based workflow on /user/applications.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    CalendarClock,
    Search,
    X,
    RefreshCw,
    ChevronLeft,
    ChevronRight,
    Clock,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    FileDown
} from 'lucide-react';
import { userAPI } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { PageLoader, Loader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import { MilestoneList } from '@/components/MilestoneList';
import { MilestoneDetailCard } from '@/components/MilestoneDetailCard';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { toLocalInputValue } from './Applications';

// -- Status meta (mirrors the admin page) ----------------------------------
const STATUS_META = {
    requested: { label: 'Requested', variant: 'muted',      accent: 'text-slate-300 border-slate-500/30 bg-slate-500/10' },
    scheduled: { label: 'Scheduled', variant: 'info',        accent: 'text-sky-300 border-sky-500/30 bg-sky-500/10' },
    completed: { label: 'Completed', variant: 'success',     accent: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' },
    cancelled: { label: 'Cancelled', variant: 'destructive', accent: 'text-rose-300 border-rose-500/30 bg-rose-500/10' }
};

// The legacy `reply_channel` was retired — the channel is now encoded as
// the milestone kind (kind='video', kind='phone_screen', kind='ai_interview',
// kind='other' fallback). The MilestoneList component renders these via
// the existing MILESTONE_KINDS mapping, so no dedicated badge is needed.

const STATUS_TABS = [
    { value: 'all',       label: 'All' },
    { value: 'requested', label: 'Requested' },
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' }
];

// Page size for the user interview-requests table. We pick a
// slightly smaller default than the admin page (10) because the
// user page is typically viewed on smaller screens and the user
// usually has far fewer total rows anyway.
const USER_INTERVIEW_PAGE_SIZE = 10;

function StatusBadge({ status }) {
    const meta = STATUS_META[status] || { label: status, variant: 'muted' };
    return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function isExpired(iso) {
    if (!iso) return false;
    return new Date(iso).getTime() < Date.now();
}

function formatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString();
    } catch {
        return iso;
    }
}

// Generate a small text-file download from an in-memory blob. Used for
// the JD download buttons on user/admin interview-request modals.
function downloadAsTextFile(filename, body) {
    const blob = new Blob([body || ''], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Filename-safe slug from an arbitrary string (job title, company name).
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'jd';
}

// Resume link + JD blob download, used by the user-side detail dialog.
// Static resume serving lives at /resumes/<file> (same convention as
// the admin modal). The list endpoint now projects the resume and job
// description fields so this dialog can render the buttons from the
// list-payload alone.
function handleDownloadResume(resumeFilename) {
    if (!resumeFilename) return;
    window.open(`/resumes/${encodeURIComponent(resumeFilename)}`, '_blank');
}

function handleDownloadJD({ company, role, body }) {
    if (!body) return;
    const fname = `jd_${slugify(company)}_${slugify(role)}.txt`;
    downloadAsTextFile(fname, body);
}

// "Re-open" or "correct" helper used in the detail dialog.
function InterviewDetailDialog({ open, onOpenChange, row, onUpdated }) {
    // Pull auth context so MilestoneList can gate the "Mark complete"
    // action by the current user's role (admin vs assigned developer
    // vs neither) and the milestone's kind.
    const { user, additionalRoles } = useAuth();
    const currentUserRoles = useMemo(() => {
        const set = new Set();
        if (user?.role) set.add(user.role);
        for (const r of additionalRoles || []) set.add(r);
        return Array.from(set);
    }, [user, additionalRoles]);
    // Per-milestone detail fields (recruiter_message, reply_message,
    // interview_link, ai_interview_detail) live on the milestone rows —
    // we fetch them lazily so the dialog can render a per-step detail
    // card below the editable MilestoneList.
    const [detailMilestones, setDetailMilestones] = useState([]);

    useEffect(() => {
        if (!open || !row?.application_id) {
            setDetailMilestones([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await userAPI.listMilestones(row.application_id);
                if (cancelled) return;
                // The 2026-07 endpoint returns `{ milestones: [...], ... }`
                // while the legacy endpoint returned a bare array. Accept
                // both shapes so the dialog renders regardless of which
                // route was hit.
                const payload = res?.data;
                const list = Array.isArray(payload)
                    ? payload
                    : (payload && Array.isArray(payload.milestones) ? payload.milestones : []);
                setDetailMilestones(list);
            } catch (err) {
                if (!cancelled) setDetailMilestones([]);
            }
        })();
        return () => { cancelled = true; };
    }, [open, row?.application_id]);

    if (!row) return null;

    return (
        <div
            className={cn(
                'fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4',
                open ? 'opacity-100' : 'pointer-events-none opacity-0',
                'transition-opacity'
            )}
            onClick={() => onOpenChange(false)}
        >
            <div
                className={cn(
                    'relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl',
                    'dialog-scroll'
                )}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex flex-col gap-3 border-b border-border bg-card/80 p-5">
                    <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                            <h2 className="text-lg font-semibold leading-none">
                                {row.company_name || `Application #${row.application_id}`}
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                {row.job_role || 'Role unspecified'} · {row.profile_name || 'Profile'}
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <StatusBadge status={row.status} />
                            <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)}>
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                    {/* Downloads — same pattern as the admin modal:
                        resume uses /resumes/<file> (static), JD is
                        generated client-side as a `.txt` blob. */}
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => handleDownloadResume(row.application_resume_filename)}
                            disabled={!row.application_resume_filename}
                            title={
                                row.application_resume_filename
                                    ? `Download resume (${row.application_resume_filename})`
                                    : 'No resume uploaded for this application'
                            }
                        >
                            <FileDown className="h-3.5 w-3.5" />
                            Download resume
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            type="button"
                            onClick={() => handleDownloadJD({
                                company: row.company_name,
                                role: row.job_role,
                                body: row.job_description
                            })}
                            disabled={!row.job_description}
                            title={
                                row.job_description
                                    ? `Download job description for ${row.company_name}`
                                    : 'No job description recorded'
                            }
                        >
                            <FileDown className="h-3.5 w-3.5" />
                            Download job description
                        </Button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-5 dialog-scroll">
                    {/* Recruiter reply — read-only context. The "head"
                        message that kicked off this interview request;
                        everything else (date, type, interviewer, link)
                        lives on individual milestones below. */}
                    <div className="rounded-md border border-border p-3 space-y-1.5">
                        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                            Interview Progress
                        </Label>
                        <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-background/40 p-3 text-sm whitespace-pre-wrap">
                            {row.recruiter_reply || <span className="italic text-muted-foreground">No reply captured.</span>}
                        </div>
                        {row.recruiter_reply_at && (
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                {formatDate(row.recruiter_reply_at)}
                            </p>
                        )}
                    </div>

                    {/* Milestones — read-only progress trail + per-step
                        detail cards. The list view here is the same
                        data the editable MilestoneList manages, so the
                        latest milestone kind drives the row's status
                        pill in the Applications table. */}
                    <div className="mt-4 rounded-md border border-border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                Milestones
                            </Label>
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                {row.status === 'cancelled' ? 'Final trail (cancelled)'
                                    : row.status === 'completed' ? 'Final trail (completed)'
                                    : 'Step by step'}
                            </span>
                        </div>
                        <MilestoneList
                            applicationId={row.application_id}
                            finalState={row.status}
                            currentUserRoles={currentUserRoles}
                            assignedDeveloperId={row.assigned_developer_id ?? null}
                            currentUserId={user?.id ?? null}
                        />

                        {detailMilestones.some((m) =>
                            m.recruiter_message
                            || m.reply_message
                            || m.interview_link
                            || (m.kind === 'ai_interview' && m.ai_interview_detail)
                        ) && (
                            <div className="space-y-2 border-t border-dashed border-border pt-3">
                                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                    Step-by-step detail
                                </Label>
                                <div className="space-y-2">
                                    {detailMilestones.map((m, idx) => (
                                        <MilestoneDetailCard
                                            key={m.id || idx}
                                            milestone={m}
                                            index={idx}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-card/80 p-4">
                    <Button asChild variant="ghost" size="sm">
                        <Link to={`/user/pipeline/applications`}>
                            Open in Applications <ChevronRight className="h-3.5 w-3.5" />
                        </Link>
                    </Button>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </div>
            </div>
        </div>
    );
}

function InterviewRequestsPage({ embedded = false }) {
    const { user, additionalRoles } = useAuth();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    // Current user's effective roles (primary + additional). Used by
    // MilestoneList to gate the "Mark complete" button per role.
    const currentUserRoles = useMemo(() => {
        const set = new Set();
        if (user?.role) set.add(user.role);
        for (const r of additionalRoles || []) set.add(r);
        return Array.from(set);
    }, [user, additionalRoles]);

    // Filters
    const [status, setStatus] = useState('all');
    const [search, setSearch] = useState('');
    // Debounced search so we don't refetch on every keystroke. The
    // server-side filter is `search` (LIKE %x% on company / role /
    // profile), so we keep the source-of-truth on the server and
    // only mirror the visible input locally.
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(t);
    }, [search]);

    // Pagination (mirror of the admin page). The server returns a
    // `pagination` envelope; we keep `page` (1-based) and `total`
    // locally so the Prev/Next controls can disable at the edges.
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const totalPages = Math.max(1, Math.ceil(total / USER_INTERVIEW_PAGE_SIZE));

    // Detail dialog
    const [openRow, setOpenRow] = useState(null);

    const load = async (params = {}) => {
        try {
            if (params.silent) setRefreshing(true); else setLoading(true);
            setError(null);
            const res = await userAPI.listInterviewRequests({
                // Server-side filters. The status + search mirror the
                // visible inputs so the server returns only rows
                // matching the active filter. The page size is
                // constant for the same reason the admin page is:
                // there's no user-facing "show N per page" toggle.
                status: params.status ?? status,
                search: params.search ?? debouncedSearch,
                page:   params.page   ?? page,
                limit:  USER_INTERVIEW_PAGE_SIZE
            });
            // The user endpoint now returns a paginated envelope;
            // fall back to a bare array for safety (e.g. if some
            // proxy/cache mocks the legacy shape).
            const payload = res.data?.rows ?? res.data;
            setRows(Array.isArray(payload) ? payload : []);
            const returnedTotal = res.data?.pagination?.total;
            setTotal(typeof returnedTotal === 'number' ? returnedTotal : 0);
        } catch (err) {
            console.error('Failed to load interview-requests:', err);
            setError(err.response?.data?.error || 'Failed to load interview requests');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    // Reset to page 1 whenever any server-side filter changes —
    // otherwise the user can land on an empty page because the new
    // filter narrowed the result set below the previous offset.
    useEffect(() => {
        setPage(1);
    }, [debouncedSearch, status]);

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch, status, page]);

    // Aggregations for the KPI tiles
    const counts = useMemo(() => {
        const out = { requested: 0, scheduled: 0, completed: 0, cancelled: 0, total: 0, expired: 0 };
        for (const r of rows) {
            if (r.status in out) out[r.status] += 1;
            out.total += 1;
            if (isExpired(r.expire_time) && r.status === 'requested') out.expired += 1;
        }
        return out;
    }, [rows]);

    // Filtered list
    const visibleRows = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter((r) => {
            if (status !== 'all' && r.status !== status) return false;
            if (!q) return true;
            return (
                (r.company_name || '').toLowerCase().includes(q) ||
                (r.job_role || '').toLowerCase().includes(q) ||
                (r.profile_name || '').toLowerCase().includes(q) ||
                (r.interview_type || '').toLowerCase().includes(q)
            );
        });
    }, [rows, status, search]);

    if (loading) return <PageLoader message="Loading interview requests..." />;

    return (
        <AppPage
            embedded={embedded}
            icon={CalendarClock}
            title="My Interview Progress"
            description="Track recruiter replies, see where each stands, and fix the lifecycle if recorded incorrectly."
        >
        <div className="space-y-4">
            <PageCommandBar
                search={(
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <Input
                            id="ir-search"
                            className="h-10 border-white/10 bg-black/25 pl-10"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search company, role, profile…"
                        />
                    </div>
                )}
                actions={(
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-10"
                        onClick={() => load({ silent: true })}
                        disabled={refreshing}
                    >
                        {refreshing ? <Loader size="sm" /> : <RefreshCw className="h-4 w-4" />}
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                )}
                filters={(
                    <>
                        {STATUS_TABS.map((t) => {
                            const isActive = status === t.value;
                            return (
                                <button
                                    key={t.value}
                                    type="button"
                                    onClick={() => setStatus(t.value)}
                                    className={cn(
                                        'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition',
                                        isActive
                                            ? 'border-primary/40 bg-primary/15 text-primary'
                                            : 'border-white/10 bg-black/20 text-white/55 hover:text-white/80'
                                    )}
                                >
                                    {t.label}
                                    <span className={cn(
                                        'rounded-md px-1.5 py-0.5 text-[10px] tabular-nums',
                                        isActive ? 'bg-primary/20 text-primary' : 'bg-white/5 text-white/40'
                                    )}>
                                        {t.value === 'all' ? counts.total : (counts[t.value] ?? 0)}
                                    </span>
                                </button>
                            );
                        })}
                    </>
                )}
            />

            {/* KPI tiles */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <KpiTile label="Total"     value={counts.total}     icon={<CalendarClock className="h-4 w-4" />} />
                <KpiTile label="Requested" value={counts.requested} icon={<Clock className="h-4 w-4" />} tone="slate" />
                <KpiTile label="Scheduled" value={counts.scheduled} icon={<CalendarClock className="h-4 w-4" />} tone="sky" />
                <KpiTile label="Completed" value={counts.completed} icon={<CheckCircle2 className="h-4 w-4" />} tone="emerald" />
                <KpiTile label="Cancelled" value={counts.cancelled} icon={<XCircle className="h-4 w-4" />} tone="rose" />
            </div>

            {counts.expired > 0 && (
                <div className="flex items-start gap-2 rounded-2xl border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                        <strong>{counts.expired}</strong> request{counts.expired === 1 ? ' is' : 's are'} past
                        their expire time and still in <strong>Requested</strong>. Consider re-opening
                        them with fresh <em>Requested time</em> / <em>Expire time</em>, or cancelling
                        if the recruiter has gone quiet.
                    </p>
                </div>
            )}

            {error && (
                <div className="rounded-xl border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-red-200">
                    {error}
                </div>
            )}

            <ListToolbar
                label={
                    total === 0
                        ? 'No requests'
                        : `${total} request${total === 1 ? '' : 's'}${
                            total > 0
                                ? ` · showing ${(page - 1) * USER_INTERVIEW_PAGE_SIZE + 1}–${Math.min(page * USER_INTERVIEW_PAGE_SIZE, total)}`
                                : ''
                        }`
                }
                trailing={totalPages > 1 ? (
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8"
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={page === 1}
                        >
                            <ChevronLeft className="h-3.5 w-3.5" /> Prev
                        </Button>
                        <span className="text-xs text-white/50">
                            Page <strong className="text-white/80">{page}</strong> of <strong className="text-white/80">{totalPages}</strong>
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8"
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={page >= totalPages}
                        >
                            Next <ChevronRight className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                ) : null}
            />

            <div className="relative space-y-3">
                {refreshing && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center gap-3 rounded-2xl bg-background/50 backdrop-blur-sm text-sm text-white/50">
                        <Loader size="md" />
                        Refreshing…
                    </div>
                )}

                {visibleRows.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                        No interview-requests match the current filters.
                    </div>
                ) : (
                    visibleRows.map((r) => {
                        const expired = isExpired(r.expire_time);
                        return (
                            <article
                                key={r.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => setOpenRow(r)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setOpenRow(r);
                                    }
                                }}
                                className={cn(
                                    'group relative flex cursor-pointer overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] transition-all duration-200',
                                    'hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)] hover:shadow-lg hover:shadow-primary/10'
                                )}
                            >
                                <div
                                    className={cn(
                                        'w-1 shrink-0 bg-gradient-to-b',
                                        r.status === 'scheduled' && 'from-sky-400 to-teal-500',
                                        r.status === 'completed' && 'from-emerald-400 to-teal-600',
                                        r.status === 'cancelled' && 'from-rose-400 to-rose-700',
                                        r.status === 'requested' && 'from-slate-400 to-slate-600',
                                        !STATUS_META[r.status] && 'from-teal-400 to-cyan-600'
                                    )}
                                    aria-hidden
                                />
                                <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="truncate text-sm font-semibold text-white">
                                                {r.company_name || `#${r.application_id}`}
                                            </h3>
                                            <StatusBadge status={r.status} />
                                        </div>
                                        <p className="truncate text-xs text-white/45">
                                            {r.job_role || 'Role unspecified'}
                                            {r.profile_name ? ` · ${r.profile_name}` : ''}
                                        </p>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/40">
                                            <span>
                                                Scheduled:{' '}
                                                {r.scheduled_date
                                                    ? `${r.scheduled_date}${r.scheduled_time ? ` ${r.scheduled_time}` : ''}${r.timezone ? ` (${r.timezone})` : ''}`
                                                    : '—'}
                                            </span>
                                            <span>Requested: {formatDate(r.requested_time)}</span>
                                            <span className={cn(expired && r.status === 'requested' && 'text-rose-300')}>
                                                Expire:{' '}
                                                {r.expire_time
                                                    ? `${formatDate(r.expire_time)}${expired ? ' (expired)' : ''}`
                                                    : '—'}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-8"
                                            onClick={(e) => { e.stopPropagation(); setOpenRow(r); }}
                                        >
                                            View
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </div>
                            </article>
                        );
                    })
                )}
            </div>

            <InterviewDetailDialog
                open={!!openRow}
                onOpenChange={(o) => !o && setOpenRow(null)}
                row={openRow}
                onUpdated={() => load({ silent: true })}
            />
        </div>
        </AppPage>
    );
}

function KpiTile({ label, value, icon, tone = 'slate' }) {
    const toneClasses = {
        slate:   'border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] text-slate-300',
        sky:     'border-sky-500/25 bg-sky-500/10 text-sky-300',
        emerald: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
        rose:    'border-rose-500/25 bg-rose-500/10 text-rose-300'
    }[tone] || 'border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] text-white';
    return (
        <div className={cn('flex items-center gap-3 rounded-2xl border p-3 backdrop-blur-sm', toneClasses)}>
            <div className="rounded-xl border border-current/25 bg-black/20 p-1.5">
                {icon}
            </div>
            <div>
                <div className="text-2xl font-bold leading-none tabular-nums text-white">{value}</div>
                <div className="mt-0.5 text-[11px] text-white/45">{label}</div>
            </div>
        </div>
    );
}

export default InterviewRequestsPage;
