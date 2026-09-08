import { useState, useEffect } from 'react';
import { FileText, RefreshCw, Search } from 'lucide-react';
import { adminAPI } from '../../api';
import { PageLoader, Loader } from '@/components/Loader';
import { DatePicker } from '@/components/DatePicker';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import FilterChip from '@/components/FilterChip';
import ApplicationRowCard from '@/components/applications/ApplicationRowCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

// Debounce delay (ms) applied to the *text* and date inputs. Each keystroke
// within this window is coalesced into a single API call so we never
// issue a request per character typed.
const FILTER_DEBOUNCE_MS = 400;

/**
 * Tie a piece of controlled input state to a debounced mirror. Useful for
 * filter inputs where we want the UI to feel snappy but only the
 * settled value should drive the next network call.
 *
 * Returns `[value, setValue, debounced]` — call `setDebounced` whenever you
 * want to flush the pending timer immediately (e.g. when the user submits a
 * form, or "Reset filters" runs).
 */
function useDebouncedValue(initial, delay = FILTER_DEBOUNCE_MS) {
    const [value, setValue] = useState(initial);
    const [debounced, setDebounced] = useState(initial);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return [value, setValue, debounced, setDebounced];
}
const REQUEST_STATUS_META = {
    requested: { label: 'Requested', variant: 'muted' },
    scheduled: { label: 'Scheduled', variant: 'info' },
    completed: { label: 'Completed', variant: 'success' },
    cancelled: { label: 'Cancelled', variant: 'destructive' }
};

function RequestStatusPill({ status }) {
    if (!status) return <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>—</span>;
    const meta = REQUEST_STATUS_META[status] || { label: status, variant: 'muted' };
    return (
        <span
            className={`badge badge-${meta.variant}`}
            style={{ fontSize: '0.75rem', padding: '0.2rem 0.5rem' }}
            title={`User interview-request: ${meta.label}`}
        >
            {meta.label}
        </span>
    );
}

