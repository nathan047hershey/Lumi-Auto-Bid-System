// =============================================================================
// DeveloperDashboard — landing page for role='developer'
// =============================================================================
// Shows the developer's pipeline of interview requests assigned to them
// (interview_requests.assigned_developer_id = current user). Each row
// renders the same way as the admin / user side: status badge, latest
// milestone summary, and an in-page MilestoneAccordion so the
// developer can drill into every step without leaving the dashboard.
//
// The developer can:
//   - Mark milestones complete via a dedicated form that captures the
//     actual interview time + outcome memo BEFORE flipping the flag
//     (server stores `completed_at` = picked time, `memo` is updated).
//   - Add a new milestone after the current one is completed.
//   - Download the candidate's resume + the full job description.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Briefcase,
    CalendarClock,
    Check,
    ChevronDown,
    ChevronRight,
    Clock,
    Download,
    FileText,
    Plus,
    RefreshCw,
    Search,
    User as UserIcon,
    X
} from 'lucide-react';
import { userAPI } from '@/api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { DatePicker, DateTimePicker } from '@/components/DatePicker';
import { MilestoneAccordion } from '@/components/MilestoneAccordion';
import { milestoneLabel, requiresInterviewTime, INTERVIEW_KINDS } from '@/components/MilestoneList';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';

