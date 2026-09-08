// Shared milestone list + progress bar used by:
//   - the user-side interview-request modal (editable)
//   - the user-side interview-requests dashboard dialog (read-only)
//   - the admin-side interview-requests detail dialog (read-only)
//
// Visual contract:
//   • Each milestone is a pill / row with an icon, a label, and a
//     scheduled-time tooltip.
//   • Completed milestones are filled; pending ones are outlined.
//   • When `finalState === 'completed' | 'cancelled'`, the list renders as
//     a final trail (the progress bar locks at 100% / 0% respectively).
//   • The progress bar is always shown: width = completed / total (or 0
//     when total is 0).

import { useEffect, useMemo, useState } from 'react';
import {
    Sparkles,
    Video,
    Phone,
    Building2,
    Trophy,
    HelpCircle,
    XCircle,
    Plus,
    Trash2,
    Save,
    MessageSquare,
    Check,
    Mail,
    CalendarClock,
    Headphones,
    Users
} from 'lucide-react';
import { userAPI } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { MilestoneAccordion } from '@/components/MilestoneAccordion';
import { DateTimePicker } from '@/components/DatePicker';

// Canonical kind -> { label, Icon, accent }.
// These match the server's `MILESTONE_KINDS` list (services/milestoneService.js).
// The 2026-07 rewrite consolidated the legacy kinds (`recruiter_message`,
// `phone_call_schedule`, `videocall_schedule`, ...) into shorter canonical
// names. Legacy kinds are still accepted in the kind map for read-only
// display so older rows render correctly — but the user-facing Add-Milestone
// form uses the new canonical names.
export const MILESTONE_KINDS = {
    // Canonical kinds (must match server)
    recruiter_reply:          { label: 'Recruiter reply',            Icon: Mail,           accent: 'text-cyan-300   border-cyan-500/40   bg-cyan-500/10' },
    ai_interview:             { label: 'AI interview',               Icon: Sparkles,       accent: 'text-sky-300 border-sky-500/40 bg-sky-500/10' },
    phone_screen:             { label: 'Phone screen',               Icon: Phone,          accent: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
    video:                    { label: 'Video interview',            Icon: Video,          accent: 'text-sky-300    border-sky-500/40    bg-sky-500/10' },
    technical:                { label: 'Technical interview',        Icon: Headphones,     accent: 'text-rose-300   border-rose-500/40   bg-rose-500/10' },
    hiring_manager_interview: { label: 'Hiring manager interview',   Icon: Users,          accent: 'text-indigo-300 border-indigo-500/40 bg-indigo-500/10' },
    panel_interview:          { label: 'Panel interview',            Icon: Users,          accent: 'text-indigo-300 border-indigo-500/40 bg-indigo-500/10' },
    offer:                    { label: 'Offer',                      Icon: Trophy,         accent: 'text-yellow-300 border-yellow-500/40 bg-yellow-500/10' },
    other:                    { label: 'Other',                      Icon: HelpCircle,     accent: 'text-slate-300  border-slate-500/40  bg-slate-500/10' },
    // Legacy aliases — display only. The server now expects the
    // canonical names, so the Add-Milestone form doesn't offer these.
    // Older rows stored with these names will still render via the map.
    recruiter_message:        { label: 'Recruiter message (legacy)',         Icon: Mail,     accent: 'text-cyan-300   border-cyan-500/40   bg-cyan-500/10' },
    reply_received:           { label: 'Recruiter reply (legacy)',           Icon: MessageSquare, accent: 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10' },
    phone_call_schedule:      { label: 'Phone call (legacy)',                Icon: Phone,    accent: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10' },
    videocall_schedule:       { label: 'Video call (legacy)',                Icon: Video,    accent: 'text-sky-300    border-sky-500/40    bg-sky-500/10' },
    technical_interview:      { label: 'Technical interview (legacy)',       Icon: Headphones, accent: 'text-rose-300 border-rose-500/40   bg-rose-500/10' },
    onsite:                   { label: 'Onsite (legacy)',                    Icon: Building2, accent: 'text-amber-300  border-amber-500/40  bg-amber-500/10' }
};

// Subset of kinds the user can pick from the Add-Milestone form.
// These are the canonical (server-accepted) names. The first one is
// the default selection — `recruiter_reply` first because the user
// spec lists it as the first step.
export const PICKABLE_KINDS = [
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

// Mirrors the server-side DEVELOPER_COMPLETABLE_KINDS whitelist.
// Developers can mark these kinds as completed; everything else
// (recruiter_reply, offer, other) is admin-only.
export const DEVELOPER_COMPLETABLE_KINDS = new Set([
    'ai_interview',
    'phone_screen',
    'video',
    'technical',
    'hiring_manager_interview',
    'panel_interview'
]);

// Subset of milestone kinds that represent an actual interview —
// i.e. a meeting happened at a specific time. The Complete form
// requires an `actual_at` timestamp for these kinds so the audit
// trail captures when the interview took place. Non-interview
// kinds (recruiter_reply, offer, other) can be completed without
// a timestamp.
export const INTERVIEW_KINDS = new Set([
    'ai_interview',
    'phone_screen',
    'video',
    'technical',
    'hiring_manager_interview',
    'panel_interview'
]);

// Convenience predicate so callers don't have to know the Set name.
export function requiresInterviewTime(kind) {
    return INTERVIEW_KINDS.has(kind);
}

// Returns true if the current user is allowed to mark a milestone of
// the given kind as completed. Used to gate the "Complete" button in
// the list view + stepper.
export function canCurrentUserComplete({ kind, isAdmin, isAssignedDeveloper }) {
    if (isAdmin) return true;
    if (!isAssignedDeveloper) return false;
    return DEVELOPER_COMPLETABLE_KINDS.has(kind);
}

// Map a `kind` to a compact display label. Used both for rendering the
// latest-milestone pill in the Applications table and for the
// stepper. Falls back to a humanised form of the key.
export function milestoneLabel(kind) {
    if (!kind) return 'Pending';
    const k = MILESTONE_KINDS[kind];
    if (k) return k.label;
    // Unknown future kind — turn `foo_bar_baz` into `Foo bar baz`.
    return kind.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Format a UTC ISO timestamp for display in the user's locale (the
// stored value is already UTC; the picker is GMT-4 so user-entered
// wall-clock times line up). Exported so the admin-side dashboard
// can use the same formatter as the user-side MilestoneList rows.
export function formatDateTime(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '—';
        return d.toLocaleString();
    } catch {
        return '—';
    }
}

function MilestonePill_DEPRECATED() { return null; }

export function MilestoneProgressBar({ total, completed, finalState }) {
    const pct = finalState === 'cancelled'
        ? 0
        : (total > 0 ? Math.round((completed / total) * 100) : 0);

    const barColor = finalState === 'cancelled'
        ? 'bg-rose-500'
        : finalState === 'completed' || completed === total && total > 0
            ? 'bg-emerald-500'
            : 'bg-primary';

    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground">
                <span>
                    {finalState === 'cancelled'
                        ? 'Cancelled'
                        : finalState === 'completed'
                            ? 'Completed'
                            : 'Progress'}
                </span>
                <span>
                    {total > 0 ? `${completed} / ${total} · ${pct}%` : 'No milestones yet'}
                </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                    className={cn('h-full transition-all', barColor)}
                    style={{ width: `${pct}%` }}
                />
            </div>
        </div>
    );
}

// Visual stepper. Each milestone is a circular dot with its icon; dots
// are connected by a track that fills to the current position. The first
// dot has a sparkle glow and the *current* (first non-completed) dot is
// highlighted with a primary ring + soft pulse. Every dot shows its
// scheduled time as a tooltip.
//
// Dots are **never clickable**: completing a milestone is now driven
// automatically by the Add-Milestone flow (when a new step is added the
// previous one becomes completed). `readOnly` and `onToggle` are kept
// in the signature for backward compatibility — `onToggle` is a no-op
// when the parent passes it through.
export function MilestoneStepper({
    milestones,
    finalState,
    readOnly = true,
    onToggle: _onToggle
}) {
    const list = Array.isArray(milestones) ? milestones.filter(Boolean) : [];
    if (list.length === 0) return null;

    // The "current" milestone is the first non-completed one (or the
    // last when the request is completed). Guard against null entries
    // so a stray null never throws "Cannot read properties of null".
    let currentIndex = list.findIndex((m) => m && !m.completed_at);
    if (currentIndex === -1) currentIndex = list.length - 1;

    const isFinalDone = finalState === 'completed';
    const isFinalCancel = finalState === 'cancelled';

    return (
        <ol
            className={cn(
                'flex w-full items-stretch gap-0',
                isFinalCancel && 'opacity-70'
            )}
        >
            {list.map((m, idx) => {
                if (!m) return null;
                const meta = MILESTONE_KINDS[m.kind] || MILESTONE_KINDS.other;
                const Icon = meta.Icon;
                const isDone = !!m.completed_at;
                const isCurrent = idx === currentIndex && !isFinalDone && !isFinalCancel;
                const isFirst = idx === 0;
                const isLast = idx === list.length - 1;

                // Track is "filled" for every step already completed.
                // If the request is completed the whole track is filled;
                // if it's cancelled, none of it is.
                const trackFilled = isFinalDone
                    ? true
                    : isFinalCancel
                        ? false
                        : isDone;

                // The "final" badge applies to the last dot when the
                // parent request is in a terminal state.
                const isFinalMilestone = (isFinalDone || isFinalCancel) && isLast;

                return (
                    <li
                        key={m.id}
                        className="flex-1 min-w-0 flex flex-col items-center relative"
                    >
                        {/* Connector line that lives in the row above the
                            dots. It overlaps the previous connector so the
                            track reads as a single continuous bar. */}
                        {idx > 0 && (
                            <div
                                className="absolute top-4 right-1/2 w-full h-0.5 -translate-y-1/2 px-0"
                                aria-hidden
                            >
                                <div
                                    className={cn(
                                        'h-full transition-all',
                                        trackFilled ? 'bg-primary' : 'bg-border'
                                    )}
                                />
                            </div>
                        )}

                        {/* The dot itself. Sparkle halo on the first dot;
                            ring + pulse on the current one; muted when
                            cancelled. Rendered as a `<span>` (not a
                            button) because completing a milestone is
                            no longer a manual click — it happens
                            automatically when the next milestone is
                            added. The parent Application Status (latest
                            milestone kind) is the source of truth
                            visible in the table. */}
                        <span
                            role="img"
                            aria-label={`${meta.label}${m.completed_at ? ' — completed' : ' — pending'}`}
                            title={
                                m.completed_at
                                    ? `Completed: ${formatDateTime(m.completed_at)}`
                                    : (m.scheduled_at
                                        ? `Scheduled: ${formatDateTime(m.scheduled_at)}`
                                        : 'Not scheduled yet — will complete when the next milestone is added')
                            }
                            className={cn(
                                'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 transition',
                                isDone
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : isFinalCancel
                                        ? 'bg-card text-muted-foreground border-border line-through'
                                        : `${meta.accent} border-current/30`,
                                isCurrent && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background scale-110',
                                'cursor-default'
                            )}
                        >
                            {/* Sparkle halo on the very first dot — a
                                gentle violet glow that flags "we
                                received a reply" before the user has
                                added anything. */}
                            {isFirst && (
                                <span
                                    className="absolute -inset-1.5 rounded-full pointer-events-none"
                                    style={{
                                        background:
                                            'radial-gradient(circle, rgba(167, 139, 250, 0.55) 0%, rgba(167, 139, 250, 0) 70%)',
                                        filter: 'blur(3px)',
                                        animation: 'pulse 2.4s ease-in-out infinite'
                                    }}
                                    aria-hidden
                                />
                            )}
                            {isDone ? (
                                <Check className="h-4 w-4" />
                            ) : (
                                <Icon className="h-3.5 w-3.5" />
                            )}
                        </span>

                        {/* Label + scheduled time. The date span is
                            always rendered (with a min-height placeholder
                            when no scheduled time is set) so the connector
                            line stays straight and the column heights
                            match across the stepper. */}
                        <div className="mt-2 flex flex-col items-center text-center px-1 min-h-[34px]">
                            <span
                                className={cn(
                                    'text-[11px] font-medium leading-tight',
                                    isCurrent ? 'text-foreground' : 'text-muted-foreground',
                                    isFinalCancel && 'line-through'
                                )}
                            >
                                {m.label || meta.label}
                            </span>
                            {m.scheduled_at ? (
                                <span
                                    className="mt-0.5 text-[10px] text-muted-foreground"
                                    title={formatDateTime(m.scheduled_at)}
                                >
                                    {new Date(m.scheduled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                </span>
                            ) : (
                                // Reserve the same vertical space the date
                                // span would occupy so the stepper doesn't
                                // reflow when some rows have no schedule.
                                <span aria-hidden className="mt-0.5 text-[10px] leading-none">&nbsp;</span>
                            )}
                            {isFinalMilestone && (
                                <span className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                                    Final
                                </span>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

export function MilestoneList({ applicationId, finalState, onChange, refreshKey = 0, currentUserRoles = [], assignedDeveloperId = null, currentUserId = null }) {
    const [milestones, setMilestones] = useState([]);
    const [loading, setLoading] = useState(true);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState(null);
    const isAdmin = Array.isArray(currentUserRoles) && currentUserRoles.includes('admin');
    const isAssignedDeveloper = currentUserId != null && assignedDeveloperId === currentUserId;
    // Per-milestone detail fields. The backend accepts these as free-form
    // text (recruiter_message, reply_message, interview_link, ai_interview_detail,
    // notes) so the user can capture full context — recruiter DMs, link
    // paste, AI screener notes, etc. — without being limited to a single
    // short label.
    const EMPTY_DRAFT = {
        // Default to recruiter_reply so the first thing the user
        // records is the inbound reply that kicked the pipeline off.
        kind: 'recruiter_reply',
        label: '',
        scheduled_at: '',
        notes: '',
        recruiter_message: '',
        reply_message: '',
        interview_link: '',
        ai_interview_detail: ''
    };
    const [draft, setDraft] = useState(EMPTY_DRAFT);

    const locked = finalState === 'cancelled' || finalState === 'completed';

    useEffect(() => {
        if (!applicationId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await userAPI.listMilestones(applicationId);
                if (cancelled) return;
                // The 2026-07 endpoint returns `{ milestones: [...], summary,
                // request, ... }` while the legacy endpoint (still hit by
                // older API clients) returns a bare array. Accept both
                // shapes so the component works regardless of which path
                // was routed.
                const payload = res?.data;
                const list = Array.isArray(payload)
                    ? payload
                    : (payload && Array.isArray(payload.milestones) ? payload.milestones : []);
                setMilestones(list);
            } catch (err) {
                if (!cancelled) setError(err.response?.data?.error || 'Failed to load milestones');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [applicationId, refreshKey]);

    const totals = useMemo(() => {
        const list = Array.isArray(milestones) ? milestones.filter(Boolean) : [];
        const completed = list.filter((m) => !!m.completed_at).length;
        return { total: list.length, completed };
    }, [milestones]);

    // Bubble counts up so the parent can show a progress bar elsewhere.
    useEffect(() => {
        onChange?.({ ...totals, milestones });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [totals.completed, totals.total, milestones.length]);

    const addMilestone = async () => {
        if (!applicationId || locked) return;
        setError(null);
        setAdding(true);
        try {
            // Trim each detail field; only forward non-empty values so the
            // row stays tidy. Backend `cleanMilestoneInput` accepts every
            // one of these.
            const trimOrNull = (v) => {
                if (typeof v !== 'string') return null;
                const t = v.trim();
                return t ? t : null;
            };
            const payload = {
                kind: draft.kind,
                label: draft.label?.trim() || null,
                // Forward the picker string as-is. The picker emits a
                // GMT-4 wall-clock string like "2026-07-13T15:30"; the
                // backend's `cleanMilestoneAddInput` recognises that
                // shape via the picker-string regex and runs
                // `localPickerToUTCIso` to land it in UTC. Wrapping
                // it in `new Date(...).toISOString()` here would treat
                // the GMT-4 input as if it were already UTC and
                // produce a value 4 hours ahead of what the user picked.
                scheduled_at: draft.scheduled_at || null,
                notes:                trimOrNull(draft.notes),
                recruiter_message:    trimOrNull(draft.recruiter_message),
                reply_message:        trimOrNull(draft.reply_message),
                interview_link:       trimOrNull(draft.interview_link),
                ai_interview_detail:  trimOrNull(draft.ai_interview_detail)
            };

            // Snapshot the existing list before the POST so we can
            // auto-complete the (now) second-to-last milestone when the
            // new row lands. Ordering matches the server
            // (`ORDER BY position ASC, id ASC`).
            const ordered = Array.isArray(milestones)
                ? milestones.filter(Boolean).slice().sort((a, b) => {
                    const pa = a.position ?? a.id;
                    const pb = b.position ?? b.id;
                    if (pa !== pb) return pa - pb;
                    return (a.id ?? 0) - (b.id ?? 0);
                })
                : [];
            const prevToComplete = ordered[ordered.length - 1] || null;

            const res = await userAPI.addMilestone(applicationId, payload);
            // Defensive: the server should return the inserted row. Some
            // legacy clients receive `null` because the auto-chain
            // helper inserts another row before we read last_insert_rowid.
            // Drop nullish entries so we never push them into state.
            const inserted = res && res.data ? res.data : null;
            const newInsertedId = inserted && typeof inserted === 'object' ? inserted.id : null;

            // Reload from the server rather than mutating locally so
            // position renumbering done by appendNextChainMilestone is
            // reflected immediately, then auto-complete the previous
            // step (if any) to advance the progress bar.
            let refreshed = [];
            try {
                const list = await userAPI.listMilestones(applicationId);
                const payload = list?.data;
                const rows = Array.isArray(payload)
                    ? payload
                    : (payload && Array.isArray(payload.milestones) ? payload.milestones : []);
                refreshed = rows.filter(Boolean).slice().sort((a, b) => {
                    const pa = a.position ?? a.id;
                    const pb = b.position ?? b.id;
                    if (pa !== pb) return pa - pb;
                    return (a.id ?? 0) - (b.id ?? 0);
                });
                setMilestones(refreshed);
            } catch (_) {
                // Fall back to optimistic append if the refetch fails.
                if (newInsertedId) {
                    setMilestones((prev) => [...prev, inserted]);
                }
            }

            // If the row we expected to complete still exists in the
            // refreshed list and isn't already done, mark it complete on
            // the server. The progress bar will tick over on the next
            // render.
            if (prevToComplete && !prevToComplete.completed_at
                && (newInsertedId || refreshed.length > ordered.length)) {
                try {
                    const stamp = new Date().toISOString();
                    const upd = await userAPI.updateMilestone(prevToComplete.id, {
                        completed_at: stamp
                    });
                    const updatedRow = upd && upd.data ? upd.data : null;
                    if (updatedRow) {
                        setMilestones((prev) =>
                            prev.map((x) => (x.id === updatedRow.id ? updatedRow : x))
                        );
                    } else {
                        // Server succeeded but returned no row — update
                        // the local cache in place so the bar advances.
                        setMilestones((prev) =>
                            prev.map((x) => (
                                x.id === prevToComplete.id
                                    ? { ...x, completed_at: stamp }
                                    : x
                            ))
                        );
                    }
                } catch (innerErr) {
                    setError(
                        (innerErr.response && innerErr.response.data && innerErr.response.data.error)
                        || 'Failed to mark previous milestone complete'
                    );
                }
            }

            setDraft(EMPTY_DRAFT);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to add milestone');
        } finally {
            setAdding(false);
        }
    };

    // Which detail fields to surface for the currently selected `kind`.
    // Everything is optional, but exposing a sensible subset per kind
    // keeps the form scannable. Users can switch kinds to access other
    // fields; the conditional simply hides unused ones.
    const detailFields = (() => {
        switch (draft.kind) {
            case 'reply_received':
                return [
                    { key: 'reply_message', label: 'Reply from recruiter', rows: 4,
                      placeholder: 'Paste the recruiter\'s message here…' }
                ];
            case 'recruiter_message':
                return [
                    { key: 'recruiter_message', label: 'Recruiter message', rows: 6,
                      placeholder: 'Full message from the recruiter — outreach, interview prep notes, agenda, expectations, comp hints, etc.' },
                    { key: 'reply_message', label: 'Your reply (optional)', rows: 4,
                      placeholder: 'If you responded, paste your reply here…' }
                ];
            case 'ai_interview':
                return [
                    { key: 'ai_interview_detail', label: 'AI interview detail', rows: 6,
                      placeholder: 'Questions asked, scoring notes, recordings, links, what to do before next step…' }
                ];
            case 'phone_call_schedule':
            case 'videocall_schedule':
            case 'technical_interview':
            case 'hiring_manager_interview':
            case 'video':
            case 'phone_screen':
            case 'onsite':
                return [
                    { key: 'recruiter_message', label: 'Recruiter message', rows: 4,
                      placeholder: 'What did the recruiter send you? (job description, agenda, expectations…)' },
                    { key: 'interview_link', label: 'Interview link', rows: 2,
                      placeholder: 'Zoom / Google Meet / Teams URL (https:// optional)' }
                ];
            case 'offer':
                return [
                    { key: 'recruiter_message', label: 'Recruiter message', rows: 4,
                      placeholder: 'Verbal offer details, comp breakdown, timeline…' },
                    { key: 'reply_message', label: 'Your reply', rows: 4,
                      placeholder: 'How you responded, counters, questions asked…' }
                ];
            case 'other':
            default:
                return [
                    { key: 'notes', label: 'Notes', rows: 4,
                      placeholder: 'Anything noteworthy about this step…' }
                ];
        }
    })();

    // Completing a milestone used to be a manual click on its dot.
    // That has been removed — see MilestoneStepper. Completion now
    // happens automatically inside addMilestone() when a new step is
    // added (the previous one moves to `completed_at = now`).

    const removeMilestone = async (m) => {
        if (locked) return;
        if (!window.confirm('Remove this milestone?')) return;
        try {
            await userAPI.deleteMilestone(m.id);
            setMilestones((prev) => prev.filter((x) => x.id !== m.id));
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to remove milestone');
        }
    };

    // Explicit "Mark complete" handler — the stepper doesn't have a
    // click action anymore (completion used to happen automatically
    // when the next milestone was added). This is the dedicated
    // developer/admin path for advancing the workflow without adding a
    // new step. The server enforces the role + kind rules; we mirror
    // them client-side to avoid round-tripping on every click.
    const completeMilestone = async (m) => {
        if (locked || m.completed_at) return;
        const allowed = canCurrentUserComplete({
            kind: m.kind,
            isAdmin,
            isAssignedDeveloper
        });
        if (!allowed) {
            const meta = MILESTONE_KINDS[m.kind] || MILESTONE_KINDS.other;
            setError(isAdmin
                ? `You can't complete "${meta.label}" (this kind is admin-only).`
                : isAssignedDeveloper
                    ? `"${meta.label}" can only be marked complete by an admin.`
                    : 'Only the assigned developer or an admin can mark milestones complete.');
            return;
        }
        try {
            const res = await userAPI.completeMilestone(applicationId);
            if (res?.data?.milestone) {
                setMilestones((prev) =>
                    prev.map((x) => (x.id === res.data.milestone.id ? res.data.milestone : x))
                );
            } else {
                // Refetch on unexpected shape.
                const list = await userAPI.listMilestones(applicationId);
                const payload = list?.data;
                const rows = Array.isArray(payload)
                    ? payload
                    : (payload && Array.isArray(payload.milestones) ? payload.milestones : []);
                setMilestones(rows);
            }
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to complete milestone');
        }
    };

    return (
        <div className="space-y-3">
            {error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {error}
                </div>
            )}

            <MilestoneProgressBar
                total={totals.total}
                completed={totals.completed}
                finalState={finalState}
            />

            {loading ? (
                <p className="text-xs text-muted-foreground">Loading milestones…</p>
            ) : milestones.length === 0 ? (
                <p className="text-xs italic text-muted-foreground">
                    No milestones yet. Add the first one below — e.g. "AI interview",
                    "Phone screen", "Video".
                </p>
            ) : (
                <div className="space-y-2">
                    {/* Stepper: each milestone is a circular dot, dots are
                        connected by a progress bar, the first dot has a
                        sparkle halo, and the current (first non-completed)
                        dot is highlighted with a primary ring + pulse. */}
                    <MilestoneStepper
                        milestones={milestones}
                        finalState={finalState}
                    />
                    {!locked && (
                        <div className="flex justify-end">
                            <span
                                className="text-[10px] text-muted-foreground"
                                title="A milestone is marked complete automatically when you add the next step."
                            >
                                Milestones complete automatically when you add the next one
                            </span>
                        </div>
                    )}

                    {/* Detailed list view — one row per milestone with type
                        badge, scheduled time, completion time, memo, and
                        per-row actions (remove / mark complete depending on
                        permissions). Sits directly below the stepper so the
                        user can see all milestone metadata without
                        expanding a hidden panel. */}
                    <div className="space-y-2">
                        {/* Accordion-style detail view. Each milestone
                            is a collapsible card; click the header to
                            expand the full detail body (memo, recruiter
                            message, reply, interview link, AI notes,
                            full scheduled/completed timestamps). The
                            current in-progress milestone opens by
                            default so attention is drawn to it. */}
                        <MilestoneAccordion
                            milestones={milestones}
                            onComplete={!locked ? completeMilestone : undefined}
                            onRemove={!locked ? removeMilestone : undefined}
                            canComplete={(m) => canCurrentUserComplete({
                                kind: m.kind,
                                isAdmin,
                                isAssignedDeveloper
                            })}
                            busy={adding}
                        />
                    </div>
                </div>
            )}

            {!locked && (
                <div className="rounded-md border border-dashed border-border p-3 space-y-3">
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-[160px,1fr,180px,auto]">
                        <div className="space-y-1">
                            <Label htmlFor="ms-kind" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Type
                            </Label>
                            <select
                                id="ms-kind"
                                className="form-select"
                                value={draft.kind}
                                onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
                            >
                                {PICKABLE_KINDS.map((k) => (
                                    <option key={k} value={k}>
                                        {MILESTONE_KINDS[k].label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="ms-label" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Label (optional)
                            </Label>
                            <Input
                                id="ms-label"
                                value={draft.label}
                                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                                placeholder="e.g. AI screener"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="ms-time" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                Scheduled time
                            </Label>
                            <DateTimePicker
                                id="ms-time"
                                value={draft.scheduled_at}
                                onChange={(e) => setDraft((d) => ({ ...d, scheduled_at: e.target.value }))}
                                placeholder="Pick scheduled time"
                            />
                        </div>
                        <div className="flex items-end">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={addMilestone}
                                disabled={adding}
                                className="w-full"
                            >
                                <Plus className="h-4 w-4" />
                                Add
                            </Button>
                        </div>
                    </div>

                    {/* Per-kind detail textareas. The set of fields shown
                        changes as the user picks a different milestone
                        type, so e.g. "Video" surfaces interview link +
                        recruiter message, while "AI interview" surfaces
                        the AI detail block. All optional. */}
                    {detailFields.length > 0 && (
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                            {detailFields.map((f) => (
                                <div key={f.key} className="space-y-1">
                                    <Label
                                        htmlFor={`ms-${f.key}`}
                                        className="text-[10px] uppercase tracking-wider text-muted-foreground"
                                    >
                                        {f.label}
                                    </Label>
                                    <Textarea
                                        id={`ms-${f.key}`}
                                        rows={f.rows}
                                        value={draft[f.key] || ''}
                                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                                        placeholder={f.placeholder}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {finalState === 'cancelled' && (
                <p className="flex items-center gap-1 text-xs text-rose-300">
                    <XCircle className="h-3.5 w-3.5" />
                    This request was cancelled — milestones are shown as a final trail and can&apos;t be edited.
                </p>
            )}
        </div>
    );
}