function Applications({ embedded = false }) {
    const [applications, setApplications] = useState([]);
    const [callers, setCallers] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tableLoading, setTableLoading] = useState(false);
    const [error, setError] = useState(null);

    // Pagination
    const [page, setPage] = useState(1);
    const [limit] = useState(20);
    const [total, setTotal] = useState(0);
    const totalPages = Math.ceil(total / limit);

    // Filters
    const [selectedStatus, setSelectedStatus] = useState('all');
    // The four text/date inputs are local for snappy typing; only the
    // `debounced*` mirror drives the actual API request.
    const [searchCompany,    setSearchCompany,    debouncedCompany,    flushCompany]    = useDebouncedValue('');
    const [searchRole,       setSearchRole,       debouncedRole,       flushRole]       = useDebouncedValue('');
    const [searchContent,    setSearchContent,    debouncedContent,    flushContent]    = useDebouncedValue('');
    const [searchJd,         setSearchJd,         debouncedJd,         flushJd]         = useDebouncedValue('');
    const [searchUrl,        setSearchUrl,        debouncedUrl,        flushUrl]        = useDebouncedValue('');
    const [dateFrom,         setDateFrom,         debouncedDateFrom,   flushDateFrom]   = useDebouncedValue('');
    const [dateTo,           setDateTo,           debouncedDateTo,     flushDateTo]     = useDebouncedValue('');
    const [selectedAppliedBy, setSelectedAppliedBy] = useState('all');
    // Combined flag — true while at least one of the debounced values
    // hasn't caught up to its raw state. The filter bar uses it to show
    // a tiny spinner so the user knows the table is about to refresh.
    const filtersPending =
        searchCompany !== debouncedCompany ||
        searchRole !== debouncedRole ||
        searchContent !== debouncedContent ||
        searchJd !== debouncedJd ||
        searchUrl !== debouncedUrl ||
        dateFrom !== debouncedDateFrom ||
        dateTo !== debouncedDateTo;
    
    // Modals
    const [viewingApp, setViewingApp] = useState(null);
    const [previewingResume, setPreviewingResume] = useState(null);
    const [editingInterview, setEditingInterview] = useState(null);
    const [assigningCaller, setAssigningCaller] = useState(null);
    
    // Interview form
    const [interviewForm, setInterviewForm] = useState({
        scheduled_date: '',
        scheduled_time: '',
        timezone: '',
        interview_type: '',
        interviewer_name: '',
        location: '',
        meeting_link: '',
        notes: '',
        status: 'scheduled'
    });

    useEffect(() => {
        loadData(true);
    }, []);

    // Only the debounced mirrors drive the actual fetch, so each keystroke
    // inside a text/date field coalesces into a single request.
    useEffect(() => {
        loadData(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, selectedStatus, selectedAppliedBy, debouncedCompany, debouncedRole, debouncedContent, debouncedJd, debouncedUrl, debouncedDateFrom, debouncedDateTo]);

    // Whenever the debounced values settle to a state that matches the raw
    // inputs, we're guaranteed no in-flight filter typing — drop pending flag.
    // The `filtersPending` derived flag above already handles display.

    const loadData = async (isInitialLoad = false) => {
        try {
            if (isInitialLoad) {
                setLoading(true);
            } else {
                setTableLoading(true);
            }
            setError(null);

            const filters = {};
            if (selectedStatus !== 'all') filters.status = selectedStatus;
            // Use the *debounced* values for the wire request — the raw
            // `searchCompany` etc. are still bound to the <input>, but the
            // network side never sees a half-typed value.
            if (debouncedCompany) filters.company = debouncedCompany;
            if (debouncedRole)    filters.role    = debouncedRole;
            if (debouncedContent) filters.content = debouncedContent;
            if (debouncedJd)      filters.jd      = debouncedJd;
            if (debouncedUrl)     filters.url     = debouncedUrl;
            if (debouncedDateFrom) filters.date_from = debouncedDateFrom;
            if (debouncedDateTo)   filters.date_to   = debouncedDateTo;
            if (selectedAppliedBy !== 'all') filters.assigned_user = selectedAppliedBy;

            const [appsResponse, callersResponse, usersResponse] = await Promise.all([
                adminAPI.getApplications(page, limit, filters),
                adminAPI.getCallers(),
                adminAPI.getUsers()
            ]);
            const payload = appsResponse.data;
            setApplications(
                Array.isArray(payload.data)
                    ? payload.data
                    : Array.isArray(payload.applications)
                        ? payload.applications
                        : []
            );
            setTotal(payload.pagination?.total ?? payload.total ?? 0);
            if (isInitialLoad) {
                setCallers(Array.isArray(callersResponse.data) ? callersResponse.data : []);
                setUsers(Array.isArray(usersResponse.data) ? usersResponse.data : []);
            }
        } catch (err) {
            console.error('Failed to load data:', err);
            setError(err.response?.data?.error || 'Failed to load data');
            setApplications([]);
            setCallers([]);
            setUsers([]);
        } finally {
            setLoading(false);
            setTableLoading(false);
        }
    };

    const handleDownloadResume = async (filename) => {
        try {
            await adminAPI.downloadResume(filename);
        } catch (err) {
            alert('Failed to download resume: ' + (err.response?.data?.error || err.message));
        }
    };

    // Download the latest generated DOCX for an application. Falls
    // back to the standard /admin/resumes/<file> static path (used by
    // the "Resume" column) when the generated file lives under
    // resumes/ — the resume generator writes its DOCX to the same
    // directory, so we just open it directly. We don't re-route via
    // adminAPI because the file is already public via /resumes/.
    const handleDownloadGeneratedResume = (row) => {
        if (!row?.resume_filename) return;
        window.open(`/resumes/${row.resume_filename}`, '_blank');
    };

    const handleStatusChange = async (appId, newStatus) => {
        try {
            await adminAPI.updateApplicationStatus(appId, newStatus);
            loadData();
        } catch (error) {
            alert('Failed to update status: ' + (error.response?.data?.error || error.message));
        }
    };

    // Admin-only state transitions (in_progress | completed | cancelled
    // | rejected). This is the single source of truth for closing out an
    // application; users can never write this field.
    const handleStateChange = async (appId, newState, appRow) => {
        let rejectReason = null;
        if (newState === 'rejected') {
            const reason = window.prompt(
                `Optional: why is "${appRow?.company_name || 'this application'}" being rejected?`,
                appRow?.reject_reason || ''
            );
            // `null` = user pressed cancel; treat as "no change" so a
            // click-confirm never silently writes empty values.
            if (reason === null) return;
            rejectReason = reason.trim() || null;
        } else if (appRow?.state === 'rejected' && newState !== 'rejected') {
            // Confirm before clearing the existing reject_reason.
            if (!window.confirm(
                'This application has a saved reject reason. Re-opening as ' + newState + ' will clear it. Continue?'
            )) return;
        }
        try {
            await adminAPI.updateApplicationState(appId, newState, rejectReason);
            loadData();
        } catch (error) {
            alert('Failed to update state: ' + (error.response?.data?.error || error.message));
        }
    };

    const handleDeleteApp = async (appId) => {
        if (!confirm('Are you sure you want to delete this application?')) return;
        try {
            await adminAPI.deleteApplication(appId);
            loadData();
        } catch (error) {
            alert('Failed to delete: ' + (error.response?.data?.error || error.message));
        }
    };

    const openInterviewModal = (app) => {
        setEditingInterview(app);
        if (app.interview_id) {
            // Edit existing interview
            setInterviewForm({
                scheduled_date: app.scheduled_date || '',
                scheduled_time: app.scheduled_time || '',
                timezone: app.timezone || '',
                interview_type: app.interview_type || '',
                interviewer_name: app.interviewer_name || '',
                location: app.location || '',
                meeting_link: app.meeting_link || '',
                notes: app.interview_notes || '',
                status: app.interview_status || 'scheduled'
            });
        } else {
            // New interview
            setInterviewForm({
                scheduled_date: '',
                scheduled_time: '',
                timezone: '',
                interview_type: '',
                interviewer_name: '',
                location: '',
                meeting_link: '',
                notes: '',
                status: 'scheduled'
            });
        }
    };

    const handleSaveInterview = async () => {
        try {
            if (editingInterview.interview_id) {
                await adminAPI.updateInterview(editingInterview.interview_id, interviewForm);
            } else {
                await adminAPI.createInterview(editingInterview.id, interviewForm);
            }
            setEditingInterview(null);
            loadData();
        } catch (error) {
            alert('Failed to save interview: ' + (error.response?.data?.error || error.message));
        }
    };

    const handleDeleteInterview = async () => {
        if (!confirm('Delete this interview?')) return;
        try {
            await adminAPI.deleteInterview(editingInterview.interview_id);
            setEditingInterview(null);
            loadData();
        } catch (error) {
            alert('Failed to delete interview: ' + (error.response?.data?.error || error.message));
        }
    };

    const handleAssignCaller = async (callerId) => {
        try {
            // If already has a caller, unassign first before reassigning
            if (assigningCaller.caller_id) {
                await adminAPI.unassignCaller(assigningCaller.caller_id, assigningCaller.id);
            }
            await adminAPI.assignCaller(assigningCaller.id, callerId);
            setAssigningCaller(null);
            loadData();
        } catch (error) {
            alert('Failed to assign caller: ' + (error.response?.data?.error || error.message));
        }
    };

    const handleUnassignCallerFromModal = async () => {
        if (!assigningCaller.caller_id) return;
        if (!confirm('Unassign this caller from this application?')) return;
        try {
            await adminAPI.unassignCaller(assigningCaller.caller_id, assigningCaller.id);
            setAssigningCaller(null);
            loadData();
        } catch (error) {
            alert('Failed to unassign caller: ' + (error.response?.data?.error || error.message));
        }
    };

    const handleUnassignCaller = async (app, callerId) => {
        if (!confirm('Unassign this caller?')) return;
        try {
            await adminAPI.unassignCaller(callerId, app.id);
            loadData();
        } catch (error) {
            alert('Failed to unassign: ' + (error.response?.data?.error || error.message));
        }
    };

    // Get users for Applied By filter dropdown
    const uniqueAppliedByUsers = users.map(u => u.username).sort();

    const viewingAppIndex = viewingApp
        ? applications.findIndex((a) => a.id === viewingApp.id)
        : -1;

    const navigateViewingApp = (delta) => {
        const nextIndex = viewingAppIndex + delta;
        if (nextIndex >= 0 && nextIndex < applications.length) {
            setViewingApp(applications[nextIndex]);
        }
    };

    if (loading) return <PageLoader message="Loading applications..." />;
    if (error) return (
        <AppPage embedded={embedded} icon={FileText} title="Applications" description="Review and manage job applications">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <p>{error}</p>
                <Button className="mt-3" onClick={loadData}>Retry</Button>
            </div>
        </AppPage>
    );

    const clearAllFilters = () => {
        setSelectedStatus('all');
        setSelectedAppliedBy('all');
        setSearchCompany('');
        setSearchRole('');
        setSearchContent('');
        setSearchJd('');
        setSearchUrl('');
        setDateFrom('');
        setDateTo('');
        flushCompany('');
        flushRole('');
        flushContent('');
        flushJd('');
        flushUrl('');
        flushDateFrom('');
        flushDateTo('');
        setPage(1);
    };

    const hasActiveFilters = selectedStatus !== 'all' || selectedAppliedBy !== 'all'
        || searchCompany || searchRole || searchContent || searchJd || searchUrl || dateFrom || dateTo;

    return (
        <>
            <AppPage
                embedded={embedded}
                icon={FileText}
                title="Applications"
                description="Review applications, filter by company or role, and open details with prev/next navigation."
                footer={(
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>Showing <strong className="text-foreground">{applications.length}</strong> of <strong className="text-foreground">{total}</strong></span>
                        {totalPages > 1 && (
                            <div className="flex items-center gap-2">
                                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Previous</Button>
                                <span className="font-medium text-foreground">Page {page} of {totalPages}</span>
                                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</Button>
                            </div>
                        )}
                    </div>
                )}
            >
                <div className="space-y-4">
                    <PageCommandBar
                        search={(
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                                <Input
                                    className="h-10 border-white/10 bg-black/25 pl-10"
                                    placeholder="Search company, role, JD, link…"
                                    value={searchContent}
                                    onChange={(e) => setSearchContent(e.target.value)}
                                />
                                {searchContent !== debouncedContent && (
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2">
                                        <Loader size="sm" />
                                    </span>
                                )}
                            </div>
                        )}
                        actions={(
                            <Button variant="outline" size="sm" className="h-10" onClick={() => loadData(false)} disabled={tableLoading}>
                                <RefreshCw className={cn('h-4 w-4', tableLoading && 'animate-spin')} />
                                <span className="hidden sm:inline">Refresh</span>
                            </Button>
                        )}
                        filters={(
                            <>
                                <Select value={selectedStatus} onValueChange={setSelectedStatus}>
                                    <SelectTrigger className="h-9 w-[8.5rem] border-white/10 bg-black/20">
                                        <SelectValue placeholder="Status" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All status</SelectItem>
                                        <SelectItem value="pending">Pending</SelectItem>
                                        <SelectItem value="applied">Applied</SelectItem>
                                        <SelectItem value="interview">Interview</SelectItem>
                                        <SelectItem value="rejected">Rejected</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Select value={selectedAppliedBy} onValueChange={setSelectedAppliedBy}>
                                    <SelectTrigger className="h-9 w-[9rem] border-white/10 bg-black/20">
                                        <SelectValue placeholder="Applied by" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All users</SelectItem>
                                        {uniqueAppliedByUsers.map((user) => (
                                            <SelectItem key={user} value={user}>{user}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <div className="relative w-[9rem]">
                                    <Input
                                        className="h-9 border-white/10 bg-black/20"
                                        placeholder="Company"
                                        value={searchCompany}
                                        onChange={(e) => setSearchCompany(e.target.value)}
                                    />
                                    {searchCompany !== debouncedCompany && (
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                            <Loader size="sm" />
                                        </span>
                                    )}
                                </div>
                                <div className="relative w-[9rem]">
                                    <Input
                                        className="h-9 border-white/10 bg-black/20"
                                        placeholder="Role"
                                        value={searchRole}
                                        onChange={(e) => setSearchRole(e.target.value)}
                                    />
                                    {searchRole !== debouncedRole && (
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                            <Loader size="sm" />
                                        </span>
                                    )}
                                </div>
                                <div className="relative min-w-[10rem] flex-1 sm:max-w-[14rem]">
                                    <Input
                                        className="h-9 border-white/10 bg-black/20"
                                        placeholder="JD search…"
                                        value={searchJd}
                                        onChange={(e) => setSearchJd(e.target.value)}
                                    />
                                    {searchJd !== debouncedJd && (
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                            <Loader size="sm" />
                                        </span>
                                    )}
                                </div>
                                <div className="relative min-w-[10rem] flex-1 sm:max-w-[14rem]">
                                    <Input
                                        className="h-9 border-white/10 bg-black/20"
                                        placeholder="Link / URL…"
                                        value={searchUrl}
                                        onChange={(e) => setSearchUrl(e.target.value)}
                                    />
                                    {searchUrl !== debouncedUrl && (
                                        <span className="absolute right-2 top-1/2 -translate-y-1/2">
                                            <Loader size="sm" />
                                        </span>
                                    )}
                                </div>
                                <div className="w-[9rem]">
                                    <DatePicker value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From" />
                                </div>
                                <div className="w-[9rem]">
                                    <DatePicker value={dateTo} onChange={(e) => setDateTo(e.target.value)} placeholder="To" />
                                </div>
                            </>
                        )}
                        chips={hasActiveFilters ? (
                            <>
                                {selectedStatus !== 'all' && (
                                    <FilterChip label={`Status: ${selectedStatus}`} onClear={() => setSelectedStatus('all')} />
                                )}
                                {selectedAppliedBy !== 'all' && (
                                    <FilterChip label={`By: ${selectedAppliedBy}`} onClear={() => setSelectedAppliedBy('all')} />
                                )}
                                {searchCompany && (
                                    <FilterChip label={`Company: ${searchCompany}`} onClear={() => { setSearchCompany(''); flushCompany(''); }} />
                                )}
                                {searchRole && (
                                    <FilterChip label={`Role: ${searchRole}`} onClear={() => { setSearchRole(''); flushRole(''); }} />
                                )}
                                {searchContent && (
                                    <FilterChip label={`Search: ${searchContent}`} onClear={() => { setSearchContent(''); flushContent(''); }} />
                                )}
                                {searchJd && (
                                    <FilterChip label={`JD: ${searchJd}`} onClear={() => { setSearchJd(''); flushJd(''); }} />
                                )}
                                {searchUrl && (
                                    <FilterChip label={`Link: ${searchUrl}`} onClear={() => { setSearchUrl(''); flushUrl(''); }} />
                                )}
                                {dateFrom && (
                                    <FilterChip label={`From: ${dateFrom}`} onClear={() => { setDateFrom(''); flushDateFrom(''); }} />
                                )}
                                {dateTo && (
                                    <FilterChip label={`To: ${dateTo}`} onClear={() => { setDateTo(''); flushDateTo(''); }} />
                                )}
                                <Button variant="ghost" size="sm" onClick={clearAllFilters}>Reset all</Button>
                            </>
                        ) : null}
                    />

                    <ListToolbar
                        label={
                            filtersPending
                                ? 'Updating filters…'
                                : `${total} records · page ${page} of ${totalPages || 1}`
                        }
                    />

                    <div className="relative space-y-1.5">
                        {tableLoading && (
                            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-background/50 backdrop-blur-sm">
                                <Loader size="lg" />
                            </div>
                        )}
                        {applications.length === 0 && !tableLoading ? (
                            <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                                No applications found
                            </div>
                        ) : (
                            applications.map((app) => (
                                <ApplicationRowCard
                                    key={app.id}
                                    app={app}
                                    variant="admin"
                                    onView={() => setViewingApp(app)}
                                    onInterview={() => openInterviewModal(app)}
                                    onAssignCaller={() => setAssigningCaller(app)}
                                    onDelete={() => handleDeleteApp(app.id)}
                                    onStateChange={handleStateChange}
                                    onUnassignCaller={handleUnassignCaller}
                                    onDownloadResume={handleDownloadResume}
                                    onDownloadGeneratedResume={handleDownloadGeneratedResume}
                                    onPreviewResume={setPreviewingResume}
                                />
                            ))
                        )}
                    </div>
                </div>
            </AppPage>

            {/* View Details Modal */}
            {viewingApp && (
                <div className="modal-overlay" onClick={() => setViewingApp(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '800px' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">Application Details</h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <button
                                    className="btn btn-sm"
                                    onClick={() => navigateViewingApp(-1)}
                                    disabled={viewingAppIndex <= 0}
                                    title="Previous application"
                                >
                                    ← Previous
                                </button>
                                <button
                                    className="btn btn-sm"
                                    onClick={() => navigateViewingApp(1)}
                                    disabled={viewingAppIndex < 0 || viewingAppIndex >= applications.length - 1}
                                    title="Next application"
                                >
                                    Next →
                                </button>
                                <button className="modal-close" onClick={() => setViewingApp(null)}>✕</button>
                            </div>
                        </div>
                        <div className="modal-body">
                            <div style={{ display: 'grid', gap: '1rem' }}>
                                <div>
                                    <strong>Profile:</strong> {viewingApp.first_name} {viewingApp.last_name}
                                </div>
                                <div>
                                    <strong>Company:</strong> {viewingApp.company_name || 'N/A'}
                                </div>
                                <div>
                                    <strong>Role:</strong> {viewingApp.job_role || 'N/A'}
                                </div>
                                <div>
                                    <strong>Job link:</strong>{' '}
                                    {viewingApp.job_url ? (
                                        <a href={viewingApp.job_url} target="_blank" rel="noopener noreferrer">
                                            {viewingApp.job_url}
                                        </a>
                                    ) : (
                                        'N/A'
                                    )}
                                </div>
                                <div>
                                    <strong>Skills:</strong> {viewingApp.core_skills || 'N/A'}
                                </div>
                                <div>
                                    <strong>Status:</strong> <span className={`badge badge-${viewingApp.status}`}>{viewingApp.status}</span>
                                </div>
                                <div>
                                    <strong>Caller:</strong>{' '}
                                    {viewingApp.caller_username ? (
                                        <span className="badge badge-info">{viewingApp.caller_username}</span>
                                    ) : (
                                        <span style={{ color: 'var(--text-secondary)' }}>Unassigned</span>
                                    )}
                                    {' '}
                                    <button
                                        type="button"
                                        className="btn btn-sm"
                                        style={{ marginLeft: '0.5rem' }}
                                        onClick={() => {
                                            setAssigningCaller(viewingApp);
                                        }}
                                    >
                                        Assign
                                    </button>
                                </div>
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                                        <strong>Interview</strong>
                                        <button
                                            type="button"
                                            className="btn btn-sm"
                                            onClick={() => openInterviewModal(viewingApp)}
                                        >
                                            {viewingApp.interview_id || viewingApp.interview_request_id ? 'Edit interview' : 'Schedule interview'}
                                        </button>
                                    </div>
                                    {!viewingApp.interview_id && !viewingApp.interview_request_id && (
                                        <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: '4px', marginTop: '0.5rem', color: 'var(--text-secondary)' }}>
                                            Not scheduled
                                        </div>
                                    )}
                                    {viewingApp.interview_id && (
                                        <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: '4px', marginTop: '0.5rem' }}>
                                            <div style={{ marginBottom: '0.5rem', fontWeight: 600 }}>Admin / caller interview</div>
                                            {viewingApp.interview_status && (
                                                <div><strong>Status:</strong> <span className="badge badge-info">{viewingApp.interview_status}</span></div>
                                            )}
                                            <div><strong>Date:</strong> {viewingApp.scheduled_date || 'N/A'}</div>
                                            <div><strong>Time:</strong> {viewingApp.scheduled_time || 'N/A'} {viewingApp.timezone && `(${viewingApp.timezone})`}</div>
                                            <div><strong>Type:</strong> {viewingApp.interview_type || 'N/A'}</div>
                                            <div><strong>Interviewer:</strong> {viewingApp.interviewer_name || 'N/A'}</div>
                                            <div><strong>Location:</strong> {viewingApp.location || 'N/A'}</div>
                                            {viewingApp.meeting_link && (
                                                <div>
                                                    <strong>Link:</strong>{' '}
                                                    <a href={viewingApp.meeting_link} target="_blank" rel="noopener noreferrer">
                                                        {viewingApp.meeting_link}
                                                    </a>
                                                </div>
                                            )}
                                            {viewingApp.interview_notes && <div><strong>Notes:</strong> {viewingApp.interview_notes}</div>}
                                        </div>
                                    )}
                                    {viewingApp.interview_request_id && (
                                        <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: '4px', marginTop: '0.5rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                                                <span style={{ fontWeight: 600 }}>User interview request</span>
                                                <RequestStatusPill status={viewingApp.interview_request_status} />
                                            </div>
                                            {viewingApp.interview_request_reply ? (
                                                <div style={{ marginBottom: '0.5rem' }}>
                                                    <strong>Interview progress:</strong>
                                                    <div style={{ whiteSpace: 'pre-wrap', marginTop: '0.25rem', fontStyle: 'italic' }}>
                                                        {viewingApp.interview_request_reply}
                                                    </div>
                                                </div>
                                            ) : (
                                                <div style={{ marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>
                                                    No interview progress on file
                                                </div>
                                            )}
                                            <div><strong>Date:</strong> {viewingApp.request_scheduled_date || 'N/A'}</div>
                                            <div><strong>Time:</strong> {viewingApp.request_scheduled_time || 'N/A'} {viewingApp.request_timezone && `(${viewingApp.request_timezone})`}</div>
                                            <div><strong>Type:</strong> {viewingApp.request_interview_type || 'N/A'}</div>
                                            <div><strong>Interviewer:</strong> {viewingApp.request_interviewer_name || 'N/A'}</div>
                                            <div><strong>Location:</strong> {viewingApp.request_location || 'N/A'}</div>
                                            {viewingApp.request_meeting_link && (
                                                <div>
                                                    <strong>Link:</strong>{' '}
                                                    <a href={viewingApp.request_meeting_link} target="_blank" rel="noopener noreferrer">
                                                        {viewingApp.request_meeting_link}
                                                    </a>
                                                </div>
                                            )}
                                            {viewingApp.request_user_notes && <div><strong>Notes:</strong> {viewingApp.request_user_notes}</div>}
                                            {viewingApp.interview_request_updated_at && (
                                                <small style={{ color: 'var(--text-secondary)', display: 'block', marginTop: '0.5rem' }}>
                                                    Updated {new Date(viewingApp.interview_request_updated_at).toLocaleString()}
                                                </small>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <strong>Job Description:</strong>
                                    <div style={{ whiteSpace: 'pre-wrap', backgroundColor: 'var(--bg-secondary)', padding: '1rem', borderRadius: '4px', marginTop: '0.5rem', maxHeight: '220px', overflow: 'auto' }}>
                                        {viewingApp.job_description}
                                    </div>
                                </div>

                                {(viewingApp.draft_html || viewingApp.resume_filename) && (
                                    <div>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                                            <strong>Generated CV</strong>
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                {viewingApp.draft_html && (
                                                    <button type="button" className="btn btn-sm" onClick={() => setPreviewingResume(viewingApp)}>
                                                        Full preview
                                                    </button>
                                                )}
                                                {viewingApp.resume_filename && (
                                                    <button type="button" className="btn btn-sm btn-primary" onClick={() => handleDownloadResume(viewingApp.resume_filename)}>
                                                        Download DOCX
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        {viewingApp.draft_html ? (
                                            <div
                                                className="resume-preview"
                                                style={{
                                                    backgroundColor: '#fff',
                                                    color: '#111',
                                                    padding: '1rem',
                                                    borderRadius: '4px',
                                                    marginTop: '0.5rem',
                                                    maxHeight: '360px',
                                                    overflow: 'auto',
                                                    border: '1px solid var(--border)'
                                                }}
                                                dangerouslySetInnerHTML={{ __html: viewingApp.draft_html }}
                                            />
                                        ) : (
                                            <p className="text-muted" style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>
                                                HTML preview unavailable — download the DOCX file.
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* CV Preview Modal */}
            {previewingResume && (
                <div className="modal-overlay" onClick={() => setPreviewingResume(null)}>
                    <div
                        className="modal"
                        onClick={(e) => e.stopPropagation()}
                        style={{ maxWidth: '900px', width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
                    >
                        <div className="modal-header">
                            <h2 className="modal-title">
                                CV preview — {previewingResume.first_name} {previewingResume.last_name}
                                {previewingResume.company_name ? ` · ${previewingResume.company_name}` : ''}
                            </h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                {previewingResume.resume_filename && (
                                    <button
                                        type="button"
                                        className="btn btn-sm btn-primary"
                                        onClick={() => handleDownloadResume(previewingResume.resume_filename)}
                                    >
                                        Download DOCX
                                    </button>
                                )}
                                <button className="modal-close" onClick={() => setPreviewingResume(null)}>✕</button>
                            </div>
                        </div>
                        <div className="modal-body" style={{ overflow: 'auto', flex: 1 }}>
                            {previewingResume.draft_html ? (
                                <div
                                    className="resume-preview"
                                    style={{ background: '#fff', color: '#111', padding: '1.25rem', borderRadius: '6px' }}
                                    dangerouslySetInnerHTML={{ __html: previewingResume.draft_html }}
                                />
                            ) : (
                                <div className="empty-state">
                                    <h3>No HTML preview stored</h3>
                                    <p>
                                        {previewingResume.resume_filename
                                            ? 'Download the DOCX to open the resume.'
                                            : 'This application has no generated resume yet.'}
                                    </p>
                                    {previewingResume.resume_filename && (
                                        <button
                                            type="button"
                                            className="btn btn-primary"
                                            onClick={() => handleDownloadResume(previewingResume.resume_filename)}
                                        >
                                            Download DOCX
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Interview Modal */}
            {editingInterview && (
                <div className="modal-overlay" onClick={() => setEditingInterview(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">{editingInterview.interview_id ? 'Edit Interview' : 'Schedule Interview'}</h2>
                            <button className="modal-close" onClick={() => setEditingInterview(null)}>✕</button>
                        </div>
                        <div className="modal-body">
                            <div style={{ display: 'grid', gap: '1rem' }}>
                            <div>
                                <label className="form-label">Date</label>
                                <DatePicker
                                    className="form-input"
                                    value={interviewForm.scheduled_date}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, scheduled_date: e.target.value })}
                                    placeholder="Pick interview date"
                                />
                            </div>
                            <div>
                                <label className="form-label">Time</label>
                                <input
                                    type="time"
                                    className="form-input"
                                    value={interviewForm.scheduled_time}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, scheduled_time: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="form-label">Timezone</label>
                                <select
                                    className="form-select"
                                    value={interviewForm.timezone}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, timezone: e.target.value })}
                                >
                                    <option value="">Select timezone...</option>
                                    <option value="UTC">UTC</option>
                                    <option value="EST">EST (Eastern)</option>
                                    <option value="CST">CST (Central)</option>
                                    <option value="MST">MST (Mountain)</option>
                                    <option value="PST">PST (Pacific)</option>
                                    <option value="GMT">GMT</option>
                                    <option value="IST">IST (India)</option>
                                    <option value="JST">JST (Japan)</option>
                                    <option value="AEST">AEST (Australia)</option>
                                </select>
                            </div>
                            <div>
                                <label className="form-label">Type</label>
                                <select
                                    className="form-select"
                                    value={interviewForm.interview_type}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, interview_type: e.target.value })}
                                >
                                    <option value="">Select type...</option>
                                    <option value="Phone">Phone</option>
                                    <option value="Video">Video</option>
                                    <option value="In-person">In-person</option>
                                    <option value="Technical">Technical</option>
                                </select>
                            </div>
                            <div>
                                <label className="form-label">Interviewer Name</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    value={interviewForm.interviewer_name}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, interviewer_name: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="form-label">Location</label>
                                <input
                                    type="text"
                                    className="form-input"
                                    placeholder="Address or 'Remote'"
                                    value={interviewForm.location}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, location: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="form-label">Meeting Link</label>
                                <input
                                    type="url"
                                    className="form-input"
                                    placeholder="https://..."
                                    value={interviewForm.meeting_link}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, meeting_link: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="form-label">Notes</label>
                                <textarea
                                    className="form-input"
                                    rows="3"
                                    value={interviewForm.notes}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, notes: e.target.value })}
                                />
                            </div>
                            <div>
                                <label className="form-label">Status</label>
                                <select
                                    className="form-select"
                                    value={interviewForm.status}
                                    onChange={(e) => setInterviewForm({ ...interviewForm, status: e.target.value })}
                                >
                                    <option value="scheduled">Scheduled</option>
                                    <option value="completed">Completed</option>
                                    <option value="cancelled">Cancelled</option>
                                    <option value="rescheduled">Rescheduled</option>
                                </select>
                            </div>
                        </div>
                        </div>
                        <div className="modal-footer">
                            <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
                                <div>
                                    {editingInterview.interview_id && (
                                        <button className="btn btn-danger" onClick={handleDeleteInterview}>Delete Interview</button>
                                    )}
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button className="btn btn-secondary" onClick={() => setEditingInterview(null)}>Cancel</button>
                                    <button className="btn btn-primary" onClick={handleSaveInterview}>Save</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Assign Caller Modal */}
            {assigningCaller && (
                <div className="modal-overlay" onClick={() => setAssigningCaller(null)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '450px' }}>
                        <div className="modal-header">
                            <h2 className="modal-title">Assign Caller</h2>
                            <button className="modal-close" onClick={() => setAssigningCaller(null)}>✕</button>
                        </div>
                        <div className="modal-body">
                            <p>Application: <strong>{assigningCaller.company_name} - {assigningCaller.job_role}</strong></p>
                            
                            {/* Current Caller Status */}
                            <div style={{ backgroundColor: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '4px', marginTop: '0.5rem' }}>
                                <strong>Current Caller:</strong>
                                {assigningCaller.caller_username ? (
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                                        <span className="badge badge-info">{assigningCaller.caller_username}</span>
                                        <button 
                                            className="btn btn-danger btn-sm" 
                                            onClick={handleUnassignCallerFromModal}
                                        >
                                            Unassign
                                        </button>
                                    </div>
                                ) : (
                                    <span style={{ color: 'var(--text-secondary)' }}> No caller assigned</span>
                                )}
                            </div>

                            {/* Available Callers */}
                            <p style={{ marginTop: '1rem', fontWeight: 'bold' }}>Select a caller:</p>
                            <div style={{ display: 'grid', gap: '0.5rem', maxHeight: '300px', overflowY: 'auto' }}>
                                {callers.length === 0 ? (
                                    <p style={{ color: 'var(--text-secondary)' }}>No callers available</p>
                                ) : (
                                    callers.map(caller => (
                                        <button
                                            key={caller.id}
                                            className={`btn ${assigningCaller.caller_id === caller.id ? 'btn-primary' : ''}`}
                                            onClick={() => handleAssignCaller(caller.id)}
                                            style={{ justifyContent: 'flex-start' }}
                                        >
                                            {caller.username}
                                            {assigningCaller.caller_id === caller.id && ' (current)'}
                                        </button>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default Applications;