const STATUS_META = {
    requested: { label: 'Requested', accent: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
    scheduled: { label: 'Scheduled', accent: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
    completed: { label: 'Completed', accent: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
    cancelled: { label: 'Cancelled', accent: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
    // Derived badges — driven by the latest milestone, not by the
    // parent interview_request.status. The server stamps
    // `latest_milestone_expired` automatically and the dashboard
    // picks the highest-priority badge per row.
    pending:  { label: 'Pending',  accent: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    expired:  { label: 'Expired',  accent: 'bg-rose-500/20 text-rose-300 border-rose-500/40' }
};

// Same whitelist the server enforces — keeps the mark-complete button
// honest without a round-trip on every click. Admin-only kinds
// (`recruiter_reply`, `offer`, `other`) are explicitly excluded so the
// developer can't accidentally bypass the business / pipeline gate.
const DEVELOPER_COMPLETABLE_KINDS = new Set([
    'ai_interview',
    'phone_screen',
    'video',
    'technical',
    'hiring_manager_interview',
    'panel_interview'
]);

// All kinds the developer can pick when adding a new milestone. This
// is a superset of DEVELOPER_COMPLETABLE_KINDS — the developer can
// add a recruiter_reply / offer / etc. even though they can't complete
// it, because admin / user will drive those kinds to completion.
const DEVELOPER_PICKABLE_KINDS = [
    'recruiter_reply',
    'ai_interview',
    'phone_screen',
    'video',
    'technical',
    'hiring_manager_interview',
    'panel_interview',
    'offer',
    'other'
];

// Subset used by the dashboard's interview-type filter. Excludes
// `recruiter_reply` and `offer` because those aren't interview
// meetings — the user wanted them out of the filter dropdown so the
// filter only surfaces actionable interview work.
const INTERVIEW_FILTER_KINDS = DEVELOPER_PICKABLE_KINDS.filter(
    (k) => k !== 'recruiter_reply' && k !== 'offer'
);

function StatusBadge({ status }) {
    const meta = STATUS_META[status] || STATUS_META.requested;
    return (
        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider', meta.accent)}>
            {meta.label}
        </span>
    );
}

function formatDateTime(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString();
    } catch { return '—'; }
}

// Slug for the JD download filename. Mirrors the admin download logic.
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'jd';
}

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

function DeveloperDashboard() {
    const { user } = useAuth();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);

    // Filters — same shape as the admin Interview Requests dashboard so
    // the developer's experience is consistent.
    const [statusFilter, setStatusFilter] = useState('all');
    const [search, setSearch] = useState('');
    // Interview-type filter matches the LATEST milestone on each row
    // (server-side we project `latest_milestone_kind` into the row so
    // the filter works without loading every milestone list). The
    // special "interview" value matches every kind that represents an
    // actual interview meeting — phone screen, video, technical,
    // hiring manager, panel, AI interview — so the developer can
    // quickly surface "everything I have to attend" without picking a
    // specific channel.
    const [kindFilter, setKindFilter] = useState('all');
    // Date filter matches the latest milestone's scheduled date
    // (yyyy-MM-dd prefix). Empty string means no filter.
    const [dateFilter, setDateFilter] = useState('');
    // Per-row expand state — keeps the milestone accordion collapsed by
    // default and only loads the milestones on demand so the dashboard
    // doesn't burst-fetch the entire pipeline on first paint.
    const [openRow, setOpenRow] = useState(null);
    // Per-row milestone cache + loading state so the accordion can
    // render without blocking the row.
    const [milestonesByApp, setMilestonesByApp] = useState({});
    const [loadingMilestones, setLoadingMilestones] = useState({});

    const load = useCallback(async (params = {}) => {
        try {
            if (params.silent) setRefreshing(true); else setLoading(true);
            setError(null);
            const res = await userAPI.listAssignedRequests();
            setRows(Array.isArray(res.data) ? res.data : []);
        } catch (err) {
            console.error('Load assigned requests failed:', err);
            setError(err.response?.data?.error || 'Failed to load assigned interview requests');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Derived per-row badge: each row gets a single "headline" badge
    // reflecting the latest milestone's state — expired > completed >
    // pending. `r.latest_milestone_expired` is stamped by the server
    // (scheduled_at in the past, milestone not yet completed); the
    // other two are computed inline from the latest-milestone columns
    // the server also projects into the row.
    const badgeFor = (r) => {
        if (r.latest_milestone_expired) return 'expired';
        if (r.latest_milestone_completed_at) return 'completed';
        if (r.latest_milestone_kind) return 'pending';
        return r.status || 'requested';
    };

    const visibleRows = useMemo(() => {
        const q = search.trim().toLowerCase();
        return rows.filter((r) => {
            // Status filter — the legacy values (requested/scheduled/
            // completed/cancelled) match `r.status`. The new derived
            // values (pending/expired) match the per-row badge we
            // compute below. "completed" also catches rows whose
            // latest milestone is done even if the request itself is
            // still in 'requested' status, which is what the user
            // wants for the dashboard.
            if (statusFilter !== 'all') {
                if (statusFilter === 'pending' || statusFilter === 'expired') {
                    if (badgeFor(r) !== statusFilter) return false;
                } else if (r.status !== statusFilter) {
                    return false;
                }
            }
            // Interview-type filter against the latest milestone kind.
            // The "interview" pseudo-value matches every kind that
            // represents a real interview meeting (incl. AI interview)
            // so the developer can surface "everything I have to
            // attend" without picking a specific channel.
            if (kindFilter !== 'all') {
                const kind = r.latest_milestone_kind;
                if (kindFilter === 'interview') {
                    if (!INTERVIEW_KINDS.has(kind)) return false;
                } else if (kind !== kindFilter) {
                    return false;
                }
            }
            // Date filter matches the latest milestone's scheduled
            // date by yyyy-MM-dd prefix (works regardless of the
            // timezone-free storage format the write path uses now).
            if (dateFilter) {
                const sched = r.latest_milestone_scheduled_at;
                if (!sched) return false;
                const datePart = String(sched).slice(0, 10);
                if (datePart !== dateFilter) return false;
            }
            if (!q) return true;
            return [r.company_name, r.job_role, r.profile_name]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q));
        });
    }, [rows, statusFilter, search, kindFilter, dateFilter]);

    // Per-row summaries for KPI tiles. Coarser than the admin tile
    // because milestones are loaded per-row on expand. The approved-
    // minutes rollup walks the cached milestone map so it stays
    // accurate without an extra endpoint — every approved milestone
    // with a numeric `duration_minutes` adds to the total. If the
    // developer hasn't expanded a row yet its milestones are missing
    // from the cache, which understates the number; the UI surfaces
    // this with a "Expand a row to refresh" hint next to the tile.
    //
    // The new tiles (Pending / Expired / Completed) count the
    // per-row BADGE state rather than `r.status` so they reflect
    // the latest milestone. The legacy "byStatus" map is still
    // computed for the row-counting tile and the by-request-status
    // summary line, but the headline tiles are badge-based now.
    const summary = useMemo(() => {
        const total = rows.length;
        const byStatus = { requested: 0, scheduled: 0, completed: 0, cancelled: 0 };
        const byBadge = { pending: 0, expired: 0, completed: 0 };
        let approvedMinutes = 0;
        let approvedCount = 0;
        for (const r of rows) {
            if (byStatus[r.status] != null) byStatus[r.status] += 1;
            const badge = badgeFor(r);
            if (byBadge[badge] != null) byBadge[badge] += 1;
            const ms = milestonesByApp[r.application_id];
            if (Array.isArray(ms)) {
                for (const m of ms) {
                    if (m.approved) {
                        approvedCount += 1;
                        const n = parseInt(m.duration_minutes, 10);
                        if (Number.isFinite(n) && n > 0) approvedMinutes += n;
                    }
                }
            }
        }
        return { total, byStatus, byBadge, approvedMinutes, approvedCount };
    }, [rows, milestonesByApp]);

    // Pretty-print the approved-time total as `2h 30m` for ≥60 min,
    // else plain `45 min`. Keeps the KPI tile compact.
    const approvedTimeLabel = (() => {
        const m = summary.approvedMinutes || 0;
        if (m <= 0) return '0 min';
        const hours = Math.floor(m / 60);
        const mins = m % 60;
        if (hours && mins) return `${hours}h ${mins}m`;
        if (hours) return `${hours}h`;
        return `${m} min`;
    })();

    // Fetch milestones for one row on expand. Cached so a re-collapse
    // + re-expand doesn't re-fetch.
    const loadMilestonesForRow = useCallback(async (applicationId) => {
        if (milestonesByApp[applicationId] || loadingMilestones[applicationId]) return;
        setLoadingMilestones((prev) => ({ ...prev, [applicationId]: true }));
        try {
            const res = await userAPI.listMilestones(applicationId);
            const payload = res?.data;
            const list = Array.isArray(payload)
                ? payload
                : (payload && Array.isArray(payload.milestones) ? payload.milestones : []);
            setMilestonesByApp((prev) => ({ ...prev, [applicationId]: list }));
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to load milestones');
        } finally {
            setLoadingMilestones((prev) => ({ ...prev, [applicationId]: false }));
        }
    }, [milestonesByApp, loadingMilestones]);

    const handleToggleRow = useCallback((applicationId) => {
        const nextOpen = openRow === applicationId ? null : applicationId;
        setOpenRow(nextOpen);
        if (nextOpen != null) {
            loadMilestonesForRow(applicationId);
        }
    }, [openRow, loadMilestonesForRow]);

    const handleDownloadResume = (row) => {
        if (!row?.application_resume_filename) return;
        window.open(`/resumes/${row.application_resume_filename}`, '_blank');
    };

    const handleDownloadJD = (row) => {
        if (!row?.job_description) return;
        const fname = `jd_${slugify(row.company_name)}_${slugify(row.job_role)}.txt`;
        downloadAsTextFile(fname, row.job_description);
    };

    // ----- Inline forms state -----
    const [activeFormRowId, setActiveFormRowId] = useState(null);
    // null = add form, otherwise = complete form (with target milestone)
    const [activeFormMilestone, setActiveFormMilestone] = useState(null);
    const [completeDraft, setCompleteDraft] = useState({ memo: '', duration_minutes: '' });
    const [addDraft, setAddDraft] = useState({ kind: 'recruiter_reply', label: '', scheduled_at: '', memo: '' });
    const [formBusy, setFormBusy] = useState(false);
    const [formError, setFormError] = useState(null);

    // Handler passed to MilestoneAccordion.onComplete — gated to the
    // developer-completable kinds (matches the server whitelist so
    // the UI doesn't waste a round-trip on kinds that would 403).
    const handleComplete = (m) => {
        if (!DEVELOPER_COMPLETABLE_KINDS.has(m.kind)) {
            setError(`"${milestoneLabel(m.kind)}" can only be marked complete by an admin.`);
            return;
        }
        setActiveFormRowId(m.application_id);
        setActiveFormMilestone(m);
        setCompleteDraft({
            memo: m.memo || '',
            duration_minutes: m.duration_minutes != null ? String(m.duration_minutes) : ''
        });
    };

    const handleAdd = (m) => {
        setActiveFormRowId(m.application_id);
        setActiveFormMilestone(null);
        setAddDraft({ kind: 'recruiter_reply', label: '', scheduled_at: '', memo: '' });
    };

    const refreshRowMilestones = useCallback(async (applicationId) => {
        setMilestonesByApp((prev) => {
            const next = { ...prev };
            delete next[applicationId];
            return next;
        });
        await loadMilestonesForRow(applicationId);
    }, [loadMilestonesForRow]);

    const submitComplete = async () => {
        if (!activeFormMilestone) return;
        setFormBusy(true);
        setFormError(null);
        try {
            // Coerce the duration string to a positive integer (or null)
            // before sending so the server receives a clean payload
            // regardless of how the picker was left (empty / partial).
            let duration = null;
            const raw = String(completeDraft.duration_minutes || '').trim();
            if (raw) {
                const n = parseInt(raw, 10);
                if (Number.isFinite(n) && n > 0 && n <= 1440) duration = n;
            }
            await userAPI.completeMilestone(activeFormMilestone.application_id, {
                memo: completeDraft.memo || null,
                duration_minutes: duration
            });
            await refreshRowMilestones(activeFormMilestone.application_id);
            setActiveFormMilestone(null);
            setActiveFormRowId(null);
        } catch (err) {
            setFormError(err.response?.data?.error || 'Failed to complete milestone');
        } finally {
            setFormBusy(false);
        }
    };

    const submitAdd = async () => {
        if (!activeFormRowId) return;
        setFormBusy(true);
        setFormError(null);
        try {
            await userAPI.addMilestone(activeFormRowId, {
                kind: addDraft.kind,
                label: addDraft.label || null,
                scheduled_at: addDraft.scheduled_at || null,
                memo: addDraft.memo || null
            });
            await refreshRowMilestones(activeFormRowId);
            setActiveFormMilestone(null);
            setActiveFormRowId(null);
            setAddDraft({ kind: 'recruiter_reply', label: '', scheduled_at: '', memo: '' });
        } catch (err) {
            setFormError(err.response?.data?.error || 'Failed to add milestone');
        } finally {
            setFormBusy(false);
        }
    };

    return (
        <AppPage
            icon={CalendarClock}
            title="Developer Dashboard"
            description={`Interview requests assigned to you, ${user?.username}.`}
        >
        <div className="space-y-4">
            <PageCommandBar
                search={(
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <Input
                            className="h-10 border-white/10 bg-black/25 pl-10"
                            placeholder="Search company, role, profile…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                )}
                actions={(
                    <Button variant="outline" size="sm" className="h-10" onClick={() => load({ silent: true })} disabled={refreshing}>
                        <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                )}
                filters={(
                    <>
                        <Select value={statusFilter} onValueChange={setStatusFilter}>
                            <SelectTrigger className="h-9 w-[9.5rem] border-white/10 bg-black/20">
                                <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All statuses</SelectItem>
                                <SelectItem value="pending">Pending</SelectItem>
                                <SelectItem value="expired">Expired</SelectItem>
                                <SelectItem value="completed">Completed</SelectItem>
                                <SelectItem value="cancelled">Cancelled</SelectItem>
                            </SelectContent>
                        </Select>
                        <Select value={kindFilter} onValueChange={setKindFilter}>
                            <SelectTrigger className="h-9 w-[11rem] border-white/10 bg-black/20">
                                <SelectValue placeholder="Interview type" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All interview types</SelectItem>
                                <SelectItem value="interview">All interview meetings</SelectItem>
                                {INTERVIEW_FILTER_KINDS.map((k) => (
                                    <SelectItem key={k} value={k}>{milestoneLabel(k)}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1">
                            <DatePicker
                                className="h-9 w-[10rem] border-white/10 bg-black/20"
                                value={dateFilter}
                                onChange={(e) => setDateFilter(e.target.value)}
                                title="Filter by latest milestone scheduled date"
                                placeholder="Filter by date"
                            />
                            {dateFilter && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setDateFilter('')}
                                    title="Clear date filter"
                                    className="h-9 px-2"
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            )}
                        </div>
                    </>
                )}
            />

            {error && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
                <KpiTile label="Total" value={summary.total} Icon={Briefcase} />
                <KpiTile
                    label="Pending"
                    value={summary.byBadge.pending}
                    accent="amber"
                    subtitle="Latest milestone not yet completed"
                />
                <KpiTile
                    label="Expired"
                    value={summary.byBadge.expired}
                    accent="rose"
                    subtitle="Scheduled time has passed"
                />
                <KpiTile
                    label="Completed"
                    value={summary.byBadge.completed}
                    accent="emerald"
                    subtitle="Latest milestone closed"
                />
                <KpiTile
                    label="Approved time"
                    value={approvedTimeLabel}
                    accent="emerald"
                    subtitle={
                        summary.approvedCount > 0
                            ? `${summary.approvedCount} approved milestone${summary.approvedCount === 1 ? '' : 's'}`
                            : 'No approved milestones yet'
                    }
                    Icon={Clock}
                />
            </div>

            {loading ? (
                <PageLoader message="Loading assigned requests..." />
            ) : visibleRows.length === 0 ? (
                <Card className="p-8 text-center text-muted-foreground">
                    <Briefcase className="mx-auto mb-3 h-10 w-10 opacity-30" />
                    <p className="font-medium">No assigned interview requests yet.</p>
                    <p className="text-xs mt-1">
                        When an admin assigns a milestone to you, it will appear here.
                    </p>
                </Card>
            ) : (
                <div className="space-y-3">
                    {visibleRows.map((row) => {
                        const milestones = milestonesByApp[row.application_id] || [];
                        const isLoadingMs = !!loadingMilestones[row.application_id];
                        const lastAdded = milestones.length
                            ? milestones[milestones.length - 1]
                            : null;
                        const firstPending = milestones.find((m) => !m.completed_at);
                        const canAddNew = !firstPending;
                        const isOpen = openRow === row.application_id;
                        return (
                            <Card key={row.application_id} className="p-4 space-y-3">
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="font-semibold text-base truncate">
                                                {row.company_name || `Application #${row.application_id}`}
                                            </h3>
                                            <StatusBadge status={badgeFor(row)} />
                                            {row.application_success_flag ? <Badge variant="success">Success</Badge> : null}
                                            {row.application_failed_flag ? <Badge variant="destructive">Failed</Badge> : null}
                                            {row.application_cancelled_flag ? <Badge variant="warning">Job cancelled</Badge> : null}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            {row.job_role || 'Role unspecified'}
                                            {' · '}
                                            {row.profile_name || 'Profile'}
                                            {' · '}
                                            <UserIcon className="inline h-3 w-3" />
                                            {' '}
                                            {row.assigned_users || 'Unassigned profile users'}
                                        </p>
                                        {row.assigned_at && (
                                            <p className="text-[10px] text-muted-foreground mt-1">
                                                Assigned to you on {formatDateTime(row.assigned_at)}
                                                {row.assigned_by_username ? ` by ${row.assigned_by_username}` : ''}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {row.application_resume_filename && (
                                            <Button variant="outline" size="sm" onClick={() => handleDownloadResume(row)}>
                                                <Download className="h-4 w-4" />
                                                Resume
                                            </Button>
                                        )}
                                        {row.job_description && (
                                            <Button variant="outline" size="sm" onClick={() => handleDownloadJD(row)}>
                                                <FileText className="h-4 w-4" />
                                                JD
                                            </Button>
                                        )}
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => handleToggleRow(row.application_id)}
                                        >
                                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                            {isOpen ? 'Hide details' : 'Show details'}
                                        </Button>
                                    </div>
                                </div>

                                {lastAdded && (
                                    <div className="rounded-xl border border-white/[0.07] bg-black/20 p-2 text-xs">
                                        <span className="font-medium text-muted-foreground">Latest milestone:</span>{' '}
                                        <span className="font-medium">{milestoneLabel(lastAdded.kind)}</span>
                                        {lastAdded.label ? <span className="text-muted-foreground"> — {lastAdded.label}</span> : null}
                                        {lastAdded.scheduled_at && (
                                            <span className="text-muted-foreground"> · {formatDateTime(lastAdded.scheduled_at)}</span>
                                        )}
                                    </div>
                                )}

                                {isOpen && (
                                    <div className="space-y-3">
                                        {isLoadingMs ? (
                                            <p className="text-xs text-muted-foreground">Loading milestones…</p>
                                        ) : milestones.length === 0 ? (
                                            <p className="text-xs italic text-muted-foreground">
                                                No milestones have been added yet.
                                            </p>
                                        ) : (
                                            <>
                                                <MilestoneAccordion
                                                    milestones={milestones}
                                                    onComplete={handleComplete}
                                                    canComplete={(m) => DEVELOPER_COMPLETABLE_KINDS.has(m.kind)}
                                                    busy={formBusy}
                                                />
                                                {firstPending && (
                                                    <div className="rounded-xl border border-dashed border-white/10 p-2 text-xs text-muted-foreground">
                                                        Complete the current milestone first to unlock the
                                                        add-milestone form below.
                                                    </div>
                                                )}
                                                {!firstPending && (
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleAdd(lastAdded)}
                                                    >
                                                        <Plus className="h-4 w-4" />
                                                        Add next milestone
                                                    </Button>
                                                )}
                                            </>
                                        )}

                                        {/* Inline complete-form: requires actual interview
                                            time + outcome memo BEFORE marking complete. The
                                            server stores the picked time as completed_at and
                                            overwrites the memo if supplied. */}
                                        {activeFormRowId === row.application_id && activeFormMilestone && (
                                            <CompleteForm
                                                milestone={activeFormMilestone}
                                                draft={completeDraft}
                                                setDraft={setCompleteDraft}
                                                onSubmit={submitComplete}
                                                onCancel={() => { setActiveFormMilestone(null); setActiveFormRowId(null); setFormError(null); }}
                                                busy={formBusy}
                                                error={formError}
                                            />
                                        )}

                                        {/* Inline add-milestone form: developer can add the
                                            next step once the current one is complete. */}
                                        {activeFormRowId === row.application_id && !activeFormMilestone && (
                                            <AddForm
                                                draft={addDraft}
                                                setDraft={setAddDraft}
                                                onSubmit={submitAdd}
                                                onCancel={() => { setActiveFormMilestone(null); setActiveFormRowId(null); setFormError(null); }}
                                                busy={formBusy}
                                                error={formError}
                                            />
                                        )}
                                    </div>
                                )}
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
        </AppPage>
    );
}

// =============================================================================
// Inline forms
// =============================================================================

// "Mark complete" form — requires the developer to enter the actual
// interview time + an outcome memo before flipping the flag. The
// server stores the picked time as `completed_at` and overwrites the
// memo if supplied, so this is the developer's "what happened"
// record-keeping step.
function CompleteForm({ milestone, draft, setDraft, onSubmit, onCancel, busy, error }) {
    const allowed = DEVELOPER_COMPLETABLE_KINDS.has(milestone.kind);
    return (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-emerald-300" />
                    <span className="font-medium">
                        Complete "{milestoneLabel(milestone.kind)}"
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-full p-1 text-muted-foreground hover:bg-foreground/10"
                    title="Cancel"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            {!allowed && (
                <p className="text-rose-300">
                    "{milestoneLabel(milestone.kind)}" can only be completed by an admin.
                </p>
            )}
            {error && (
                <p className="text-rose-300">{error}</p>
            )}
            <div className="grid grid-cols-1 gap-2">
                <div className="space-y-1">
                    <Label htmlFor={`duration_${milestone.id}`}>
                        <Clock className="inline h-3 w-3 mr-1" />
                        Interview duration (minutes)
                        {requiresInterviewTime(milestone.kind) && ' *'}
                    </Label>
                    <Input
                        id={`duration_${milestone.id}`}
                        type="number"
                        min="1"
                        max="1440"
                        step="5"
                        value={draft.duration_minutes}
                        onChange={(e) => setDraft({ ...draft, duration_minutes: e.target.value })}
                        placeholder="e.g. 30, 45, 60"
                    />
                    <p className="text-[10px] text-muted-foreground">
                        Unit is minutes (e.g. 30, 45, 60). Capped at 1440 (24h).
                    </p>
                </div>
            </div>
            <div className="space-y-1">
                <Label htmlFor={`memo_${milestone.id}`}>
                    <FileText className="inline h-3 w-3 mr-1" />
                    Outcome memo
                </Label>
                <Textarea
                    id={`memo_${milestone.id}`}
                    rows={3}
                    value={draft.memo}
                    onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
                    placeholder="What happened? Outcome, followups, next steps…"
                />
            </div>
            <div className="flex items-center gap-2">
                <Button
                    size="default"
                    disabled={
                        busy
                        || !allowed
                        || (requiresInterviewTime(milestone.kind) && !String(draft.duration_minutes || '').trim())
                    }
                    onClick={onSubmit}
                    className="bg-emerald-600 text-white hover:bg-emerald-700"
                >
                    <Check className="h-4 w-4 mr-1.5" />
                    Mark complete
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

// "Add milestone" form — lets the developer add the next step once
// the previous one is complete. Restricted to the same kind list as
// the user-side MilestoneList picker; the kind itself doesn't gate
// the developer's add (only completion is gated).
function AddForm({ draft, setDraft, onSubmit, onCancel, busy, error }) {
    return (
        <div className="rounded-md border border-dashed border-border p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4" />
                    <span className="font-medium">Add next milestone</span>
                </div>
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-full p-1 text-muted-foreground hover:bg-foreground/10"
                    title="Cancel"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            {error && <p className="text-rose-300">{error}</p>}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px,1fr,180px]">
                <div className="space-y-1">
                    <Label>Type</Label>
                    <select
                        className="form-select"
                        value={draft.kind}
                        onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                    >
                        {DEVELOPER_PICKABLE_KINDS.map((k) => (
                            <option key={k} value={k}>{milestoneLabel(k)}</option>
                        ))}
                    </select>
                </div>
                <div className="space-y-1">
                    <Label>Label (optional)</Label>
                    <Input
                        value={draft.label}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                        placeholder="e.g. Hiring manager screen"
                    />
                </div>
                <div className="space-y-1">
                    <Label>Scheduled time</Label>
                    <DateTimePicker
                        value={draft.scheduled_at}
                        onChange={(e) => setDraft({ ...draft, scheduled_at: e.target.value })}
                        placeholder="Pick scheduled time"
                    />
                </div>
            </div>
            <div className="space-y-1">
                <Label>Memo (optional)</Label>
                <Textarea
                    rows={2}
                    value={draft.memo}
                    onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
                    placeholder="Context for the next step…"
                />
            </div>
            <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy} onClick={onSubmit}>
                    <Plus className="h-4 w-4" />
                    Add milestone
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
            </div>
        </div>
    );
}

function KpiTile({ label, value, Icon, accent, subtitle }) {
    const accentMap = {
        cyan:    'border-cyan-500/40 text-cyan-300',
        sky:     'border-sky-500/40 text-sky-300',
        amber:   'border-amber-500/40 text-amber-300',
        rose:    'border-rose-500/40 text-rose-300',
        emerald: 'border-emerald-500/40 text-emerald-300'
    };
    const cls = accent ? accentMap[accent] : 'border-white/[0.07]';
    return (
        <div className={cn('rounded-2xl border bg-[hsl(222_24%_9%/0.75)] p-3 shadow-[0_16px_48px_-28px_rgba(0,0,0,0.65)]', cls)}>
            <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
                {Icon && <Icon className="h-4 w-4 opacity-70" />}
            </div>
            <div className="mt-1 text-2xl font-semibold">{value}</div>
            {subtitle && (
                <div className="text-[10px] text-muted-foreground">{subtitle}</div>
            )}
        </div>
    );
}

export default DeveloperDashboard;
