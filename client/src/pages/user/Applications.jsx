import { useState, useEffect, useRef } from 'react';
import { FileDown, FileText, RefreshCw, Search } from 'lucide-react';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import FilterChip from '@/components/FilterChip';
import ApplicationRowCard from '@/components/applications/ApplicationRowCard';
import { userAPI } from '../../api';
import { useAuth } from '../../context/AuthContext';
import { PageLoader, Loader } from '@/components/Loader';
import { MilestoneList } from '@/components/MilestoneList';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/DatePicker';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogBody,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// ============== Debounce hook for filter inputs ==============
//
// The Applications page exposes four text/date inputs that drive a server
// request. To keep typing snappy and avoid hammering the backend with one
// request per keystroke, every input is mirrored through this hook:
//
//   const [value, setValue, debounced, flush] = useDebouncedValue('');
//
//   • `value`        – what's bound to <input value=… /> and onChange.
//   • `setValue`     – update the raw value.
//   • `debounced`    – the value that lags `value` by `delay` ms. Use this
//                      in useEffect deps and any server call so we only
//                      request when the user pauses.
//   • `flush(v)`     – synchronously force `debounced` to a specific value
//                      (used by "Clear filters" so the change is instant).
const FILTER_DEBOUNCE_MS = 400;

function useDebouncedValue(initial = '', delay = FILTER_DEBOUNCE_MS) {
    const [value, setValue] = useState(initial);
    const [debounced, setDebounced] = useState(initial);
    const timer = useRef(null);

    useEffect(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setDebounced(value), delay);
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
    }, [value, delay]);

    const flush = (next) => {
        if (timer.current) clearTimeout(timer.current);
        setValue(next);
        setDebounced(next);
    };

    return [value, setValue, debounced, flush];
}

// ============== Interview Request helpers ==============

// Convert an ISO-8601 UTC string (e.g. "2026-07-05T13:42:00.000Z") into the
// "YYYY-MM-DDTHH:mm" format expected by <DateTimePicker>.
// Returns '' for empty/invalid input so the picker stays empty rather than
// showing "Invalid Date".
function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
}

// Exported so the user-side InterviewRequests page (sibling) can reuse it
// for the request/expiry datetime inputs in its dialog. The build emits a
// "does not provide an export" warning if we forget this — so keep it.
export { toLocalInputValue };

// Inverse of toLocalInputValue — turn "YYYY-MM-DDTHH:mm" (local wall-clock
// time as the user typed it) back into a full ISO-8601 UTC string for the
// server. Returns '' for empty input so the backend can fall back to its
// own default behaviour.
function toIsoFromLocalInput(local) {
    if (!local) return '';
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
}

// Module-level download helpers — used by both the Applications page
// (per-row button + modal) and the InterviewRequestModal.
function downloadResumeFile(filename) {
    if (!filename) return;
    window.open(`/resumes/${encodeURIComponent(filename)}`, '_blank');
}

function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'jd';
}

