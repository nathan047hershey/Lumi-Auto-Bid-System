import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    CalendarClock,
    Check,
    ChevronLeft,
    ChevronRight,
    Clock,
    FileDown,
    FileText,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    X
} from 'lucide-react';
import { adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import FilterChip from '@/components/FilterChip';
import { PageLoader, Loader } from '@/components/Loader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { DateTimePicker } from '@/components/DatePicker';
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

const STATUS_META = {
    requested: { label: 'Requested', variant: 'muted', accent: '#94a3b8' },
    scheduled: { label: 'Scheduled', variant: 'info', accent: '#0ea5e9' },
    completed: { label: 'Completed', variant: 'success', accent: '#10b981' },
    cancelled: { label: 'Cancelled', variant: 'destructive', accent: '#ef4444' },
    // Derived badges — driven by the latest milestone on the
    // interview_request rather than `ir.status`. The admin modal
    // gets the milestone list inline (see `request_milestones`), so
    // we can derive these client-side without an extra round-trip.
    //   expired  → latest milestone not completed, scheduled_at in the past
    //   pending  → latest milestone not completed
    //   completed→ latest milestone completed
    // The badge order in `badgeFor()` is expired > completed > pending
    // so the most actionable state wins.
    pending:   { label: 'Pending',  variant: 'warning', accent: '#f59e0b' },
    expired:   { label: 'Expired',  variant: 'destructive', accent: '#e11d48' }
};

const STATUS_TABS = [
    { value: 'all',        label: 'All' },
    { value: 'pending',    label: 'Pending' },
    { value: 'expired',    label: 'Expired' },
    { value: 'completed',  label: 'Completed' },
    { value: 'cancelled',  label: 'Cancelled' }
];

// Page size for the admin interview-requests table. 10 keeps the
// first paint fast (the server-side query has 4 correlated
// subqueries per row) without sacrificing the per-row visibility
// admins need when triaging a large pipeline. The server route
// mirrors this default so a stale build that doesn't ship the
// page-size constant still gets a sensible slice.
const ADMIN_INTERVIEW_PAGE_SIZE = 10;

// Resolve the latest milestone on a row. The server sends the full
// array as `request_milestones` (ordered by position ASC), so the
// last non-null entry is the current step.
function latestMilestoneFor(row) {
    const list = Array.isArray(row?.request_milestones) ? row.request_milestones : [];
    if (list.length === 0) return null;
    return list[list.length - 1] || null;
}

// Compute the headline badge for a row, mirroring the developer
// dashboard. Derived from the latest milestone's state so the table
// reflects what the developer actually needs to act on, not the
// coarse `ir.status` lifecycle stage.
function badgeFor(row) {
    if (!row) return 'requested';
    const latest = latestMilestoneFor(row);
    if (latest) {
        const completedAt = latest.completed_at;
        const scheduledAt = latest.scheduled_at;
        if (!completedAt) {
            // Expired = scheduled time already passed. Compare against
            // the server's local clock so the picker's "save input
            // verbatim" storage format lines up cleanly with `Date.now()`.
            if (scheduledAt) {
                const ms = new Date(scheduledAt).getTime();
                if (!Number.isNaN(ms) && ms < Date.now()) return 'expired';
            }
            return 'pending';
        }
        return 'completed';
    }
    return row.status || 'requested';
}

// Resolve the application-level outcome state. Independent of the
// interview badge — it reflects the job_applications row's outcome
// flags (success / failed / cancelled). When none of the flags are
// set, the application is "progress" (still in flight).
function applicationStatusFor(row) {
    if (!row) return 'progress';
    if (row.application_success_flag) return 'success';
    if (row.application_failed_flag) return 'failed';
    if (row.application_cancelled_flag) return 'cancelled';
    return 'progress';
}

const APPLICATION_STATUS_TABS = [
    { value: 'all',       label: 'All' },
    { value: 'success',   label: 'Success' },
    { value: 'failed',    label: 'Failed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'progress',  label: 'In progress' }
];

const APPLICATION_STATUS_META = {
    success:   { label: 'Success',     accent: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
    failed:    { label: 'Failed',      accent: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
    cancelled: { label: 'Job cancelled', accent: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    progress:  { label: 'In progress', accent: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' }
};

// The legacy `reply_channel` column was retired. The channel is now
// encoded as the milestone kind (kind='video', kind='phone_screen',
// kind='ai_interview', kind='other' fallback). The MilestoneList stepper
// renders these directly, so no separate badge/component is needed in the
// admin modal or table.

function StatusBadge({ status }) {
    const meta = STATUS_META[status] || { label: status, variant: 'muted' };
    return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

// Pill that surfaces the application-level outcome state. Independent
// from the interview-status badge above — `success` / `failed` /
// `cancelled` come from the application's outcome flags, not the
// interview milestone chain.
function ApplicationStatusBadge({ row }) {
    const status = applicationStatusFor(row);
    const meta = APPLICATION_STATUS_META[status] || APPLICATION_STATUS_META.progress;
    return (
        <span className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
            meta.accent
        )}>
            {meta.label}
        </span>
    );
}

// Read-only milestone stepper + progress bar for the admin dialog.
// Admin-side milestone management. Mirrors the user-side MilestoneList
// (progress bar + stepper + detail list) but adds admin-only actions:
// add/remove/complete/uncomplete milestones, assign a developer to the
// interview_request, and toggle the success/failed flag on the
// application. All actions go through the admin endpoints in routes/admin.js.
import {
    MILESTONE_KINDS,
    PICKABLE_KINDS,
    MilestoneProgressBar,
    MilestoneStepper,
    formatDateTime,
    requiresInterviewTime
} from '@/components/MilestoneList';
import { MilestoneAccordion } from '@/components/MilestoneAccordion';

function AdminMilestonePanel({ row, onSaved, refreshKey = 0 }) {
    const applicationId = row?.application_id;
    const requestId = row?.id;
    const locked = row?.status === 'cancelled' || row?.status === 'completed';

    const [milestones, setMilestones] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [developers, setDevelopers] = useState([]);
    // The committed developer (sent to the server). We track a
    // separate `pendingDeveloperId` so the admin can pick from the
    // dropdown without auto-saving — the assignment is committed
    // only after they click the Confirm button.
    const [developerId, setDeveloperId] = useState(row?.assigned_developer_id || null);
    const [pendingDeveloperId, setPendingDeveloperId] = useState(row?.assigned_developer_id || null);
    const [success, setSuccess] = useState(!!row?.success_flag);
    const [failed, setFailed] = useState(!!row?.failed_flag);
    const [cancelled, setCancelled] = useState(!!row?.cancelled_flag);
    const [draft, setDraft] = useState({
        kind: 'recruiter_reply',
        label: '',
        scheduled_at: '',
        memo: ''
    });
    const [addOpen, setAddOpen] = useState(false);

    // Edit-milestone state. `editingId` is the milestone currently in
    // the inline edit form (null = no edit in progress). The form is
    // rendered separately from the accordion body so the picker /
    // textarea keep their native behaviour and the page doesn't reflow
    // when an admin opens / closes the edit drawer.
    const [editingId, setEditingId] = useState(null);
    const [editDraft, setEditDraft] = useState({ kind: 'recruiter_reply', label: '', scheduled_at: '', memo: '' });
    const [editError, setEditError] = useState(null);

    // Inline-complete state. When the admin clicks the ✓ button on a
    // milestone header, we open this form instead of submitting
    // immediately — lets them capture the actual interview time
    // (GMT-4 picker → UTC ISO on the server) and overwrite the memo
    // in the same step.
    const [completingId, setCompletingId] = useState(null);
    const [completeDraft, setCompleteDraft] = useState({ actual_at: '', memo: '', duration_minutes: '' });
    const [completeError, setCompleteError] = useState(null);

    const refreshMilestones = useCallback(async () => {
        if (!applicationId) return;
        try {
            const res = await adminAPI.listMilestonesAdmin(applicationId);
            const payload = res?.data;
            const list = Array.isArray(payload?.milestones)
                ? payload.milestones
                : (Array.isArray(payload) ? payload : []);
            setMilestones(list);
            if (payload?.request) {
                setDeveloperId(payload.request.assigned_developer_id || null);
            }
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to load milestones');
        } finally {
            setLoading(false);
        }
    }, [applicationId]);

    // Load milestones + developer list on mount + whenever the row changes.
    useEffect(() => {
        setLoading(true);
        setMilestones([]);
        setError(null);
        refreshMilestones();
        (async () => {
            try {
                const res = await adminAPI.listDevelopers();
                setDevelopers(Array.isArray(res?.data) ? res.data : []);
            } catch (_) {
                setDevelopers([]);
            }
        })();
    }, [applicationId, refreshKey, refreshMilestones]);

    const total = milestones.length;
    const completed = milestones.filter((m) => !!m.completed_at).length;

    const handleAdd = async () => {
        if (!applicationId) return;
        setBusy(true);
        setError(null);
        try {
            await adminAPI.addMilestoneAdmin(applicationId, {
                kind: draft.kind,
                label: draft.label || null,
                scheduled_at: draft.scheduled_at || null,
                memo: draft.memo || null
            });
            setDraft({ kind: 'recruiter_reply', label: '', scheduled_at: '', memo: '' });
            setAddOpen(false);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to add milestone');
        } finally {
            setBusy(false);
        }
    };

    // Click handler invoked from the accordion header ✓ button. Opens
    // the inline complete form so the admin can record the actual
    // interview time + outcome memo BEFORE flipping the flag. Mirrors
    // the developer-dashboard flow so the UI is consistent across
    // roles.
    const handleComplete = (m) => {
        setCompletingId(m.id);
        setCompleteError(null);
        // Pre-fill the memo + duration with whatever is currently on
        // the row so the admin can edit instead of re-type.
        setCompleteDraft({
            actual_at: nowAsPickerValue(),
            memo: m.memo || '',
            duration_minutes: m.duration_minutes != null ? String(m.duration_minutes) : ''
        });
    };

    const cancelComplete = () => {
        setCompletingId(null);
        setCompleteDraft({ actual_at: '', memo: '', duration_minutes: '' });
        setCompleteError(null);
    };

    const submitCompleteWithForm = async () => {
        if (!completingId) return;
        setBusy(true);
        setCompleteError(null);
        try {
            // Coerce the duration string to a positive integer (or
            // null) before sending so the server receives a clean
            // payload regardless of how the picker was left.
            let duration = null;
            const raw = String(completeDraft.duration_minutes || '').trim();
            if (raw) {
                const n = parseInt(raw, 10);
                if (Number.isFinite(n) && n > 0 && n <= 1440) duration = n;
            }
            await adminAPI.completeMilestoneAdmin(completingId, {
                actual_at: completeDraft.actual_at || null,
                memo: completeDraft.memo || null,
                duration_minutes: duration
            });
            await refreshMilestones();
            onSaved?.();
            cancelComplete();
        } catch (err) {
            setCompleteError(err.response?.data?.error || 'Failed to complete milestone');
        } finally {
            setBusy(false);
        }
    };

    // Click handler for the accordion header ↻ button. Reopens the
    // milestone by clearing `completed_at` server-side. We keep this
    // as a one-click action because there's no per-milestone data the
    // admin needs to capture during an uncomplete.
    const handleUncomplete = async (m) => {
        setBusy(true);
        setError(null);
        try {
            await adminAPI.uncompleteMilestoneAdmin(m.id);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to reopen milestone');
        } finally {
            setBusy(false);
        }
    };

    // Click handler for the accordion header ✏️ button. Opens the
    // inline edit form prefilled with the current row values.
    const handleEdit = (m) => {
        setEditingId(m.id);
        setEditError(null);
        setEditDraft({
            kind: m.kind || 'recruiter_reply',
            label: m.label || '',
            scheduled_at: utcIsoToLocalPicker(m.scheduled_at),
            memo: m.memo || ''
        });
    };

    const cancelEdit = () => {
        setEditingId(null);
        setEditDraft({ kind: 'recruiter_reply', label: '', scheduled_at: '', memo: '' });
        setEditError(null);
    };

    const submitEdit = async () => {
        if (!editingId) return;
        setBusy(true);
        setEditError(null);
        try {
            await adminAPI.editMilestoneAdmin(editingId, {
                kind: editDraft.kind,
                label: editDraft.label || null,
                scheduled_at: editDraft.scheduled_at || null,
                memo: editDraft.memo || null
            });
            await refreshMilestones();
            onSaved?.();
            cancelEdit();
        } catch (err) {
            setEditError(err.response?.data?.error || 'Failed to save milestone');
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (m) => {
        if (!window.confirm('Remove this milestone?')) return;
        setBusy(true);
        setError(null);
        try {
            await adminAPI.deleteMilestoneAdmin(m.id);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to remove milestone');
        } finally {
            setBusy(false);
        }
    };

    // Approval / payment handlers — admin-only. Each is a single
    // server round-trip; we let the server enforce the
    // "completed-before-approved" / "approved-before-paid" guards and
    // surface the message via the same `error` channel so the user
    // sees why the action was rejected.
    const handleApprove = async (m) => {
        setBusy(true);
        setError(null);
        try {
            await adminAPI.approveMilestoneAdmin(m.id);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to approve milestone');
        } finally {
            setBusy(false);
        }
    };

    const handleUnapprove = async (m) => {
        setBusy(true);
        setError(null);
        try {
            await adminAPI.unapproveMilestoneAdmin(m.id);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to revoke approval');
        } finally {
            setBusy(false);
        }
    };

    const handlePay = async (m) => {
        setBusy(true);
        setError(null);
        try {
            await adminAPI.payMilestoneAdmin(m.id);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to mark milestone as paid');
        } finally {
            setBusy(false);
        }
    };

    const handleUnpay = async (m) => {
        setBusy(true);
        setError(null);
        try {
            await adminAPI.unpayMilestoneAdmin(m.id);
            await refreshMilestones();
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to revoke payment');
        } finally {
            setBusy(false);
        }
    };

    const handleAssign = async (newDeveloperId) => {
        if (!requestId) return;
        setBusy(true);
        setError(null);
        try {
            await adminAPI.assignDeveloper(requestId, newDeveloperId || null);
            setDeveloperId(newDeveloperId || null);
            setPendingDeveloperId(newDeveloperId || null);
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to assign developer');
            // Revert the dropdown back to the committed value.
            setPendingDeveloperId(developerId);
        } finally {
            setBusy(false);
        }
    };

    const handleFlag = async (next) => {
        setBusy(true);
        setError(null);
        try {
            await adminAPI.setApplicationFlags(applicationId, next);
            setSuccess(!!next.success);
            setFailed(!!next.failed);
            setCancelled(!!next.cancelled);
            onSaved?.();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update flags');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="space-y-3">
            {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {error}
                </div>
            )}

            <MilestoneProgressBar total={total} completed={completed} finalState={row?.status} />

            {loading ? (
                <p className="text-xs text-muted-foreground">Loading milestones…</p>
            ) : total === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                    No milestones yet. Use the &quot;Add milestone&quot; form below to seed the pipeline.
                </p>
            ) : (
                <>
                    <MilestoneStepper milestones={milestones} finalState={row?.status} readOnly />

                    {/* Detail list — same shape as the user-side list
                        so admins can audit each step (memo, times,
                        completion state) without expanding a hidden
                        panel. Per-row actions: complete, reopen, remove. */}
                    <div className="space-y-2">
                        {/* Accordion-style detail view. Click the header
                            to expand the full per-milestone audit
                            trail: memo, recruiter message, reply,
                            interview link, AI interview notes, full
                            scheduled/completed timestamps, and who
                            added / completed the step. The current
                            in-progress milestone opens by default. */}
                        <MilestoneAccordion
                            milestones={milestones}
                            onComplete={!locked ? handleComplete : undefined}
                            onUncomplete={!locked ? handleUncomplete : undefined}
                            onEdit={!locked ? handleEdit : undefined}
                            onApprove={!locked ? handleApprove : undefined}
                            onUnapprove={!locked ? handleUnapprove : undefined}
                            onPay={!locked ? handlePay : undefined}
                            onUnpay={!locked ? handleUnpay : undefined}
                            onRemove={!locked ? handleDelete : undefined}
                            canComplete={() => true}
                            showActor
                            busy={busy}
                        />

                        {/* Inline edit form for the currently-edited
                            milestone. Rendered outside the accordion
                            body so it doesn't fight the parent for
                            layout space and so the picker / textarea
                            keep their native behaviour. The accordion
                            header button toggles `editingId` via
                            `handleEdit`. */}
                        {editingId && (() => {
                            const target = milestones.find((m) => m.id === editingId);
                            if (!target) return null;
                            return (
                                <MilestoneEditForm
                                    milestone={target}
                                    draft={editDraft}
                                    setDraft={setEditDraft}
                                    onSubmit={submitEdit}
                                    onCancel={cancelEdit}
                                    busy={busy}
                                    error={editError}
                                />
                            );
                        })()}

                        {/* Inline complete form. Replaces the
                            immediate-submit behaviour the accordion
                            header used to have — admins can now
                            capture the actual interview time + outcome
                            memo before flipping the flag. */}
                        {completingId && (() => {
                            const target = milestones.find((m) => m.id === completingId);
                            if (!target) return null;
                            return (
                                <MilestoneCompleteForm
                                    milestone={target}
                                    draft={completeDraft}
                                    setDraft={setCompleteDraft}
                                    onSubmit={submitCompleteWithForm}
                                    onCancel={cancelComplete}
                                    busy={busy}
                                    error={completeError}
                                />
                            );
                        })()}
                    </div>
                </>
            )}

            {/* Admin controls: developer assignment + outcome flags.
                Non-terminal — toggling the flags doesn't lock the
                application; the admin can flip them on and off at will. */}
            <div className="rounded-md border border-dashed border-border p-3 space-y-3">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {/* Developer assignment — select + Confirm button.
                        The selection is held in `pendingDeveloperId`
                        until the admin clicks Confirm; only then does
                        the assignment hit the server. This avoids the
                        "every dropdown change fires an API call" UX. */}
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Assigned developer
                        </Label>
                        <div className="flex items-center gap-2">
                            <select
                                className="form-select flex-1"
                                value={pendingDeveloperId || ''}
                                onChange={(e) =>
                                    setPendingDeveloperId(e.target.value ? parseInt(e.target.value, 10) : null)
                                }
                                disabled={busy}
                                title="Per-application developer assignment. Only users with role='developer' are eligible."
                            >
                                <option value="">— Unassigned —</option>
                                {developers.map((d) => (
                                    <option key={d.id} value={d.id}>{d.username}</option>
                                ))}
                            </select>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => handleAssign(pendingDeveloperId)}
                                disabled={busy || pendingDeveloperId === developerId}
                                title="Save the developer selection"
                            >
                                Confirm
                            </Button>
                        </div>
                        {pendingDeveloperId !== developerId && (
                            <p className="text-[10px] text-amber-300">
                                ⚠ Selection changed — click Confirm to save.
                            </p>
                        )}
                    </div>

                    {/* Outcome flags as toggle buttons. Each button
                        shows the current state and toggles on click.
                        Success / Failed / Cancelled are independent;
                        the admin can flip any of them on/off without
                        locking the workflow. */}
                    <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            Outcome flags
                        </Label>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                type="button"
                                size="sm"
                                variant={success ? 'default' : 'outline'}
                                disabled={busy}
                                onClick={() => handleFlag({ success: !success, failed, cancelled })}
                                className={success ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}
                                title={success ? 'Click to clear Success flag' : 'Click to mark this application as Success'}
                            >
                                {success ? '✓ Success' : 'Success'}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant={failed ? 'default' : 'outline'}
                                disabled={busy}
                                onClick={() => handleFlag({ success, failed: !failed, cancelled })}
                                className={failed ? 'bg-rose-600 hover:bg-rose-700 text-white' : ''}
                                title={failed ? 'Click to clear Failed flag' : 'Click to mark this application as Failed'}
                            >
                                {failed ? '✗ Failed' : 'Failed'}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant={cancelled ? 'default' : 'outline'}
                                disabled={busy}
                                onClick={() => handleFlag({ success, failed, cancelled: !cancelled })}
                                className={cancelled ? 'bg-amber-600 hover:bg-amber-700 text-white' : ''}
                                title={cancelled ? 'Click to clear Job cancelled flag' : 'Click to mark this job as cancelled (recruiter-side cancellation, not request lifecycle)'}
                            >
                                {cancelled ? '⊘ Job cancelled' : 'Job cancelled'}
                            </Button>
                        </div>
                    </div>
                </div>

                {/* Add-milestone form. Collapsed by default; opens on
                    click so the modal stays compact until the admin
                    needs to seed or backfill a step. */}
                <div className="space-y-2">
                    <button
                        type="button"
                        className="text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                        onClick={() => setAddOpen((v) => !v)}
                    >
                        {addOpen ? '▾ Hide add-milestone form' : '▸ Add milestone (admin backfill)'}
                    </button>
                    {addOpen && (
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px,1fr,180px,auto]">
                            <select
                                className="form-select"
                                value={draft.kind}
                                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
                            >
                                {PICKABLE_KINDS.map((k) => (
                                    <option key={k} value={k}>
                                        {MILESTONE_KINDS[k]?.label || k}
                                    </option>
                                ))}
                            </select>
                            <Input
                                value={draft.label}
                                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                                placeholder="Optional label"
                            />
                            <DateTimePicker
                                value={draft.scheduled_at}
                                onChange={(e) => setDraft((d) => ({ ...d, scheduled_at: e.target.value }))}
                                placeholder="Pick scheduled time"
                            />
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy}
                                onClick={handleAdd}
                            >
                                <Plus className="h-4 w-4" />
                                Add
                            </Button>
                        </div>
                    )}
                    {addOpen && (
                        <Textarea
                            rows={3}
                            value={draft.memo}
                            onChange={(e) => setDraft((d) => ({ ...d, memo: e.target.value }))}
                            placeholder="Memo / meeting link / recruiter message (optional)"
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function DateTimeSubtitle({ iso }) {
    if (!iso) return null;
    try {
        return (
            <span className="text-xs text-muted-foreground">
                {new Date(iso).toLocaleString()}
            </span>
        );
    } catch {
        return null;
    }
}

// Open a generated `.txt` blob as a download — used for the JD download
// button on the admin modal (the resume is already served as a static
// file at /resumes/<file> via the dedicated endpoint).
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

// Convert an ISO-8601 UTC timestamp to the GMT-4 picker string
// (yyyy-MM-ddTHH:mm). The picker renders GMT-4 wall-clock, so we
// subtract 4h before extracting the parts. Returns '' for null/empty.
function utcIsoToLocalPicker(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        const shifted = new Date(d.getTime() - 4 * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
    } catch {
        return '';
    }
}

// Current moment as a GMT-4 picker string. Used to pre-fill the
// actual-interview-time picker so the admin can confirm with one
// click when the interview just happened.
function nowAsPickerValue() {
    return utcIsoToLocalPicker(new Date().toISOString());
}

// Inline edit form for a single milestone. Rendered below the
// accordion (not inside it) so the picker and textarea keep their
// native browser behaviour and don't reflow the page when toggled.
function MilestoneEditForm({ milestone, draft, setDraft, onSubmit, onCancel, busy, error }) {
    return (
        <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Pencil className="h-4 w-4 text-sky-300" />
                    <span className="font-medium">
                        Edit "{milestone.label || MILESTONE_KINDS[milestone.kind]?.label || milestone.kind}"
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-full p-1 text-muted-foreground hover:bg-foreground/10"
                    title="Cancel edit"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>
            {error && (
                <p className="text-rose-300">{error}</p>
            )}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px,1fr,180px]">
                <div className="space-y-1">
                    <Label>Type</Label>
                    <select
                        className="form-select"
                        value={draft.kind}
                        onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                    >
                        {PICKABLE_KINDS.map((k) => (
                            <option key={k} value={k}>{MILESTONE_KINDS[k]?.label || k}</option>
                        ))}
                    </select>
                </div>
                <div className="space-y-1">
                    <Label>Label</Label>
                    <Input
                        value={draft.label}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                        placeholder="Optional label"
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
                <Label>Memo / details</Label>
                <Textarea
                    rows={4}
                    value={draft.memo}
                    onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
                    placeholder="Meeting link, recruiter message, AI notes, anything relevant…"
                />
            </div>
            <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy} onClick={onSubmit}>
                    <Pencil className="h-4 w-4" />
                    Save changes
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
                    Cancel
                </Button>
                {milestone.completed_at && (
                    <span className="text-[10px] text-amber-300">
                        Editing a completed milestone — completed_at / completed_by are preserved.
                    </span>
                )}
            </div>
        </div>
    );
}

// Inline complete form. Captures the actual interview time + outcome
// memo before flipping the flag. Mirrors the developer-dashboard
// shape so the audit trail stays consistent regardless of role.
function MilestoneCompleteForm({ milestone, draft, setDraft, onSubmit, onCancel, busy, error }) {
    return (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-emerald-300" />
                    <span className="font-medium">
                        Complete "{MILESTONE_KINDS[milestone.kind]?.label || milestone.kind}"
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
            {error && (
                <p className="text-rose-300">{error}</p>
            )}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="space-y-1">
                    <Label>
                        <CalendarClock className="inline h-3 w-3 mr-1" />
                        Actual interview time (GMT-4)
                    </Label>
                    <DateTimePicker
                        value={draft.actual_at}
                        onChange={(e) => setDraft({ ...draft, actual_at: e.target.value })}
                        placeholder="Pick actual interview time"
                    />
                    <p className="text-[10px] text-muted-foreground">
                        Optional. If left blank the server records the completion timestamp.
                    </p>
                </div>
                <div className="space-y-1">
                    <Label>
                        <Clock className="inline h-3 w-3 mr-1" />
                        Interview duration (minutes)
                        {requiresInterviewTime(milestone.kind) && ' *'}
                    </Label>
                    <Input
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
                <Label>
                    <FileText className="inline h-3 w-3 mr-1" />
                    Outcome memo
                </Label>
                <Textarea
                    rows={4}
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

function InterviewDetailModal({ row, open, onOpenChange, onSaved }) {
    const [status, setStatus] = useState(row?.status || 'requested');
    const [savingStatus, setSavingStatus] = useState(false);
    const [error, setError] = useState(null);

    // When the row changes (a new one is opened), sync the local status.
    useEffect(() => {
        if (row) {
            setStatus(row.status || 'requested');
            setError(null);
        }
    }, [row]);

    // Admins can drive the lifecycle to any of the request-level
    // statuses except 'cancelled' — that outcome is captured by the
    // dedicated "Job cancelled" flag in the MilestonePanel below so
    // the recruiter cancellation stays decoupled from the request
    // lifecycle (admin can also re-open the request without losing
    // the cancelled flag, since they're stored on separate columns).
    const allTargetStatuses = ['requested', 'scheduled', 'completed']
        .filter((s) => s !== row?.status);

    const handleAdvance = async (target) => {
        setError(null);
        setSavingStatus(true);
        try {
            await adminAPI.updateInterviewRequestStatus(row.id, target, '');
            onSaved?.();
            setStatus(target);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update status');
        } finally {
            setSavingStatus(false);
        }
    };

    // Download buttons shown next to the company name in the modal header.
    // Server already serves /resumes/<file> as a static file (the resume
    // service owns those), so the resume link opens in a new tab. The JD
    // is a generated blob (text content of job_description).
    const handleDownloadResume = () => {
        if (!row?.application_resume_filename) return;
        window.open(`/resumes/${row.application_resume_filename}`, '_blank');
    };

    const handleDownloadJD = () => {
        if (!row?.job_description) return;
        const fname = `jd_${slugify(row.company_name)}_${slugify(row.job_role)}.txt`;
        downloadAsTextFile(fname, row.job_description);
    };

    if (!row) return null;

    const meta = STATUS_META[row.status] || STATUS_META.requested;
    const transitionsForCurrentRow = allTargetStatuses;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="space-y-1">
                            <DialogTitle className="flex items-center gap-3">
                                <span>{row.company_name}</span>
                                <StatusBadge status={badgeFor(row)} />
                            </DialogTitle>
                            <DialogDescription>
                                {row.job_role || 'Role not specified'} · {row.profile_name}
                                {' '}· {row.assigned_users || 'Unassigned'}
                            </DialogDescription>
                        </div>
                        {/* Header-right cluster: resume + JD download
                            buttons. Disabled-looking when the artefact
                            doesn't exist for this row. */}
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                type="button"
                                onClick={handleDownloadResume}
                                disabled={!row.application_resume_filename}
                                title={
                                    row.application_resume_filename
                                        ? `Download the candidate's resume (${row.application_resume_filename})`
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
                                onClick={handleDownloadJD}
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
                </DialogHeader>

                <DialogBody className="space-y-4">
                    {/* Recruiter reply — the dedicated /admin/interview-requests
                        endpoint does `SELECT ir.*` so the columns come through
                        with their base names (no `request_` prefix). The
                        application_recruiter_* aliases still come from the
                        join on job_applications and are used as a fallback. */}
                    <div>
                        <Label>Interview Progress</Label>
                        <div
                            className={cn(
                                'mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-card/60 p-3 text-sm whitespace-pre-wrap',
                                (row.recruiter_reply || row.application_recruiter_reply)
                                    ? ''
                                    : 'italic text-muted-foreground'
                            )}
                        >
                            {row.recruiter_reply || row.application_recruiter_reply || 'No interview progress recorded on this application.'}
                        </div>
                        {(row.recruiter_reply_at || row.application_recruiter_reply_at) && (
                            <DateTimeSubtitle
                                iso={row.recruiter_reply_at || row.application_recruiter_reply_at}
                            />
                        )}
                    </div>

                    {/* Reply channel — how the recruiter got back to the user
                        (Video / Phone / AI interview / Email / Text / Other).
                        Rendered as a coloured pill (same widget used in the
                        table) so the value is visible at a glance. */}
                    {/* The "Reply channel" panel was retired. The channel is
                        now represented by the head milestone's kind
                        (kind='video'/'phone_screen'/'ai_interview'/'other'),
                        so look at the Milestones block below for the
                        same information. */}

                    {/* Milestones — read-only progress trail + per-step
                        detail cards. The `AdminMilestoneList` shows the
                        visual stepper; below it, each milestone with
                        non-empty detail fields is rendered as a detail
                        card showing recruiter_message / reply_message /
                        interview_link / ai_interview_detail so the admin
                        can audit the conversation per step. */}
                    <div className="rounded-md border border-border p-3 space-y-3">
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
                        <AdminMilestonePanel
                            row={row}
                            onSaved={onSaved}
                        />
                    </div>

                    {/* Request timeline — when the user filed the request and
                        when it expires. Highlights an expired window so the
                        admin can tell stale requests at a glance. */}
                    {(row.requested_time || row.expire_time) && (
                        <div className="rounded-md border border-border p-3 space-y-2">
                            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                Request timeline
                            </Label>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 text-sm">
                                <div>
                                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                        Requested time
                                    </Label>
                                    <div className="text-sm">
                                        {row.requested_time ? (
                                            <DateTimeSubtitle iso={row.requested_time} />
                                        ) : (
                                            '—'
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                                        Expire time
                                    </Label>
                                    <div className="text-sm">
                                        {row.expire_time ? (
                                            <span
                                                className={
                                                    new Date(row.expire_time).getTime() < Date.now()
                                                        ? 'text-destructive'
                                                        : ''
                                                }
                                            >
                                                <DateTimeSubtitle iso={row.expire_time} />
                                            </span>
                                        ) : (
                                            '—'
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Lifecycle buttons. Admins can move the request to
                        any status (the server no longer enforces the
                        strict transition map for admin writes) so this
                        is the single point for closing out a request
                        independent of the milestone trail. Note that
                        the 'cancelled' transition was removed from here
                        when the dedicated "Job cancelled" flag was
                        added to the MilestonePanel — that flag
                        captures recruiter-side cancellations without
                        touching the request lifecycle column. */}
                    <div className="space-y-2">
                        <Label>Move lifecycle</Label>
                        <p className="text-xs text-muted-foreground">
                            Pick any other status. Admins can re-open <strong>completed</strong>{' '}
                            requests if they were marked in error.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                            {transitionsForCurrentRow.length === 0 && (
                                <span className="text-xs text-muted-foreground italic">
                                    This request is already in {meta.label}; no other statuses to choose.
                                </span>
                            )}
                            {transitionsForCurrentRow.map((t) => (
                                <Button
                                    key={t}
                                    size="sm"
                                    variant={t === 'completed' ? 'gradient' : 'default'}
                                    onClick={() => handleAdvance(t)}
                                    disabled={savingStatus}
                                >
                                    → {STATUS_META[t].label}
                                </Button>
                            ))}
                        </div>
                        {error && (
                            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                {error}
                            </div>
                        )}
                    </div>

                    {/* Interview details (type, date, time, interviewer,
                        location, meeting link) used to live here as a
                        read-only grid. Those fields are no longer captured
                        on the request row — they belong on the
                        individual milestone (phone_call_schedule /
                        videocall_schedule / technical_interview / etc.),
                        which is the source of truth for "where the
                        interview is happening". The stepper above already
                        shows each milestone's scheduled time, link, and
                        recruiter message. */}

                    {/* Linked admin-side interview */}
                    {row.admin_interview_id && (
                        <div className="rounded-md border border-border bg-accent/30 p-3 text-xs">
                            <strong>Admin-scheduled interview #{row.admin_interview_id}</strong> exists for this
                            application (date: {row.admin_scheduled_date || 'unscheduled'}).
                        </div>
                    )}
                </DialogBody>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function InterviewRequestsPage({ embedded = false }) {
    const [loading, setLoading] = useState(true);
    const [tableLoading, setTableLoading] = useState(false);
    const [error, setError] = useState(null);
    const [rows, setRows] = useState([]);
    const [counts, setCounts] = useState({ requested: 0, scheduled: 0, completed: 0, cancelled: 0, total: 0 });
    const [openRow, setOpenRow] = useState(null);

    // Filters
    //   The legacy `reply_channel` filter was retired along with its
    //   column — the channel is now encoded as a milestone kind, so the
    //   admin can browse replies by status (or by inspecting the
    //   milestone list on the detail dialog) without a dedicated filter.
    const [status, setStatus] = useState('all');
    // Application-level outcome filter. Sits independently of the
    // interview-status filter above so admins can combine them —
    // e.g. "all completed interviews whose underlying application is
    // marked failed". Sent to the server as `application_status` so
    // the SQL filter narrows the result set at the source.
    const [applicationStatus, setApplicationStatus] = useState('all');
    const [company, setCompany] = useState('');
    const [profile, setProfile] = useState('');
    const [assignedUser, setAssignedUser] = useState('all');
    const [users, setUsers] = useState([]);
    // Free-text search across company_name, job_role, job_description,
    // and the recruiter message / reply_message — the DB-side LIKE
    // is the only path that catches keywords embedded inside the
    // full job_description body (e.g. a company name like "SunWest"
    // that the scraper never wrote into the parsed company_name).
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(search), 300);
        return () => clearTimeout(t);
    }, [search]);

    // Pagination. The server returns a `pagination` envelope
    // (page / limit / total / totalPages) for the interview-requests
    // list; we mirror it locally so the Prev/Next controls can
    // disable at the edges. `page` is 1-based. We keep the size
    // constant — the page is bounded by the KPI data-volume
    // (ADMIN_INTERVIEW_PAGE_SIZE) and admins don't need a "show 100
    // per page" toggle.
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const totalPages = Math.max(1, Math.ceil(total / ADMIN_INTERVIEW_PAGE_SIZE));

    // Debounce text filters slightly so we don't refetch on every keystroke.
    const [debouncedCompany, setDebouncedCompany] = useState('');
    const [debouncedProfile, setDebouncedProfile] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedCompany(company), 300);
        return () => clearTimeout(t);
    }, [company]);
    useEffect(() => {
        const t = setTimeout(() => setDebouncedProfile(profile), 300);
        return () => clearTimeout(t);
    }, [profile]);

    // Pull the developer-only user list (primary role 'developer'
    // OR an additional role via `user_roles`) for the assigned-user
    // filter dropdown. Using `listDevelopers` instead of the generic
    // `getUsers` keeps the filter aligned with the developer-only
    // table column and the developer-assignment dropdown in the
    // detail modal — every place admins pick a developer uses the
    // same eligibility pool.
    const loadUsers = async () => {
        try {
            const res = await adminAPI.listDevelopers();
            setUsers(Array.isArray(res.data) ? res.data : []);
        } catch (err) {
            console.error('Failed to load users:', err);
        }
    };

    const load = async (params = {}) => {
        try {
            setTableLoading(true);
            setError(null);
            const res = await adminAPI.listInterviewRequests({
                // The interview-status filter is now applied entirely
                // client-side (see `filteredRows` below) because the
                // dropdown values match the latest-milestone badge,
                // not `ir.status`. We intentionally do NOT pass the
                // `status` param here — sending it would re-filter by
                // the request lifecycle and drop rows whose latest
                // milestone is, say, "completed" while the request is
                // still in `requested` state.
                application_status: params.application_status ?? applicationStatus,
                company: params.company ?? debouncedCompany,
                profile: params.profile ?? debouncedProfile,
                assigned_user: params.assigned_user ?? assignedUser,
                search: params.search ?? debouncedSearch,
                // Server-side pagination. The page number is shared
                // via the `page` state so the Prev/Next controls
                // can move the cursor. We allow an override via
                // `params.page` so callers can force a specific page
                // (e.g. after a row update we sometimes need to
                // re-fetch the current page).
                page: params.page ?? page,
                limit: ADMIN_INTERVIEW_PAGE_SIZE
            });
            setRows(Array.isArray(res.data?.data) ? res.data.data : []);
            if (res.data?.counts) setCounts(res.data.counts);
            // The server returns the total filtered count (not the
            // global count) so the pagination footer can render
            // "Page X of Y" accurately.
            const returnedTotal = res.data?.pagination?.total;
            setTotal(typeof returnedTotal === 'number' ? returnedTotal : 0);
        } catch (err) {
            console.error('Failed to load interview-requests:', err);
            setError(err.response?.data?.error || 'Failed to load interview requests');
        } finally {
            setTableLoading(false);
            setLoading(false);
        }
    };

    useEffect(() => {
        loadUsers();
    }, []);

    // Reset to page 1 whenever any server-side filter changes —
    // otherwise the user can land on an empty page because the new
    // filter narrowed the result set below the previous offset.
    // (The interview-status filter is intentionally excluded — it
    // is applied client-side above the page cursor.)
    useEffect(() => {
        setPage(1);
    }, [debouncedCompany, debouncedProfile, debouncedSearch, applicationStatus, assignedUser]);

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedCompany, debouncedProfile, debouncedSearch, applicationStatus, assignedUser, page]);

    // When the `status` (interview lifecycle) filter changes we
    // don't refetch — it's a client-side filter applied after the
    // server response. But if the current page is now empty, jump
    // back to page 1 so the user doesn't see a blank table.
    useEffect(() => {
        if (page > 1 && total > 0 && rows.length === 0) {
            setPage(1);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, rows.length, total, page]);

    // Apply the interview-status filter client-side. The dropdown
    // values map to the latest-milestone badge (pending / expired /
    // completed), with `cancelled` falling back to `ir.status` when
    // there are no milestones yet. Doing this client-side keeps the
    // filter aligned with the badges rendered in the table — the user
    // sees the same "Completed" pill in both places, and selecting
    // the dropdown shows only rows wearing that pill.
    const filteredRows = useMemo(() => {
        if (status === 'all') return rows;
        return rows.filter((r) => badgeFor(r) === status);
    }, [rows, status]);

    // Lightweight active-filter chip builder for the top bar
    const activeChips = useMemo(() => {
        const out = [];
        if (status !== 'all') {
            out.push({
                key: 'status',
                label: `Interview: ${STATUS_META[status]?.label || status}`,
                onClear: () => setStatus('all')
            });
        }
        if (applicationStatus !== 'all') {
            out.push({
                key: 'application_status',
                label: `Application: ${APPLICATION_STATUS_META[applicationStatus]?.label || applicationStatus}`,
                onClear: () => setApplicationStatus('all')
            });
        }
        if (debouncedCompany) {
            out.push({
                key: 'company',
                label: `Company: ${debouncedCompany}`,
                onClear: () => setCompany('')
            });
        }
        if (debouncedProfile) {
            out.push({
                key: 'profile',
                label: `Profile: ${debouncedProfile}`,
                onClear: () => setProfile('')
            });
        }
        if (assignedUser !== 'all') {
            out.push({
                key: 'user',
                label: `User: ${assignedUser}`,
                onClear: () => setAssignedUser('all')
            });
        }
        return out;
    }, [status, applicationStatus, debouncedCompany, debouncedProfile, assignedUser]);

    const reset = () => {
        setStatus('all');
        setApplicationStatus('all');
        setSearch('');
        setCompany('');
        setProfile('');
        setAssignedUser('all');
    };

    if (loading) return <PageLoader message="Loading interview requests..." />;

    // Status summary tiles — counts the per-row badge derived
    // from the latest milestone, not `ir.status`.
    const byBadge = { pending: 0, expired: 0, completed: 0, cancelled: 0 };
    for (const r of rows) {
        const b = badgeFor(r);
        if (byBadge[b] != null) byBadge[b] += 1;
    }
    const tiles = [
        { key: 'all',       label: 'Total',       count: rows.length },
        { key: 'pending',   label: 'Pending',     count: byBadge.pending },
        { key: 'expired',   label: 'Expired',     count: byBadge.expired },
        { key: 'completed', label: 'Completed',   count: byBadge.completed },
        { key: 'cancelled', label: 'Cancelled',   count: byBadge.cancelled }
    ];

    return (
        <AppPage
            embedded={embedded}
            icon={CalendarClock}
            title="Interview Progress"
            description="Every interview progress update captured by your users, grouped by lifecycle stage."
        >
        <div className="space-y-4">
            <PageCommandBar
                search={(
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                        <Input
                            id="admin-ir-search"
                            className="h-10 border-white/10 bg-black/25 pl-10"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search description, company, role…"
                        />
                    </div>
                )}
                actions={(
                    <Button variant="outline" size="sm" className="h-10" onClick={() => load()} disabled={tableLoading}>
                        <RefreshCw className={cn('h-4 w-4', tableLoading && 'animate-spin')} />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                )}
                filters={(
                    <>
                        <Select value={status} onValueChange={setStatus}>
                            <SelectTrigger className="h-9 w-[9rem] border-white/10 bg-black/20">
                                <SelectValue placeholder="Interview" />
                            </SelectTrigger>
                            <SelectContent>
                                {STATUS_TABS.map((t) => (
                                    <SelectItem key={t.value} value={t.value}>
                                        {t.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select value={applicationStatus} onValueChange={setApplicationStatus}>
                            <SelectTrigger className="h-9 w-[9.5rem] border-white/10 bg-black/20">
                                <SelectValue placeholder="Application" />
                            </SelectTrigger>
                            <SelectContent>
                                {APPLICATION_STATUS_TABS.map((t) => (
                                    <SelectItem key={t.value} value={t.value}>
                                        {t.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Input
                            id="company"
                            className="h-9 w-[9rem] border-white/10 bg-black/20"
                            value={company}
                            onChange={(e) => setCompany(e.target.value)}
                            placeholder="Company…"
                        />
                        <Input
                            id="profile"
                            className="h-9 w-[9rem] border-white/10 bg-black/20"
                            value={profile}
                            onChange={(e) => setProfile(e.target.value)}
                            placeholder="Profile…"
                        />
                        <Select
                            value={assignedUser}
                            onValueChange={(v) => setAssignedUser(v === 'all' ? 'all' : v)}
                        >
                            <SelectTrigger className="h-9 w-[9.5rem] border-white/10 bg-black/20">
                                <SelectValue placeholder="Assigned user" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All users</SelectItem>
                                {users.map((u) => (
                                    <SelectItem key={u.id} value={u.username}>
                                        {u.username}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </>
                )}
                chips={activeChips.length > 0 ? (
                    <>
                        {activeChips.map((chip) => (
                            <FilterChip key={chip.key} label={chip.label} onClear={chip.onClear} />
                        ))}
                        <Button variant="ghost" size="sm" onClick={reset}>Reset all</Button>
                    </>
                ) : null}
            />

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {tiles.map((s) => {
                    const isActive = status === s.key;
                    const accent = STATUS_META[s.key]?.accent || '#94a3b8';
                    return (
                        <button
                            key={s.key}
                            type="button"
                            onClick={() => setStatus(s.key)}
                            className={cn(
                                'group flex items-center gap-3 rounded-2xl border p-3 text-left backdrop-blur-sm transition-all',
                                isActive
                                    ? 'border-primary/40 bg-primary/10 ring-1 ring-primary/30'
                                    : 'border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] hover:border-primary/30'
                            )}
                        >
                            <div
                                className="flex h-10 w-10 items-center justify-center rounded-xl text-white"
                                style={{ background: accent }}
                            >
                                <span className="text-base font-bold tabular-nums">{s.count}</span>
                            </div>
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-white">{s.label}</div>
                                <div className="text-xs text-white/40">
                                    {isActive ? 'Filtered' : 'Click to filter'}
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

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
                                ? ` · showing ${(page - 1) * ADMIN_INTERVIEW_PAGE_SIZE + 1}–${Math.min(page * ADMIN_INTERVIEW_PAGE_SIZE, total)}`
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
                {tableLoading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center gap-3 rounded-2xl bg-background/50 backdrop-blur-sm text-sm text-white/50">
                        <Loader size="md" />
                        Refreshing…
                    </div>
                )}

                {filteredRows.length === 0 && !tableLoading ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                        No interview-requests match the current filters.
                    </div>
                ) : (
                    filteredRows.map((r) => {
                        const reply = r.application_recruiter_reply || r.recruiter_reply;
                        const badge = badgeFor(r);
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
                                        badge === 'pending' && 'from-amber-400 to-orange-600',
                                        badge === 'expired' && 'from-rose-400 to-rose-700',
                                        badge === 'completed' && 'from-emerald-400 to-teal-600',
                                        badge === 'cancelled' && 'from-slate-400 to-slate-600',
                                        !['pending', 'expired', 'completed', 'cancelled'].includes(badge) && 'from-teal-400 to-cyan-600'
                                    )}
                                    aria-hidden
                                />
                                <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
                                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                                        <div className="min-w-0 flex-1 space-y-2">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="truncate text-sm font-semibold text-white">
                                                    {r.company_name}
                                                </h3>
                                                <StatusBadge status={badge} />
                                                <ApplicationStatusBadge row={r} />
                                            </div>
                                            <p className="truncate text-xs text-white/45">
                                                {r.job_role || 'Role unspecified'}
                                                {r.profile_name ? ` · ${r.profile_name}` : ''}
                                                {` · ${r.assigned_users || 'Unassigned'}`}
                                            </p>
                                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/40">
                                                <span>
                                                    Scheduled:{' '}
                                                    {r.scheduled_date
                                                        ? `${r.scheduled_date}${r.scheduled_time ? ` ${r.scheduled_time}` : ''}${r.timezone ? ` (${r.timezone})` : ''}`
                                                        : '—'}
                                                </span>
                                                <span>
                                                    Updated: {r.updated_at ? new Date(r.updated_at).toLocaleString() : '—'}
                                                </span>
                                            </div>
                                            {reply ? (
                                                <p
                                                    className="line-clamp-2 text-xs italic text-white/35"
                                                    title={reply}
                                                >
                                                    {(reply.length > 120 ? reply.slice(0, 120) + '…' : reply)}
                                                </p>
                                            ) : (
                                                <p className="text-xs text-white/25">No reply on file</p>
                                            )}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2 self-end xl:self-start">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-8"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setOpenRow(r);
                                                }}
                                            >
                                                View
                                                <ChevronRight className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            </article>
                        );
                    })
                )}
            </div>

            {openRow && (
                <InterviewDetailModal
                    row={openRow}
                    open={!!openRow}
                    onOpenChange={(o) => !o && setOpenRow(null)}
                    onSaved={() => load()}
                />
            )}
        </div>
        </AppPage>
    );
}

export default InterviewRequestsPage;
