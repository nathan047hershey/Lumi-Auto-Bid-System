// =============================================================================
// MilestoneAccordion — collapsible per-milestone detail card
// =============================================================================
// Each milestone is rendered as a single accordion item: a header row with
// the kind badge + scheduled time + a chevron, and a collapsible body that
// holds the full interview detail (memo, recruiter message, reply, interview
// link, AI notes, scheduled/completed timestamps, who added/completed it).
//
// Used by:
//   - MilestoneList.jsx                 (user-side interview-request detail)
//   - InterviewRequests.jsx (admin)     (admin Interview Requests detail)
//   - Applications.jsx                  (admin Applications table drill-in)
//
// The accordion is fully controlled — the parent decides which item is
// open via `expandedId`. This lets us either keep one milestone open at
// a time (typical UX), or persist multiple-open state if a workflow
// needs it. `defaultExpandedId` is the initial open state used when the
// component first mounts (defaults to the latest in-progress milestone
// when not provided, so the "current step" is the natural focal point).
// =============================================================================

import { useEffect, useRef, useState } from 'react';
import {
    Banknote,
    CalendarClock,
    Check,
    ChevronDown,
    ChevronRight,
    Clock,
    ExternalLink,
    FileText,
    Mail,
    MessageSquare,
    Pencil,
    Reply,
    Sparkles,
    Stamp,
    Trash2,
    User as UserIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// Local lookup map mirroring MilestoneList.jsx. Kept independent so
// the accordion can be imported anywhere without dragging the whole
// MilestoneList module (and its React hooks) into the bundle.
const KIND_META = {
    recruiter_reply:          { label: 'Recruiter reply',            Icon: Mail,           accent: 'text-cyan-300   border-cyan-500/40   bg-cyan-500/10' },
    ai_interview:             { label: 'AI interview',               Icon: Sparkles,       accent: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
    phone_screen:             { label: 'Phone screen',               Icon: MessageSquare,  accent: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
    video:                    { label: 'Video interview',            Icon: MessageSquare,  accent: 'text-sky-300    border-sky-500/40    bg-sky-500/10' },
    technical:                { label: 'Technical interview',        Icon: MessageSquare,  accent: 'text-rose-300   border-rose-500/40   bg-rose-500/10' },
    hiring_manager_interview: { label: 'Hiring manager interview',   Icon: UserIcon,       accent: 'text-indigo-300 border-indigo-500/40 bg-indigo-500/10' },
    panel_interview:          { label: 'Panel interview',            Icon: UserIcon,       accent: 'text-indigo-300 border-indigo-500/40 bg-indigo-500/10' },
    offer:                    { label: 'Offer',                      Icon: Check,          accent: 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10' },
    other:                    { label: 'Other',                      Icon: MessageSquare,  accent: 'text-slate-300  border-slate-500/40  bg-slate-500/10' },
    // Legacy aliases — display only, for older rows.
    recruiter_message:        { label: 'Recruiter message',          Icon: Mail,           accent: 'text-cyan-300   border-cyan-500/40   bg-cyan-500/10' },
    reply_received:           { label: 'Recruiter reply (legacy)',   Icon: Mail,           accent: 'text-cyan-300   border-cyan-500/40   bg-cyan-500/10' },
    phone_call_schedule:      { label: 'Phone call (legacy)',        Icon: MessageSquare,  accent: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
    videocall_schedule:       { label: 'Video call (legacy)',        Icon: MessageSquare,  accent: 'text-sky-300    border-sky-500/40    bg-sky-500/10' },
    technical_interview:      { label: 'Technical interview (legacy)', Icon: MessageSquare, accent: 'text-rose-300 border-rose-500/40 bg-rose-500/10' },
    onsite:                   { label: 'Onsite (legacy)',            Icon: UserIcon,       accent: 'text-amber-300  border-amber-500/40  bg-amber-500/10' }
};

function formatDateTime(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        // Locale-formatted date+time, used for the inline detail lines.
        return d.toLocaleString();
    } catch {
        return '—';
    }
}

function formatFullDateTime(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        // Long-form (weekday + month name + time) so the expanded body
        // shows the date unambiguously.
        return d.toLocaleString(undefined, {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return '—';
    }
}

// Returns the meta entry for a kind. Falls back to the `other` row so
// unknown future kinds still render with a generic icon.
function metaFor(kind) {
    return KIND_META[kind] || KIND_META.other;
}

// Single-row detail line — label on the left, value on the right.
// Used for scheduled time, completion time, "added by", "completed by".
function DetailRow({ icon: Icon, label, value, title, href }) {
    const content = href
        ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline">{value}<ExternalLink className="h-3 w-3" /></a>
        : <span>{value || '—'}</span>;
    return (
        <div className="flex items-start gap-2 text-xs">
            {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className="text-foreground/90" title={title || undefined}>{content}</div>
            </div>
        </div>
    );
}

// Long-form text block for memo / recruiter message / reply / AI
// detail. Hidden if empty so the accordion body stays compact.
function DetailBlock({ icon: Icon, label, text }) {
    if (!text || !String(text).trim()) return null;
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {Icon && <Icon className="h-3 w-3" />}
                <span>{label}</span>
            </div>
            <p className="whitespace-pre-wrap rounded-md border border-border/50 bg-card/50 p-2 text-xs text-foreground/90">
                {text}
            </p>
        </div>
    );
}

// Single accordion row.
//
// Props:
//   milestone        — row from /api/.../milestones/{appId}
//   expanded         — true when this row is open (parent controls state)
//   onToggle         — () => void
//   onComplete       — optional: handler for the "Mark complete" button
//   onUncomplete     — optional: handler for the "Reopen" button
//   onEdit           — optional: handler for the "Edit" button (admin)
//   onRemove         — optional: handler for the "Remove" button
//   onApprove        — optional: handler for the "Approve" button (admin)
//   onUnapprove      — optional: handler for the "Unapprove" button (admin)
//   onPay            — optional: handler for the "Pay" button (admin)
//   onUnpay          — optional: handler for the "Unpay" button (admin)
//   canComplete      — boolean; whether the current viewer is allowed to
//                      mark this kind complete (gates the button)
//   readOnly         — boolean; hides all action buttons (admin view-only)
//   showActor        — boolean; show "Added by" / "Completed by" lines
function MilestoneAccordionItem({
    milestone,
    expanded,
    onToggle,
    onComplete,
    onUncomplete,
    onEdit,
    onRemove,
    onApprove,
    onUnapprove,
    onPay,
    onUnpay,
    canComplete = false,
    readOnly = false,
    showActor = false,
    busy = false
}) {
    const meta = metaFor(milestone.kind);
    const Icon = meta.Icon;
    const isDone = !!milestone.completed_at;
    const isCurrent = !isDone;

    // Header sub-line: shows the most relevant time stamp inline so the
    // user can scan all milestones without opening each one. Once
    // completed we surface the recorded duration alongside the
    // completion timestamp so the per-row summary shows how long the
    // interview actually ran without forcing the user to expand.
    const headerSubtitle = milestone.scheduled_at
        ? `📅 ${formatDateTime(milestone.scheduled_at)}`
        : (isDone ? `✓ ${formatDateTime(milestone.completed_at)}` : 'Pending');
    const headerTrailer = isDone && milestone.duration_minutes != null
        ? ` · ${milestone.duration_minutes} min`
        : '';

    return (
        <div
            className={cn(
                'rounded-md border text-xs',
                isDone
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : isCurrent
                        ? 'border-sky-500/40 bg-sky-500/5'
                        : 'border-border bg-card/40'
            )}
        >
            <button
                type="button"
                onClick={onToggle}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left hover:bg-foreground/5"
                aria-expanded={expanded}
            >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                    {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span
                        className={cn(
                            'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
                            meta.accent,
                            isDone && 'bg-emerald-500/20'
                        )}
                    >
                        {isDone ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">
                                {milestone.label || meta.label}
                            </span>
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
                                    meta.accent
                                )}
                            >
                                {meta.label}
                            </span>
                            {isDone && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
                                    Completed
                                </span>
                            )}
                            {milestone.approved && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-emerald-200">
                                    <Stamp className="h-2.5 w-2.5" />
                                    Approved
                                </span>
                            )}
                            {milestone.paid && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-yellow-200">
                                    <Banknote className="h-2.5 w-2.5" />
                                    Paid
                                </span>
                            )}
                            {isCurrent && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sky-300">
                                    In progress
                                </span>
                            )}
                        </div>
                        <div className="text-[11px] text-muted-foreground truncate">{headerSubtitle}{headerTrailer}</div>
                    </div>
                </div>
                {!readOnly && (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {!isDone && onComplete && (
                            <button
                                type="button"
                                onClick={onComplete}
                                disabled={busy || !canComplete}
                                title={canComplete ? 'Mark this milestone complete' : 'Not permitted for your role / kind'}
                                className={cn(
                                    'rounded-full p-1 text-muted-foreground',
                                    canComplete
                                        ? 'hover:bg-emerald-500/10 hover:text-emerald-300'
                                        : 'opacity-40 cursor-not-allowed'
                                )}
                            >
                                <Check className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {isDone && onUncomplete && (
                            <button
                                type="button"
                                onClick={onUncomplete}
                                disabled={busy}
                                title="Reopen this milestone"
                                className="rounded-full p-1 text-muted-foreground hover:bg-amber-500/10 hover:text-amber-300"
                            >
                                <Clock className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {onEdit && (
                            <button
                                type="button"
                                onClick={onEdit}
                                disabled={busy}
                                title="Edit milestone details"
                                className="rounded-full p-1 text-muted-foreground hover:bg-sky-500/10 hover:text-sky-300"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {/* Approve / Unapprove — admin-only workflow
                            gate. Approve is only enabled once the
                            milestone is completed (matches the
                            server-side guard). When approved the
                            button flips to a red "Unapprove" action
                            that also clears the paid flag. */}
                        {onApprove && !milestone.approved && (
                            <button
                                type="button"
                                onClick={onApprove}
                                disabled={busy || !milestone.completed_at}
                                title={
                                    milestone.completed_at
                                        ? 'Approve this milestone (gates the developer\'s approved-time rollup)'
                                        : 'Approve is only available once the milestone is completed'
                                }
                                className="rounded-full p-1 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                <Stamp className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {onUnapprove && milestone.approved && (
                            <button
                                type="button"
                                onClick={onUnapprove}
                                disabled={busy}
                                title="Revoke approval (will also clear the paid flag)"
                                className="rounded-full p-1 text-emerald-300 hover:bg-amber-500/10 hover:text-amber-300"
                            >
                                <Stamp className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {/* Pay / Unpay — admin-only invoice workflow.
                            Pay is only enabled once the milestone is
                            approved (matches the server-side guard). */}
                        {onPay && milestone.approved && !milestone.paid && (
                            <button
                                type="button"
                                onClick={onPay}
                                disabled={busy}
                                title="Mark this milestone as paid"
                                className="rounded-full p-1 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-300"
                            >
                                <Banknote className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {onUnpay && milestone.paid && (
                            <button
                                type="button"
                                onClick={onUnpay}
                                disabled={busy}
                                title="Revoke payment"
                                className="rounded-full p-1 text-emerald-300 hover:bg-amber-500/10 hover:text-amber-300"
                            >
                                <Banknote className="h-3.5 w-3.5" />
                            </button>
                        )}
                        {onRemove && (
                            <button
                                type="button"
                                onClick={onRemove}
                                disabled={busy}
                                title="Remove milestone"
                                className="rounded-full p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                )}
            </button>

            {expanded && (
                <div className="border-t border-border/60 px-3 py-3 space-y-3">
                    {/* Top meta grid — kind label, scheduled/completed times,
                        actors. Two columns on md+ so the panel doesn't
                        stretch too wide. */}
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        <DetailRow
                            icon={CalendarClock}
                            label="Scheduled"
                            value={formatFullDateTime(milestone.scheduled_at)}
                            title={milestone.scheduled_at || ''}
                        />
                        <DetailRow
                            icon={Check}
                            label="Completed"
                            value={formatFullDateTime(milestone.completed_at)}
                            title={milestone.completed_at || ''}
                        />
                        {milestone.duration_minutes != null && (
                            <DetailRow
                                icon={Clock}
                                label="Duration"
                                value={`${milestone.duration_minutes} min`}
                            />
                        )}
                        {milestone.approved && (
                            <DetailRow
                                icon={Stamp}
                                label="Approved"
                                value={formatFullDateTime(milestone.approved_at)}
                                title={milestone.approved_at || ''}
                            />
                        )}
                        {milestone.paid && (
                            <DetailRow
                                icon={Banknote}
                                label="Paid"
                                value={formatFullDateTime(milestone.paid_at)}
                                title={milestone.paid_at || ''}
                            />
                        )}
                        {showActor && (
                            <>
                                <DetailRow
                                    icon={UserIcon}
                                    label="Added by"
                                    value={milestone.added_by_username || (milestone.added_by ? `#${milestone.added_by}` : '—')}
                                />
                                <DetailRow
                                    icon={UserIcon}
                                    label="Completed by"
                                    value={milestone.completed_by_username || (milestone.completed_by ? `#${milestone.completed_by}` : '—')}
                                />
                                {milestone.approved_by != null && (
                                    <DetailRow
                                        icon={UserIcon}
                                        label="Approved by"
                                        value={milestone.approved_by_username || `#${milestone.approved_by}`}
                                    />
                                )}
                                {milestone.paid_by != null && (
                                    <DetailRow
                                        icon={UserIcon}
                                        label="Paid by"
                                        value={milestone.paid_by_username || `#${milestone.paid_by}`}
                                    />
                                )}
                            </>
                        )}
                    </div>

                    {/* Memo (new canonical field) — shown as a free-form
                        text block. Most recruiters paste a meeting link
                        or short summary here. */}
                    <DetailBlock icon={FileText} label="Memo / details" text={milestone.memo} />

                    {/* Legacy detail fields. These are read-only on
                        older rows; we keep them visible so admins can
                        still audit historical interview info. */}
                    <DetailBlock icon={Mail}      label="Recruiter message" text={milestone.recruiter_message} />
                    <DetailBlock icon={Reply}     label="Your reply"        text={milestone.reply_message} />
                    {milestone.interview_link && (
                        <DetailRow
                            icon={ExternalLink}
                            label="Interview link"
                            value={milestone.interview_link}
                            href={milestone.interview_link}
                        />
                    )}
                    <DetailBlock icon={Sparkles}  label="AI interview detail" text={milestone.ai_interview_detail} />

                    {/* Prominent complete action — the user reported the
                        tiny ✓ header icon was easy to miss, so we also
                        surface a full-width button at the bottom of
                        the expanded body when the milestone is still
                        open. Both the header icon and this button
                        trigger the same `onComplete` handler so the
                        inline complete-form opens either way. */}
                    {!isDone && onComplete && (
                        <div className="flex justify-end pt-2 border-t border-border/40">
                            <Button
                                type="button"
                                size="default"
                                onClick={onComplete}
                                disabled={busy || !canComplete}
                                className="bg-emerald-600 text-white hover:bg-emerald-700"
                                title={canComplete ? 'Open the complete form' : 'Not permitted for your role / kind'}
                            >
                                <Check className="h-4 w-4 mr-1.5" />
                                Mark milestone complete
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Wrapper component that renders the full accordion for a list of
// milestones. Manages the expanded-state internally OR accepts a
// controlled `expandedId` / `onExpandedChange` pair so the parent can
// keep one milestone open at a time across multiple MilestoneAccordions
// on the same page.
//
// Props:
//   milestones        — list from /api/.../milestones/{appId}
//   onComplete(m)     — handler (optional, falls back to no-op if absent)
//   onUncomplete(m)   — handler
//   onEdit(m)         — handler (admin-side edit form trigger)
//   onApprove(m)      — handler (admin-side approve trigger)
//   onUnapprove(m)    — handler (admin-side unapprove trigger)
//   onPay(m)          — handler (admin-side pay trigger)
//   onUnpay(m)        — handler (admin-side unpay trigger)
//   onRemove(m)       — handler
//   canComplete(m)    — predicate, default () => true (admin view)
//   readOnly          — when true, hides all action buttons
//   showActor         — when true, shows Added-by / Completed-by lines
//   busy              — disable action buttons while a request is in flight
//   defaultOpenFirst  — open the first in-progress milestone by default
export function MilestoneAccordion({
    milestones,
    onComplete,
    onUncomplete,
    onEdit,
    onApprove,
    onUnapprove,
    onPay,
    onUnpay,
    onRemove,
    canComplete = () => true,
    readOnly = false,
    showActor = false,
    busy = false,
    defaultOpenFirst = true,
    emptyMessage = 'No milestones yet.'
}) {
    const list = Array.isArray(milestones) ? milestones.filter(Boolean) : [];
    const [expandedId, setExpandedId] = useState(null);
    const initialised = useRef(false);

    // Open the current (first non-completed) milestone by default so
    // the user's attention is drawn to it on first load.
    useEffect(() => {
        if (initialised.current) return;
        if (!defaultOpenFirst || list.length === 0) return;
        const current = list.find((m) => !m.completed_at) || list[0];
        setExpandedId(current.id);
        initialised.current = true;
    }, [list, defaultOpenFirst]);

    if (list.length === 0) {
        return (
            <p className="text-xs italic text-muted-foreground">{emptyMessage}</p>
        );
    }

    return (
        <div className="space-y-2">
            {list.map((m) => (
                <MilestoneAccordionItem
                    key={m.id}
                    milestone={m}
                    expanded={expandedId === m.id}
                    onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
                    onComplete={onComplete ? () => onComplete(m) : undefined}
                    onUncomplete={onUncomplete ? () => onUncomplete(m) : undefined}
                    onEdit={onEdit ? () => onEdit(m) : undefined}
                    onApprove={onApprove ? () => onApprove(m) : undefined}
                    onUnapprove={onUnapprove ? () => onUnapprove(m) : undefined}
                    onPay={onPay ? () => onPay(m) : undefined}
                    onUnpay={onUnpay ? () => onUnpay(m) : undefined}
                    onRemove={onRemove ? () => onRemove(m) : undefined}
                    canComplete={canComplete(m)}
                    readOnly={readOnly}
                    showActor={showActor}
                    busy={busy}
                />
            ))}
        </div>
    );
}

export default MilestoneAccordion;