function downloadJobDescriptionBlob({ company, role, body }) {
    if (!body) return;
    const fname = `jd_${slugify(company)}_${slugify(role)}.txt`;
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Local helper: render an interview-request modal inside the user-side page.
// Minimal interview-request modal: the user only needs to file the
// recruiter's reply text here. All progress, scheduling, and detail
// lives in the milestone stepper below — adding a milestone of kind
// "phone_call_schedule" / "videocall_schedule" / "technical_interview"
// / etc. carries the interview link + recruiter message + scheduled
// time on the milestone row itself, so the legacy "Interview detail"
// grid (type, timezone, date, time, interviewer, location, meeting
// link, user notes) is gone. The request timeline (requested/expire
// times) is also gone — the milestone list shows the cadence at a
// glance.
function InterviewRequestModal({ app, existing, open, onOpenChange, onSaved }) {
    const [recruiterReply, setRecruiterReply] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    // Hydrate when the modal opens.
    useEffect(() => {
        if (!open) return;
        setRecruiterReply(existing?.recruiter_reply || '');
        setError(null);
    }, [open, existing]);

    const submit = async () => {
        setError(null);
        setSaving(true);
        try {
            await userAPI.upsertInterviewRequest({
                application_id: app.id,
                recruiter_reply: recruiterReply
            });
            onSaved?.();
            onOpenChange(false);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save interview-request');
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                            <DialogTitle>
                                {existing
                                    ? `Interview Request — ${app.company_name}`
                                    : `Capture interview for ${app.company_name}`}
                            </DialogTitle>
                            <DialogDescription>
                                Paste the recruiter's reply and add a milestone for each
                                step. The latest milestone kind drives the application's
                                current status in the table.
                            </DialogDescription>
                        </div>
                        {/* Header download cluster — same pattern as the
                            admin modal. Resume opens /resumes/<file>;
                            JD generates a `.txt` blob via downloadJobDescriptionBlob. */}
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                type="button"
                                onClick={() => downloadResumeFile(app.resume_filename)}
                                disabled={!app.resume_filename}
                                title={
                                    app.resume_filename
                                        ? `Download resume (${app.resume_filename})`
                                        : 'No resume uploaded yet for this application'
                                }
                            >
                                <FileDown className="h-3.5 w-3.5" />
                                Download resume
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                type="button"
                                onClick={() => downloadJobDescriptionBlob({
                                    company: app.company_name,
                                    role: app.job_role,
                                    body: app.job_description
                                })}
                                disabled={!app.job_description}
                                title={
                                    app.job_description
                                        ? `Download job description for ${app.company_name}`
                                        : 'No job description recorded'
                                }
                            >
                                <FileDown className="h-3.5 w-3.5" />
                                Download job description
                            </Button>
                        </div>
                    </div>
                </DialogHeader>

                <DialogBody className="space-y-4">
                    {/* Recruiter reply — the only field captured here. The
                        server runs syncReplyMilestone on save, which seeds
                        the head milestone; every subsequent step (interview
                        type, schedule, links, prep notes) is added through
                        the milestone stepper below. */}
                    <div className="space-y-1.5">
                        <Label htmlFor="ir-reply">
                            Recruiter's reply
                            <span className="ml-2 text-xs text-muted-foreground">
                                (paste their message — email, Slack, LinkedIn, etc.)
                            </span>
                        </Label>
                        <Textarea
                            id="ir-reply"
                            rows={5}
                            value={recruiterReply}
                            onChange={(e) => setRecruiterReply(e.target.value)}
                            placeholder="Paste the recruiter's reply text here…"
                        />
                        <p className="text-[11px] text-muted-foreground">
                            Every other field (interview type, scheduled time, meeting link,
                            interviewer, prep notes) is recorded as a milestone below — add a
                            step with the matching kind to schedule an interview.
                        </p>
                    </div>

                    {error && (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {error}
                        </div>
                    )}

                    {/* Milestones — the source of truth for progress and
                        interview scheduling. The stepper drives the
                        Applications table's "current status" pill; adding
                        a new milestone auto-completes the previous one
                        and the bar advances. Once admin moves the row to
                        completed/cancelled the list is locked as a final
                        trail. */}
                    <div className="rounded-md border border-border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                Milestones
                            </Label>
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Progress + interview schedule
                            </span>
                        </div>
                        <MilestoneList
                            applicationId={app.id}
                            finalState={existing?.status || 'in_progress'}
                        />
                    </div>
                </DialogBody>

                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
                        Close
                    </Button>
                    <Button onClick={submit} disabled={saving}>
                        {saving ? 'Saving…' : 'Save reply'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Applications({ embedded = false }) {
    const { user } = useAuth();
    const [profiles, setProfiles] = useState([]);
    const [applications, setApplications] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedProfile, setSelectedProfile] = useState('all');
    // Text + date filters are mirrored into a `debounced*` state so the
    // typing experience stays snappy without firing a server request per
    // keystroke. The effect below only depends on the debounced mirrors.
    const [selectedCompany, setSelectedCompany, debouncedCompany, flushCompany]   = useDebouncedValue('');
    const [selectedRole,    setSelectedRole,    debouncedRole,    flushRole]      = useDebouncedValue('');
    const [selectedContent, setSelectedContent, debouncedContent, flushContent] = useDebouncedValue('');
    const [selectedJd,      setSelectedJd,      debouncedJd,      flushJd]      = useDebouncedValue('');
    const [selectedUrl,     setSelectedUrl,     debouncedUrl,     flushUrl]     = useDebouncedValue('');
    const [selectedStatus, setSelectedStatus] = useState('all');
    const [startDate,       setStartDate,       debouncedStart,   flushStart]     = useDebouncedValue('');
    const [endDate,         setEndDate,         debouncedEnd,     flushEnd]       = useDebouncedValue('');
    const [viewingJobDescription, setViewingJobDescription] = useState(null);

    // Interview-request modal + per-row state
    const [interviewRequests, setInterviewRequests] = useState({}); // appId -> record or null
    const [openRequestFor, setOpenRequestFor] = useState(null); // app object | null

    // Bulk actions
    const [selectedApplications, setSelectedApplications] = useState([]);
    const [bulkAction, setBulkAction] = useState('');

    // Server-side pagination
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(20);
    const [totalApplications, setTotalApplications] = useState(0);
    const [totalPages, setTotalPages] = useState(1);
    // 'All profiles' view exposes the merged total + page count so the
    // paginator can show "N across P profiles" instead of a misleading
    // multiplied count.
    const [allProfilesTotal, setAllProfilesTotal] = useState(0);
    const [allProfilesPages, setAllProfilesPages] = useState(0);

    useEffect(() => {
        loadProfiles();
    }, []);

    // Reload applications whenever page, debounced filter, or selected profile change.
    // The raw text/date state is *not* in this dependency list, otherwise we'd
    // issue a request for every keystroke.
    useEffect(() => {
        loadApplications();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        currentPage,
        itemsPerPage,
        selectedProfile,
        debouncedCompany,
        debouncedRole,
        debouncedContent,
        debouncedJd,
        debouncedUrl,
        selectedStatus,
        debouncedStart,
        debouncedEnd,
        profiles.length
    ]);

    const loadProfiles = async () => {
        try {
            const profilesRes = await userAPI.getProfiles();
            const list = Array.isArray(profilesRes.data) ? profilesRes.data : [];
            setProfiles(list);
        } catch (error) {
            console.error('Failed to load profiles:', error);
        }
    };

    const loadInterviewRequests = async () => {
        try {
            const res = await userAPI.listInterviewRequests();
            const list = Array.isArray(res.data) ? res.data : [];
            const byApp = {};
            for (const r of list) byApp[r.application_id] = r;
            setInterviewRequests(byApp);
        } catch (err) {
            // Non-fatal — UI just won't show pills until the next reload
            console.error('Failed to load interview-requests:', err);
        }
    };

    const loadApplications = async () => {
        try {
            setLoading(true);
            // Build filter params for server-side filtering (when a single profile is selected).
            // The values we ship on the wire are the *debounced* ones so a
            // half-typed query never leaks out.
            const filterParams = {
                page: currentPage,
                limit: itemsPerPage,
                company: debouncedCompany || undefined,
                role: debouncedRole || undefined,
                content: debouncedContent || undefined,
                jd: debouncedJd || undefined,
                url: debouncedUrl || undefined,
                status: selectedStatus !== 'all' ? selectedStatus : undefined,
                start_date: debouncedStart || undefined,
                end_date: debouncedEnd || undefined
            };

            let allApps = [];
            let total = 0;

            if (selectedProfile === 'all') {
                // "All profiles" mode — fetch every profile's first page
                // (page=1) so the user sees exactly `itemsPerPage` rows.
                // The server-side pagination we re-use here is the same
                // per-profile `LIMIT/OFFSET`; we explicitly set page=1
                // and cap the per-profile fetch at itemsPerPage so the
                // merged table never exceeds the user's chosen page size.
                const allFilterParams = { ...filterParams, page: 1, limit: itemsPerPage };
                const results = await Promise.all(
                    profiles.map(p =>
                        userAPI.getApplications(p.id, allFilterParams)
                            .then(r => ({ profile: p, data: r.data }))
                            .catch(() => ({ profile: p, data: { applications: [], pagination: { total: 0 } } }))
                    )
                );
                for (const { profile, data } of results) {
                    const apps = (data.applications || []).map(app => ({
                        ...app,
                        profile_name: `${profile.first_name} ${profile.last_name}`
                    }));
                    allApps.push(...apps);
                    total += data.pagination?.total || 0;
                }
                // Sort merged page by created_at desc
                allApps.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
                // Trim to exactly itemsPerPage so the row count matches the
                // user's selected page size across all profiles combined.
                // (The per-profile fetch may over-fetch when total > limit
                // and the server returns the page as-is; we cap here.)
                if (allApps.length > itemsPerPage) {
                    allApps = allApps.slice(0, itemsPerPage);
                }
                // For "all profiles" the conventional totalPages is the
                // count of distinct profiles that have at least one
                // application, so the paginator feels like profile-level
                // navigation rather than a flat N×limit count.
                const profilesWithApps = results.filter((r) => (r.data.pagination?.total || 0) > 0).length;
                total = allApps.length;
                // We expose a "see total" count separately so the UI can
                // show "Showing N of M applications across P profiles".
                setAllProfilesTotal(results.reduce((acc, r) => acc + (r.data.pagination?.total || 0), 0));
                setAllProfilesPages(profilesWithApps);
                // Page-count for the merged table: 1 in 'all' mode (we
                // already trimmed to itemsPerPage). If we ever support
                // paginating across merged profiles, this would grow.
                setTotalPages(1);
                setApplications(allApps);
                setTotalApplications(total);
                // Drop any selected IDs that no longer exist on this page
                setSelectedApplications(prev => prev.filter(id => allApps.some(app => app.id === id)));
                loadInterviewRequests();
                return; // skip the single-profile branch below
            }

            // Single-profile fetch (server does the filtering + pagination)
            const res = await userAPI.getApplications(parseInt(selectedProfile), filterParams);
            const profileObj = profiles.find(p => p.id === parseInt(selectedProfile));
            allApps = (res.data.applications || []).map(app => ({
                ...app,
                profile_name: profileObj ? `${profileObj.first_name} ${profileObj.last_name}` : ''
            }));
            total = res.data.pagination?.total || 0;

            setApplications(allApps);
            setTotalApplications(total);
            setTotalPages(Math.max(1, Math.ceil(total / itemsPerPage)));

            // Drop any selected IDs that no longer exist on this page
            setSelectedApplications(prev => prev.filter(id => allApps.some(app => app.id === id)));

            // Pull interview-requests fresh in parallel
            loadInterviewRequests();
        } catch (error) {
            console.error('Failed to load applications:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleStatusChange = async (appId, newStatus) => {
        try {
            await userAPI.updateApplicationStatus(appId, newStatus);
            // Reload data
            loadApplications();
        } catch (error) {
            console.error('Failed to update status:', error);
        }
    };

    // Bulk action handlers
    const handleBulkAction = async () => {
        if (!bulkAction || selectedApplications.length === 0) {
            alert('Please select an action and at least one application');
            return;
        }

        // Filter out any selected IDs that don't exist in current applications
        const validSelectedIds = selectedApplications.filter(id =>
            applications.some(app => app.id === id)
        );

        if (validSelectedIds.length === 0) {
            alert('No valid applications selected. Please refresh the page.');
            setSelectedApplications([]);
            return;
        }

        if (validSelectedIds.length < selectedApplications.length) {
            const diff = selectedApplications.length - validSelectedIds.length;
            if (!confirm(`${diff} selected application(s) no longer exist. Continue with ${validSelectedIds.length} application(s)?`)) {
                setSelectedApplications(validSelectedIds);
                return;
            }
        }

        if (['pending', 'applied'].includes(bulkAction)) {
            try {
                let successCount = 0;
                let errorCount = 0;

                for (const appId of validSelectedIds) {
                    try {
                        await userAPI.updateApplicationStatus(appId, bulkAction);
                        successCount++;
                    } catch (error) {
                        console.error(`Failed to update application ${appId}:`, error);
                        errorCount++;
                    }
                }

                await loadApplications();
                setSelectedApplications([]);
                setBulkAction('');

                if (errorCount > 0) {
                    alert(`Updated ${successCount} application(s). ${errorCount} failed.`);
                }
            } catch (error) {
                console.error('Failed to update applications:', error);
                alert('Failed to update applications. Please try again.');
            }
        }
    };

    // Resume + JD downloads. Defined at module scope (below) so the
    // InterviewRequestModal can reuse them.
    const downloadResume = downloadResumeFile;

    // Only show pending and applied for user side
    const uniqueStatuses = ['pending', 'applied'];

    // Filter to only show applications where current user is assigned (applied by self).
    // Other filters (company, role, status, date) are now applied server-side.
    const userApplications = applications.filter(app => {
        if (!app.assigned_users || !user?.username) return false;
        const assignedUsers = app.assigned_users.split(',').map(u => u.trim());
        return assignedUsers.includes(user.username);
    });

    // `applications` already represents the current page (server-paginated, server-filtered).
    const paginatedApplications = userApplications;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + paginatedApplications.length, totalApplications);

    const viewingJobIndex = viewingJobDescription
        ? paginatedApplications.findIndex((a) => a.id === viewingJobDescription.id)
        : -1;

    const navigateViewingJob = (delta) => {
        const nextIndex = viewingJobIndex + delta;
        if (nextIndex >= 0 && nextIndex < paginatedApplications.length) {
            setViewingJobDescription(paginatedApplications[nextIndex]);
        }
    };

    // Lifecycle for the interview request is now driven by milestones:
    // adding a new milestone (e.g. "Hire/offer" → completed, or letting
    // the user mark the request cancelled via admin) is the only way to
    // change status. The user UI no longer exposes in-row quick
    // transitions — they would bypass the milestone trail.

    if (loading && applications.length === 0) {
        return <PageLoader message="Loading applications..." />;
    }

    const hasActiveFilters = selectedProfile !== 'all'
        || selectedCompany || selectedRole || selectedContent || selectedJd || selectedUrl
        || selectedStatus !== 'all' || startDate || endDate;

    const clearAllFilters = () => {
        setSelectedProfile('all');
        flushCompany('');
        flushRole('');
        flushContent('');
        flushJd('');
        flushUrl('');
        setSelectedStatus('all');
        flushStart('');
        flushEnd('');
        setCurrentPage(1);
    };

    return (
        <AppPage
            embedded={embedded}
            icon={FileText}
            title="Job Applications"
            description="View applications, capture recruiter replies, and track each interview step through milestones."
            footer={totalPages > 1 ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                        Showing {totalApplications === 0 ? 0 : startIndex + 1} to {endIndex} of {totalApplications}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1}>First</Button>
                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(currentPage - 1)} disabled={currentPage === 1}>Previous</Button>
                        <span className="font-medium text-foreground">Page {currentPage} of {totalPages}</span>
                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(currentPage + 1)} disabled={currentPage === totalPages}>Next</Button>
                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages}>Last</Button>
                    </div>
                </div>
            ) : null}
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                            <Input
                                className="h-10 border-white/10 bg-black/25 pl-10"
                                placeholder="Search company, role, JD, link…"
                                value={selectedContent}
                                onChange={(e) => {
                                    setSelectedContent(e.target.value);
                                    setCurrentPage(1);
                                }}
                            />
                            {selectedContent !== debouncedContent && (
                                <span className="absolute right-3 top-1/2 -translate-y-1/2">
                                    <Loader size="sm" />
                                </span>
                            )}
                        </div>
                    )}
                    actions={(
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-10"
                            onClick={() => {
                                setSelectedApplications([]);
                                loadApplications();
                            }}
                            disabled={loading}
                        >
                            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                    filters={(
                        <>
                            <Select
                                value={selectedProfile}
                                onValueChange={(v) => {
                                    setSelectedProfile(v);
                                    setCurrentPage(1);
                                }}
                            >
                                <SelectTrigger className="h-9 w-[11rem] border-white/10 bg-black/20">
                                    <SelectValue placeholder="Profile" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All profiles</SelectItem>
                                    {profiles.map((profile) => (
                                        <SelectItem key={profile.id} value={String(profile.id)}>
                                            {profile.first_name} {profile.last_name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select
                                value={selectedStatus}
                                onValueChange={(v) => {
                                    setSelectedStatus(v);
                                    setCurrentPage(1);
                                }}
                            >
                                <SelectTrigger className="h-9 w-[8.5rem] border-white/10 bg-black/20">
                                    <SelectValue placeholder="Status" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All status</SelectItem>
                                    {uniqueStatuses.map((status) => (
                                        <SelectItem key={status} value={status}>
                                            {status.charAt(0).toUpperCase() + status.slice(1)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <div className="relative w-[9rem]">
                                <Input
                                    className="h-9 border-white/10 bg-black/20"
                                    placeholder="Company"
                                    value={selectedCompany}
                                    onChange={(e) => {
                                        setSelectedCompany(e.target.value);
                                        setCurrentPage(1);
                                    }}
                                />
                                {selectedCompany !== debouncedCompany && (
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                        <Loader size="sm" />
                                    </span>
                                )}
                            </div>
                            <div className="relative w-[9rem]">
                                <Input
                                    className="h-9 border-white/10 bg-black/20"
                                    placeholder="Role"
                                    value={selectedRole}
                                    onChange={(e) => {
                                        setSelectedRole(e.target.value);
                                        setCurrentPage(1);
                                    }}
                                />
                                {selectedRole !== debouncedRole && (
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                        <Loader size="sm" />
                                    </span>
                                )}
                            </div>
                            <div className="relative min-w-[10rem] flex-1 sm:max-w-[14rem]">
                                <Input
                                    className="h-9 border-white/10 bg-black/20"
                                    placeholder="JD search…"
                                    value={selectedJd}
                                    onChange={(e) => {
                                        setSelectedJd(e.target.value);
                                        setCurrentPage(1);
                                    }}
                                />
                                {selectedJd !== debouncedJd && (
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                        <Loader size="sm" />
                                    </span>
                                )}
                            </div>
                            <div className="relative min-w-[10rem] flex-1 sm:max-w-[14rem]">
                                <Input
                                    className="h-9 border-white/10 bg-black/20"
                                    placeholder="Link / URL…"
                                    value={selectedUrl}
                                    onChange={(e) => {
                                        setSelectedUrl(e.target.value);
                                        setCurrentPage(1);
                                    }}
                                />
                                {selectedUrl !== debouncedUrl && (
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                        <Loader size="sm" />
                                    </span>
                                )}
                            </div>
                            <div className="w-[9rem]">
                                <DatePicker
                                    value={startDate}
                                    onChange={(e) => {
                                        setStartDate(e.target.value);
                                        setCurrentPage(1);
                                    }}
                                    placeholder="From"
                                />
                            </div>
                            <div className="w-[9rem]">
                                <DatePicker
                                    value={endDate}
                                    onChange={(e) => {
                                        setEndDate(e.target.value);
                                        setCurrentPage(1);
                                    }}
                                    placeholder="To"
                                />
                            </div>
                            <Select
                                value={String(itemsPerPage)}
                                onValueChange={(v) => {
                                    setItemsPerPage(Number(v));
                                    setCurrentPage(1);
                                }}
                            >
                                <SelectTrigger className="h-9 w-[7.5rem] border-white/10 bg-black/20">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="10">10 / page</SelectItem>
                                    <SelectItem value="20">20 / page</SelectItem>
                                    <SelectItem value="25">25 / page</SelectItem>
                                    <SelectItem value="50">50 / page</SelectItem>
                                    <SelectItem value="100">100 / page</SelectItem>
                                </SelectContent>
                            </Select>
                        </>
                    )}
                    chips={hasActiveFilters ? (
                        <>
                            {selectedProfile !== 'all' && (() => {
                                const p = profiles.find((pr) => String(pr.id) === String(selectedProfile));
                                const label = p ? `${p.first_name} ${p.last_name}` : selectedProfile;
                                return (
                                    <FilterChip
                                        label={`Profile: ${label}`}
                                        onClear={() => { setSelectedProfile('all'); setCurrentPage(1); }}
                                    />
                                );
                            })()}
                            {selectedStatus !== 'all' && (
                                <FilterChip label={`Status: ${selectedStatus}`} onClear={() => { setSelectedStatus('all'); setCurrentPage(1); }} />
                            )}
                            {selectedCompany && (
                                <FilterChip label={`Company: ${selectedCompany}`} onClear={() => { flushCompany(''); setCurrentPage(1); }} />
                            )}
                            {selectedRole && (
                                <FilterChip label={`Role: ${selectedRole}`} onClear={() => { flushRole(''); setCurrentPage(1); }} />
                            )}
                            {selectedContent && (
                                <FilterChip label={`Search: ${selectedContent}`} onClear={() => { flushContent(''); setCurrentPage(1); }} />
                            )}
                            {selectedJd && (
                                <FilterChip label={`JD: ${selectedJd}`} onClear={() => { flushJd(''); setCurrentPage(1); }} />
                            )}
                            {selectedUrl && (
                                <FilterChip label={`Link: ${selectedUrl}`} onClear={() => { flushUrl(''); setCurrentPage(1); }} />
                            )}
                            {startDate && (
                                <FilterChip label={`From: ${startDate}`} onClear={() => { flushStart(''); setCurrentPage(1); }} />
                            )}
                            {endDate && (
                                <FilterChip label={`To: ${endDate}`} onClear={() => { flushEnd(''); setCurrentPage(1); }} />
                            )}
                            <Button variant="ghost" size="sm" onClick={clearAllFilters}>Reset all</Button>
                        </>
                    ) : null}
                />

                <ListToolbar
                    leading={(
                        <Checkbox
                            checked={
                                paginatedApplications.length > 0 && selectedApplications.length === paginatedApplications.length
                                    ? true
                                    : selectedApplications.length > 0
                                        ? 'indeterminate'
                                        : false
                            }
                            onCheckedChange={(checked) => {
                                if (checked) {
                                    setSelectedApplications(paginatedApplications.map((app) => app.id));
                                } else {
                                    setSelectedApplications([]);
                                }
                            }}
                            aria-label="Select all applications"
                        />
                    )}
                    label={
                        selectedApplications.length > 0
                            ? `${selectedApplications.length} selected`
                            : selectedProfile === 'all'
                                ? `${totalApplications} of ${allProfilesTotal} across ${allProfilesPages} profile${allProfilesPages === 1 ? '' : 's'}`
                                : `${totalApplications} total`
                    }
                    trailing={selectedApplications.length > 0 ? (
                        <>
                            <Select value={bulkAction || undefined} onValueChange={setBulkAction}>
                                <SelectTrigger className="h-8 w-[10rem] border-white/10 bg-black/20 text-xs">
                                    <SelectValue placeholder="Bulk action" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="pending">Set to Pending</SelectItem>
                                    <SelectItem value="applied">Set to Applied</SelectItem>
                                </SelectContent>
                            </Select>
                            <Button size="sm" className="h-8" onClick={handleBulkAction} disabled={!bulkAction}>
                                Apply
                            </Button>
                            <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelectedApplications([])}>
                                Clear
                            </Button>
                        </>
                    ) : null}
                />

                <div className="relative space-y-1.5">
                    {loading && applications.length > 0 && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/50 backdrop-blur-sm">
                            <Loader size="lg" />
                        </div>
                    )}
                    {paginatedApplications.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                            <p className="font-medium text-white/55">No applications found</p>
                            <p className="mt-1">Start by generating a resume for a job</p>
                        </div>
                    ) : (
                        paginatedApplications.map((app) => (
                            <ApplicationRowCard
                                key={app.id}
                                app={app}
                                variant="user"
                                title={app.profile_name}
                                selected={selectedApplications.includes(app.id)}
                                onSelect={(checked) => {
                                    if (checked) {
                                        setSelectedApplications((prev) => prev.includes(app.id) ? prev : [...prev, app.id]);
                                    } else {
                                        setSelectedApplications((prev) => prev.filter((id) => id !== app.id));
                                    }
                                }}
                                onStatusChange={handleStatusChange}
                                onCaptureInterview={setOpenRequestFor}
                                interviewRequest={interviewRequests[app.id] || null}
                                onViewJobDescription={setViewingJobDescription}
                                onDownloadResume={downloadResume}
                            />
                        ))
                    )}
                </div>
            </div>

            {/* Job Description Modal */}
            {viewingJobDescription && (
                <div
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                        padding: '2rem'
                    }}
                    onClick={() => setViewingJobDescription(null)}
                >
                    <div
                        style={{
                            backgroundColor: 'var(--bg-primary)',
                            borderRadius: '8px',
                            maxWidth: '800px',
                            width: '100%',
                            maxHeight: '80vh',
                            overflow: 'auto',
                            padding: '2rem',
                            boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ marginBottom: '1.5rem', borderBottom: '2px solid var(--border-color)', paddingBottom: '1rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                                <h2 style={{ marginBottom: '0.5rem' }}>Job Description</h2>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button
                                        className="btn btn-sm btn-secondary"
                                        onClick={() => navigateViewingJob(-1)}
                                        disabled={viewingJobIndex <= 0}
                                    >
                                        ← Previous
                                    </button>
                                    <button
                                        className="btn btn-sm btn-secondary"
                                        onClick={() => navigateViewingJob(1)}
                                        disabled={viewingJobIndex < 0 || viewingJobIndex >= paginatedApplications.length - 1}
                                    >
                                        Next →
                                    </button>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                <div><strong>Company:</strong> {viewingJobDescription.company_name}</div>
                                <div><strong>Role:</strong> {viewingJobDescription.job_role || 'Not Specified'}</div>
                            </div>
                        </div>

                        <div style={{
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'inherit',
                            lineHeight: '1.6',
                            color: 'var(--text-primary)',
                            marginBottom: '1.5rem'
                        }}>
                            {viewingJobDescription.job_description}
                        </div>

                        {viewingJobDescription.core_skills && (
                            <div style={{
                                marginBottom: '1.5rem',
                                padding: '1rem',
                                backgroundColor: 'var(--bg-secondary)',
                                borderRadius: '4px'
                            }}>
                                <strong style={{ display: 'block', marginBottom: '0.5rem' }}>Extracted Core Skills:</strong>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                                    {viewingJobDescription.core_skills}
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                            <button
                                className="btn btn-secondary"
                                onClick={() => downloadResume(viewingJobDescription.resume_filename)}
                            >
                                📥 Download Resume
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={() => setViewingJobDescription(null)}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Interview Request Modal */}
            {openRequestFor && (
                <InterviewRequestModal
                    app={openRequestFor}
                    existing={interviewRequests[openRequestFor.id] || null}
                    open={true}
                    onOpenChange={(o) => !o && setOpenRequestFor(null)}
                    onSaved={async () => {
                        await loadInterviewRequests();
                        await loadApplications();
                    }}
                />
            )}
        </AppPage>
    );
}

export default Applications;

