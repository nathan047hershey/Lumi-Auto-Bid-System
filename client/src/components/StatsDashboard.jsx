import { Fragment, useMemo, useState } from 'react';
import {
    RefreshCw,
    Send,
    Target,
    TrendingUp,
    Trophy,
    Calendar as CalendarIcon,
    CalendarDays,
    Sun,
    CheckCircle2,
    X,
    Video,
    Phone,
    MapPin,
    User,
    Link as LinkIcon,
    StickyNote,
    Wrench,
    Clock,
    Inbox,
    Activity,
    Users,
    Filter,
    ListChecks,
    MessageSquareReply
} from 'lucide-react';
import { cn, formatDateTime } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogClose
} from '@/components/ui/dialog';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow
} from '@/components/ui/table';
import FiltersBar from '@/components/admin/FiltersBar';
import PeriodPills, { USER_PERIOD_OPTIONS } from '@/components/dashboard/PeriodPills';
import ConversionFunnel from '@/components/dashboard/ConversionFunnel';
import PeriodCompareChart from '@/components/dashboard/PeriodCompareChart';
import TechStackChart from '@/components/dashboard/TechStackChart';
import PrimaryActivityChart from '@/components/dashboard/PrimaryActivityChart';
import DashboardDetailsSection from '@/components/dashboard/DashboardDetailsSection';

const PERIOD_THEMES = {
    workday: { accent: '#2dd4bf', icon: Sun, label: 'Workday', desc: '7am GMT-4 → 7am GMT-4' },
    '24h':   { accent: '#22d3ee', icon: CalendarDays, label: 'Last 24 hours', desc: 'Anchored at 7am GMT-4' },
    '7d':    { accent: '#14b8a6', icon: CalendarDays, label: 'Last 7 days', desc: 'Rolling 7-day window' },
    week:    { accent: '#14b8a6', icon: CalendarDays, label: 'This week', desc: 'Current week window' },
    '30d':   { accent: '#10b981', icon: CalendarIcon, label: 'Last 30 days', desc: 'Rolling 30-day window' },
    month:   { accent: '#10b981', icon: CalendarIcon, label: 'This month', desc: 'Current month window' },
    custom:  { accent: '#06b6d4', icon: CalendarIcon, label: 'Custom period', desc: 'Selected date range' }
};

const STATUS_META = {
    pending: { label: 'Pending', variant: 'muted' },
    applied: { label: 'Applied', variant: 'info' },
    interview: { label: 'Interview', variant: 'success' },
    rejected: { label: 'Rejected', variant: 'destructive' }
};

// ============== Interview detail dialog ==============

function InterviewTypeBadge({ type }) {
    if (!type) return <Badge variant="muted">Interview</Badge>;
    const variantMap = { Video: 'info', Phone: 'success', Onsite: 'warning' };
    const Icon = type === 'Video' ? Video : type === 'Phone' ? Phone : MapPin;
    return (
        <Badge variant={variantMap[type] || 'muted'} className="gap-1 capitalize">
            <Icon className="h-3 w-3" />
            {type}
        </Badge>
    );
}

function formatInterviewDateTime(detail) {
    const { scheduled_date, scheduled_time, timezone } = detail;
    if (!scheduled_date && !scheduled_time) return 'Not yet scheduled';
    const parts = [];
    if (scheduled_date) {
        try {
            const d = new Date(`${scheduled_date}T${scheduled_time || '00:00'}:00`);
            if (!isNaN(d)) {
                parts.push(
                    d.toLocaleDateString(undefined, {
                        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
                    })
                );
            } else {
                parts.push(scheduled_date);
            }
        } catch {
            parts.push(scheduled_date);
        }
    }
    if (scheduled_time) parts.push(scheduled_time);
    if (timezone) parts.push(timezone);
    return parts.join(' · ');
}

function ScheduledDetailsDialog({ periodKey, data, theme, open, onOpenChange }) {
    const Icon = theme?.icon || CalendarDays;
    const details = Array.isArray(data?.scheduledDetails) ? data.scheduledDetails : [];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden p-0">
                <DialogHeader className="border-b border-border px-6 py-4">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-accent text-accent-foreground">
                            <Icon className="h-5 w-5" />
                        </div>
                        <div>
                            <DialogTitle className="text-lg">
                                Scheduled Interviews — {data?.label}
                            </DialogTitle>
                            <DialogDescription>
                                {formatDateTime(data?.periodStart)} → {formatDateTime(data?.periodEnd)}
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <div className="overflow-y-auto px-6 py-5">
                    <div className="mb-4 flex items-center justify-between">
                        <p className="text-sm text-muted-foreground">
                            <strong className="text-foreground">{details.length}</strong>{' '}
                            interview{details.length === 1 ? '' : 's'} found
                        </p>
                        <DialogClose asChild>
                            <Button variant="outline" size="sm">
                                <X className="h-4 w-4" />
                                Close
                            </Button>
                        </DialogClose>
                    </div>

                    {details.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
                            <Inbox className="h-10 w-10 text-muted-foreground" />
                            <div>
                                <h3 className="font-semibold">No scheduled interviews</h3>
                                <p className="text-sm text-muted-foreground">
                                    There are no interviews with a "scheduled" status in this period.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {details.map((d) => (
                                <Card key={d.interview_id}>
                                    <CardContent className="space-y-3 p-4">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <h4 className="text-base font-semibold">
                                                    {d.job_role || 'Role not specified'}
                                                    <span className="text-primary"> @ {d.company_name}</span>
                                                </h4>
                                            </div>
                                            <InterviewTypeBadge type={d.interview_type} />
                                        </div>

                                        <div className="space-y-2 text-sm">
                                            <div className="flex items-start gap-3">
                                                <CalendarIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                <span>{formatInterviewDateTime(d)}</span>
                                            </div>

                                            {d.interviewer_name && (
                                                <div className="flex items-start gap-3">
                                                    <User className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                    <span>{d.interviewer_name}</span>
                                                </div>
                                            )}

                                            {d.location && (
                                                <div className="flex items-start gap-3">
                                                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                    <span>{d.location}</span>
                                                </div>
                                            )}

                                            {d.meeting_link && (
                                                <div className="flex items-start gap-3">
                                                    <LinkIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                    <a
                                                        href={d.meeting_link}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-primary underline-offset-2 hover:underline"
                                                    >
                                                        Open meeting link
                                                    </a>
                                                </div>
                                            )}

                                            {d.core_skills && (
                                                <div className="flex items-start gap-3">
                                                    <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {d.core_skills
                                                            .split(/[,;|]/)
                                                            .map((s) => s.trim())
                                                            .filter(Boolean)
                                                            .map((skill) => (
                                                                <Badge key={skill} variant="secondary">
                                                                    {skill}
                                                                </Badge>
                                                            ))}
                                                    </div>
                                                </div>
                                            )}

                                            {d.notes && (
                                                <div className="flex items-start gap-3">
                                                    <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                    <span className="text-muted-foreground">{d.notes}</span>
                                                </div>
                                            )}

                                            <div className="flex items-start gap-3">
                                                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                                <span className="text-xs text-muted-foreground">
                                                    Applied {d.applied_at ? formatDateTime(d.applied_at.replace(' ', 'T') + 'Z') : '—'}
                                                </span>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ============== KPI tile ==============

function DashboardKpiStrip({ metrics }) {
    const accentMap = {
        primary: 'text-primary',
        success: 'text-success',
        info: 'text-info',
        warning: 'text-warning'
    };

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {metrics.map(({ icon: Icon, accent: tone, value, label, sublabel, onClick, interactive }) => {
                const inner = (
                    <>
                        <div className={cn('mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-secondary', accentMap[tone])}>
                            <Icon className="h-4 w-4" />
                        </div>
                        <p className="font-display text-2xl font-semibold leading-none text-foreground">{value}</p>
                        <p className="mt-1 text-xs font-medium text-foreground/80">{label}</p>
                        {sublabel && (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">{sublabel}</p>
                        )}
                    </>
                );

                const cls = 'rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/30';

                if (interactive && onClick) {
                    return (
                        <button key={label} type="button" onClick={onClick} className={cls}>
                            {inner}
                        </button>
                    );
                }
                return (
                    <div key={label} className={cls}>
                        {inner}
                    </div>
                );
            })}
        </div>
    );
}

// ============== Volume charts live in dashboard/VolumeCharts.jsx ==============

// ============== Per-user breakdown table ==============

function UserBreakdownTable({
    users,
    selectedUserId,
    activePeriodLabel
}) {
    if (!users || users.length === 0) {
        return (
            <div className="rounded-md border border-dashed border-border bg-card/40 p-6 text-center text-sm text-muted-foreground">
                No users with assigned profiles in the current scope.
            </div>
        );
    }

    return (
        <div className="overflow-x-auto rounded-md border border-border">
            <Table>
                <TableHeader>
                    <TableRow className="bg-accent/40">
                        <TableHead>User</TableHead>
                        <TableHead className="text-center">Profiles</TableHead>
                        <TableHead className="text-center">
                            Pending
                            <div className="text-[10px] font-normal text-muted-foreground/70">all time</div>
                        </TableHead>
                        <TableHead className="text-center">
                            Applied
                            <div className="text-[10px] font-normal text-muted-foreground/70">all time</div>
                        </TableHead>
                        <TableHead className="text-center">
                            Interview
                            <div className="text-[10px] font-normal text-muted-foreground/70">all time</div>
                        </TableHead>
                        <TableHead className="text-center">
                            Rejected
                            <div className="text-[10px] font-normal text-muted-foreground/70">all time</div>
                        </TableHead>
                        <TableHead className="text-center">
                            Total
                            <div className="text-[10px] font-normal text-muted-foreground/70">all time</div>
                        </TableHead>
                        <TableHead className="text-center">
                            In Period
                            <div className="text-[10px] font-normal text-muted-foreground/70">{activePeriodLabel}</div>
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {users.map((u) => {
                        const isActive = selectedUserId && Number(selectedUserId) === u.id;
                        const ap = u.activePeriod;
                        return (
                            <TableRow
                                key={u.id}
                                className={cn(isActive && 'bg-primary/10 ring-1 ring-primary/30')}
                            >
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold">{u.username}</span>
                                        {isActive && (
                                            <Badge variant="default" className="text-xs">Selected</Badge>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell className="text-center text-muted-foreground">
                                    {u.profileCount ?? '—'}
                                </TableCell>
                                <TableCell className="text-center">
                                    <Badge variant={STATUS_META.pending.variant}>{u.statuses.pending}</Badge>
                                </TableCell>
                                <TableCell className="text-center">
                                    <Badge variant={STATUS_META.applied.variant}>{u.statuses.applied}</Badge>
                                </TableCell>
                                <TableCell className="text-center">
                                    <Badge variant={STATUS_META.interview.variant}>{u.statuses.interview}</Badge>
                                </TableCell>
                                <TableCell className="text-center">
                                    <Badge variant={STATUS_META.rejected.variant}>{u.statuses.rejected}</Badge>
                                </TableCell>
                                <TableCell className="text-center font-semibold">
                                    {u.statuses.total}
                                </TableCell>
                                <TableCell className="text-center">
                                    {ap ? (
                                        <div className="inline-flex flex-col items-center gap-0.5">
                                            <span className="text-sm font-semibold">
                                                {ap.appliedCount} <span className="text-xs text-muted-foreground">applied</span>
                                            </span>
                                            <span className="text-xs text-info">
                                                {ap.repliedCount ?? 0} replied
                                            </span>
                                            <span className="text-xs text-success">
                                                {ap.scheduledCount} scheduled
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

// ============== Per-link / per-application breakdown ==============
//
// Renders the new linkBreakdown block returned by /admin/stats:
//   { totalLinks, totalApplications, byUser, byProfile, rows: [{
//       linkId, userId, username, profileId, profileName, linkedSince,
//       applicationCount, applications: [...] }] }
//
// Each "applications[]" entry has per-application counts in the admin's
// active period: { id, company_name, job_role, status, appliedCount,
// scheduledCount, repliedCount }. The component renders a top
// summary (totals), the byUser / byProfile roll-ups, and an
// expandable link list. Expanded links list their application
// contributions one per row so the admin can audit "every user ×
// every profile × every link" in one view.

function LinkBreakdownTable({ linkBreakdown, activePeriodLabel }) {
    const [openLinkIds, setOpenLinkIds] = useState(new Set());
    if (!linkBreakdown) return null;

    const {
        totalLinks = 0,
        totalApplications = 0,
        byUser = [],
        byProfile = [],
        rows = []
    } = linkBreakdown;

    const toggle = (linkId) => {
        setOpenLinkIds((prev) => {
            const next = new Set(prev);
            if (next.has(linkId)) next.delete(linkId);
            else next.add(linkId);
            return next;
        });
    };

    return (
        <div className="space-y-4">
            {/* Roll-up tiles */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-md border border-border bg-card/40 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Total user ↔ profile links
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-2xl font-bold text-primary">
                        <LinkIcon className="h-5 w-5" />
                        {totalLinks}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                        Every user × every profile assignment, regardless of period
                    </div>
                </div>
                <div className="rounded-md border border-border bg-card/40 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Applications in active period
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-2xl font-bold text-info">
                        <Activity className="h-5 w-5" />
                        {rows.reduce((acc, r) => acc + (r.applications?.length || 0), 0)}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                        Across every link, in {activePeriodLabel || 'the selected period'}
                    </div>
                </div>
                <div className="rounded-md border border-border bg-card/40 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Applications (lifetime)
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-2xl font-bold text-success">
                        <Inbox className="h-5 w-5" />
                        {totalApplications}
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                        Total apps tied to a user via a profile link
                    </div>
                </div>
            </div>

            {/* byUser + byProfile side-by-side mini-tables */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="overflow-x-auto rounded-md border border-border">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-accent/40">
                                <TableHead>User</TableHead>
                                <TableHead className="text-center">Links</TableHead>
                                <TableHead className="text-center">Profiles</TableHead>
                                <TableHead className="text-center">Applications</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {byUser.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={4} className="text-center text-xs text-muted-foreground">
                                        No users with assigned profiles.
                                    </TableCell>
                                </TableRow>
                            ) : byUser.map((u) => (
                                <TableRow key={u.userId}>
                                    <TableCell className="font-medium">{u.username}</TableCell>
                                    <TableCell className="text-center">
                                        <Badge variant="muted">{u.linkCount}</Badge>
                                    </TableCell>
                                    <TableCell className="text-center">
                                        <Badge variant="muted">{u.profileCount}</Badge>
                                    </TableCell>
                                    <TableCell className="text-center font-semibold text-primary">
                                        {u.applicationCount}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>

                <div className="overflow-x-auto rounded-md border border-border">
                    <Table>
                        <TableHeader>
                            <TableRow className="bg-accent/40">
                                <TableHead>Profile</TableHead>
                                <TableHead className="text-center">Linked users</TableHead>
                                <TableHead className="text-center">Applications</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {byProfile.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={3} className="text-center text-xs text-muted-foreground">
                                        No profiles linked yet.
                                    </TableCell>
                                </TableRow>
                            ) : byProfile.map((p) => (
                                <TableRow key={p.profileId}>
                                    <TableCell className="font-medium">{p.profileName}</TableCell>
                                    <TableCell className="text-center">
                                        <Badge variant="muted">{p.linkCount}</Badge>
                                    </TableCell>
                                    <TableCell className="text-center font-semibold text-primary">
                                        {p.applicationCount}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </div>

            {/* Per-link expandable rows */}
            <div className="overflow-x-auto rounded-md border border-border">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-accent/40">
                            <TableHead className="w-8"></TableHead>
                            <TableHead>User</TableHead>
                            <TableHead>Profile</TableHead>
                            <TableHead className="text-center">Link ID</TableHead>
                            <TableHead className="text-center">Linked since</TableHead>
                            <TableHead className="text-center">Applications (lifetime)</TableHead>
                            <TableHead className="text-center">In active period</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={7} className="text-center text-xs text-muted-foreground">
                                    No user↔profile links exist in the current scope.
                                </TableCell>
                            </TableRow>
                        ) : rows.map((r) => {
                            const isOpen = openLinkIds.has(r.linkId);
                            const apps = r.applications || [];
                            const periodAppCount = apps.length;
                            return (
                                <Fragment key={r.linkId}>
                                    <TableRow
                                        className={cn(
                                            'cursor-pointer hover:bg-accent/40',
                                            isOpen && 'bg-accent/30'
                                        )}
                                        onClick={() => toggle(r.linkId)}
                                    >
                                        <TableCell className="text-center">
                                            {periodAppCount > 0 ? (
                                                <Badge variant="muted" className="text-[10px]">
                                                    {isOpen ? '−' : '+'}
                                                </Badge>
                                            ) : null}
                                        </TableCell>
                                        <TableCell className="font-medium">{r.username}</TableCell>
                                        <TableCell>{r.profileName}</TableCell>
                                        <TableCell className="text-center text-[11px] text-muted-foreground">
                                            #{r.linkId}
                                        </TableCell>
                                        <TableCell className="text-center text-xs text-muted-foreground">
                                            {r.linkedSince ? formatDateTime(r.linkedSince) : '—'}
                                        </TableCell>
                                        <TableCell className="text-center font-semibold text-primary">
                                            {r.applicationCount}
                                        </TableCell>
                                        <TableCell className="text-center">
                                            {periodAppCount > 0 ? (
                                                <Badge variant="default">{periodAppCount}</Badge>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">0</span>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                    {isOpen && periodAppCount > 0 && (
                                        <TableRow className="bg-card/30">
                                            <TableCell></TableCell>
                                            <TableCell colSpan={6} className="p-0">
                                                <div className="m-2 overflow-hidden rounded-md border border-border bg-background/40">
                                                    <Table>
                                                        <TableHeader>
                                                            <TableRow className="bg-accent/20">
                                                                <TableHead className="text-[10px]">App ID</TableHead>
                                                                <TableHead className="text-[10px]">Company / Role</TableHead>
                                                                <TableHead className="text-[10px]">Status</TableHead>
                                                                <TableHead className="text-[10px] text-center">Applied</TableHead>
                                                                <TableHead className="text-[10px] text-center">Scheduled</TableHead>
                                                                <TableHead className="text-[10px] text-center">Replied</TableHead>
                                                            </TableRow>
                                                        </TableHeader>
                                                        <TableBody>
                                                            {apps.map((app) => (
                                                                <TableRow key={app.id}>
                                                                    <TableCell className="text-[11px] text-muted-foreground">
                                                                        #{app.id}
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        <div className="text-xs font-medium">
                                                                            {app.company_name || '—'}
                                                                        </div>
                                                                        <div className="text-[10px] text-muted-foreground">
                                                                            {app.job_role || ''}
                                                                        </div>
                                                                    </TableCell>
                                                                    <TableCell>
                                                                        <Badge
                                                                            variant={STATUS_META[app.status]?.variant || 'muted'}
                                                                            className="text-[10px]"
                                                                        >
                                                                            {STATUS_META[app.status]?.label || app.status}
                                                                        </Badge>
                                                                    </TableCell>
                                                                    <TableCell className="text-center text-xs">
                                                                        {app.appliedCount}
                                                                    </TableCell>
                                                                    <TableCell className="text-center text-xs">
                                                                        {app.scheduledCount}
                                                                    </TableCell>
                                                                    <TableCell className="text-center text-xs">
                                                                        {app.repliedCount}
                                                                    </TableCell>
                                                                </TableRow>
                                                            ))}
                                                        </TableBody>
                                                    </Table>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </Fragment>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}

// ============== User-side compact lifetime view ==============

function UserLifetimeSummary({ users }) {
    if (!users || users.length === 0) return null;
    const me = users[0];
    const statuses = me.statuses || {};
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {['pending', 'applied', 'interview', 'rejected'].map((key) => {
                const meta = STATUS_META[key];
                const count = statuses[key] || 0;
                return (
                    <div key={key} className="rounded-xl border border-border/60 bg-background/30 p-4 text-center">
                        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                            {meta.label}
                        </div>
                        <div className="mt-2 font-display text-2xl font-semibold">{count}</div>
                    </div>
                );
            })}
            <div className="rounded-xl border border-primary/30 bg-primary/10 p-4 text-center">
                <div className="font-mono text-[10px] uppercase tracking-widest text-primary">Total</div>
                <div className="mt-2 font-display text-2xl font-semibold text-primary">{statuses.total || 0}</div>
            </div>
        </div>
    );
}

// ============== Main component ==============

/**
 * Shared dashboard body used by both admin and user dashboards.
 *
 * @param {Object} props
 *   - stats: the payload from /api/{user|admin}/stats
 *   - loading, error, onRefresh
 *   - scope: 'admin' | 'user'
 *   - filterProps (admin only): { period, customRange, userId, onPeriodChange,
 *       onCustomRangeChange, onUserChange, onReset, users, usersLoading }
 */
export default function StatsDashboard({
    stats,
    loading,
    error,
    onRefresh,
    scope,
    filterProps,
    extraHeaderActions,
    embedded = false,
    hideFilterBar = false,
    hideToolbar = false
}) {
    const [dialogPeriod, setDialogPeriod] = useState(null);
    const [userPeriodKey, setUserPeriodKey] = useState('week');

    const { generatedAt, generatedAtEST, periods, users, activePeriod, periodKey } = stats || {};
    const safeUsers = Array.isArray(users) ? users : [];
    const isAdmin = scope === 'admin';

    const resolvedActivePeriod = useMemo(() => {
        if (isAdmin) {
            if (activePeriod) return activePeriod;
            return periods?.week || {};
        }
        return periods?.[userPeriodKey] || periods?.week || {};
    }, [isAdmin, activePeriod, periods, userPeriodKey]);

    const resolvedPeriodKey = isAdmin ? (periodKey || '24h') : userPeriodKey;
    const periodTheme = PERIOD_THEMES[resolvedPeriodKey] || PERIOD_THEMES['7d'];

    const scopeLabel = useMemo(() => {
        if (!isAdmin) return null;
        if (!filterProps?.userId) return 'Org-wide';
        const userObj = safeUsers.find((u) => String(u.id) === String(filterProps.userId));
        return userObj ? userObj.username : 'Org-wide';
    }, [isAdmin, filterProps?.userId, safeUsers]);

    if (loading) {
        return (
            <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                    {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-28 rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-72 rounded-xl" />
                <div className="grid gap-4 md:grid-cols-2">
                    <Skeleton className="h-52 rounded-xl" />
                    <Skeleton className="h-52 rounded-xl" />
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                        <X className="h-6 w-6" />
                    </div>
                    <div>
                        <h3 className="font-semibold">Could not load statistics</h3>
                        <p className="text-sm text-muted-foreground">{error}</p>
                    </div>
                    <Button onClick={onRefresh}>Retry</Button>
                </CardContent>
            </Card>
        );
    }

    if (!stats) return null;

    const dailyBuckets = resolvedActivePeriod.dailyBuckets?.length
        ? resolvedActivePeriod.dailyBuckets
        : buildDailyBuckets(resolvedActivePeriod);

    const isWorkdayView =
        Array.isArray(resolvedActivePeriod.hourlyWorkday) &&
        (resolvedPeriodKey === 'workday' ||
            resolvedPeriodKey === '24h' ||
            (dailyBuckets.length > 0 && dailyBuckets.length <= 2));

    const kpiMetrics = [
        {
            icon: Send,
            accent: 'info',
            value: resolvedActivePeriod.appliedCount || 0,
            label: 'Applied',
            sublabel: periodTheme.label
        },
        {
            icon: MessageSquareReply,
            accent: 'info',
            value: resolvedActivePeriod.repliedCount || 0,
            label: 'Replied',
            sublabel:
                (resolvedActivePeriod.appliedCount || 0) > 0
                    ? `${Math.round(
                          ((resolvedActivePeriod.repliedCount || 0) /
                              (resolvedActivePeriod.appliedCount || 1)) *
                              100
                      )}% reply rate`
                    : 'no applications yet'
        },
        {
            icon: Target,
            accent: 'success',
            value: resolvedActivePeriod.scheduledCount || 0,
            label: 'Interviews',
            sublabel: periodTheme.label,
            interactive: (resolvedActivePeriod.scheduledCount || 0) > 0,
            onClick: () => setDialogPeriod(resolvedPeriodKey)
        },
        {
            icon: TrendingUp,
            accent: 'primary',
            value: `${resolvedActivePeriod.successRate || 0}%`,
            label: 'Success rate',
            sublabel:
                resolvedActivePeriod.appliedCount || resolvedActivePeriod.scheduledCount
                    ? 'applied → scheduled'
                    : 'no activity'
        },
        {
            icon: Trophy,
            accent: 'warning',
            value: resolvedActivePeriod.topTechStack || '—',
            label: 'Top stack',
            sublabel: resolvedActivePeriod.topTechStackCount
                ? `${resolvedActivePeriod.topTechStackCount} mentions`
                : 'from scheduled interviews'
        }
    ];

    return (
        <div className="space-y-5">
            {!embedded && (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
                        <p className="text-sm text-muted-foreground">
                            {isAdmin
                                ? 'Org-wide analytics with period and user filters'
                                : 'Your application progress across the workday, week, and month'}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {extraHeaderActions}
                        {!hideToolbar && (
                            <Button variant="outline" onClick={onRefresh}>
                                <RefreshCw className="h-4 w-4" />
                                Refresh
                            </Button>
                        )}
                    </div>
                </div>
            )}

            {embedded && !hideToolbar && (
                <div className="flex justify-end">
                    <Button variant="outline" size="sm" onClick={onRefresh}>
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                    </Button>
                </div>
            )}

            {isAdmin && filterProps && !hideFilterBar && (
                <FiltersBar
                    period={filterProps.period}
                    customRange={filterProps.customRange}
                    userId={filterProps.userId}
                    users={filterProps.users}
                    usersLoading={filterProps.usersLoading}
                    onPeriodChange={filterProps.onPeriodChange}
                    onCustomRangeChange={filterProps.onCustomRangeChange}
                    onUserChange={filterProps.onUserChange}
                    onReset={filterProps.onReset}
                    loading={loading}
                />
            )}

            {!isAdmin && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <PeriodPills
                        options={USER_PERIOD_OPTIONS}
                        value={userPeriodKey}
                        onChange={setUserPeriodKey}
                        disabled={loading}
                    />
                    <p className="font-mono text-[10px] text-muted-foreground">
                        {formatDateTime(resolvedActivePeriod.periodStart)} → {formatDateTime(resolvedActivePeriod.periodEnd)}
                    </p>
                </div>
            )}

            <DashboardKpiStrip metrics={kpiMetrics} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="lg:col-span-2">
                    <PrimaryActivityChart
                        isWorkday={isWorkdayView}
                        dailyBuckets={dailyBuckets}
                        hourlyBuckets={resolvedActivePeriod.hourlyWorkday || []}
                        periodStart={resolvedActivePeriod.periodStart}
                        periodEnd={resolvedActivePeriod.periodEnd}
                        scopeLabel={scopeLabel}
                    />
                </div>
                <ConversionFunnel
                    applied={resolvedActivePeriod.appliedCount || 0}
                    replied={resolvedActivePeriod.repliedCount || 0}
                    scheduled={resolvedActivePeriod.scheduledCount || 0}
                    onInterviewClick={() => setDialogPeriod(resolvedPeriodKey)}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <PeriodCompareChart periods={periods} />
                <TechStackChart
                    techStacks={resolvedActivePeriod.techStacks}
                    topStack={resolvedActivePeriod.topTechStack}
                />
            </div>

            {!isAdmin && (
                <Card className="border-border bg-card">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 font-display text-base">
                            <User className="h-4 w-4" />
                            Lifetime pipeline
                        </CardTitle>
                        <CardDescription>Status counts across your assigned profiles</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <UserLifetimeSummary users={safeUsers} />
                    </CardContent>
                </Card>
            )}

            {isAdmin && (
                <Card className="border-border bg-card">
                    <CardHeader className="pb-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 font-display text-base">
                                    <Users className="h-4 w-4" />
                                    Team breakdown
                                </CardTitle>
                                <CardDescription>
                                    Per-user counts for {PERIOD_THEMES[resolvedPeriodKey]?.label?.toLowerCase() || 'selected period'}
                                </CardDescription>
                            </div>
                            {filterProps?.userId ? (
                                <Badge variant="default" className="gap-1">
                                    <Filter className="h-3 w-3" />
                                    {scopeLabel}
                                </Badge>
                            ) : (
                                <Badge variant="secondary" className="gap-1">
                                    <ListChecks className="h-3 w-3" />
                                    {safeUsers.length} users
                                </Badge>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        <UserBreakdownTable
                            users={safeUsers}
                            selectedUserId={filterProps?.userId}
                            activePeriodLabel={PERIOD_THEMES[resolvedPeriodKey]?.label || 'selected'}
                        />
                    </CardContent>
                </Card>
            )}

            {isAdmin && stats?.linkBreakdown && (
                <DashboardDetailsSection
                    title="Per-link breakdown"
                    description="User × profile link details — expand when you need audit-level data"
                    badge={(
                        <Badge variant="secondary" className="gap-1">
                            {stats.linkBreakdown.totalLinks} links
                        </Badge>
                    )}
                >
                    <LinkBreakdownTable
                        linkBreakdown={stats.linkBreakdown}
                        activePeriodLabel={PERIOD_THEMES[resolvedPeriodKey]?.label || 'selected period'}
                    />
                </DashboardDetailsSection>
            )}

            {generatedAt && (
                <p className="text-center text-xs text-muted-foreground">
                    <CheckCircle2 className="mr-1 inline h-3 w-3" />
                    Last updated: {formatDateTime(generatedAt)}
                    {generatedAtEST && (
                        <span className="ml-1">({generatedAtEST.replace('T', ' ')})</span>
                    )}
                </p>
            )}

            <ScheduledDetailsDialog
                periodKey={dialogPeriod}
                data={dialogPeriod === resolvedPeriodKey ? resolvedActivePeriod : null}
                theme={dialogPeriod ? PERIOD_THEMES[dialogPeriod] : null}
                open={!!dialogPeriod}
                onOpenChange={(open) => !open && setDialogPeriod(null)}
            />
        </div>
    );
}

// ============== Helpers ==============

/**
 * Build daily aggregation buckets from the active period payload.
 * The server returns hourly buckets ONLY for `workday`; for 7d / 30d /
 * custom ranges we derive a coarse daily timeline from the periodStart
 * and periodEnd so the chart stays informative.
 *
 * Each bucket: { date, label, applied: 0, scheduled: 0 }
 *
 * The summary line shows the period's applied total. For 31+ day ranges
 * we reduce label density to keep the SVG readable.
 */
function buildDailyBuckets(activePeriod) {
    if (!activePeriod?.periodStart || !activePeriod?.periodEnd) return [];
    const start = new Date(activePeriod.periodStart);
    const end = new Date(activePeriod.periodEnd);
    const days = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cursor <= last) {
        days.push({
            date: cursor.toISOString().slice(0, 10),
            label: cursor.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            applied: 0,
            replied: 0,
            scheduled: 0
        });
        cursor.setDate(cursor.getDate() + 1);
    }
    if (days.length === 0) return days;

    const details = Array.isArray(activePeriod.scheduledDetails)
        ? activePeriod.scheduledDetails
        : [];
    const counts = {};
    for (const d of details) {
        if (!d.scheduled_date) continue;
        counts[d.scheduled_date] = (counts[d.scheduled_date] || 0) + 1;
    }
    for (const day of days) {
        day.scheduled = counts[day.date] || 0;
    }

    if (activePeriod.appliedCount > 0 && days.length > 0) {
        days[days.length - 1].applied = activePeriod.appliedCount;
    }

    if (days.length > 31) {
        return days.map((d, i) => ({
            ...d,
            label: i % Math.ceil(days.length / 14) === 0 ? d.label : ''
        }));
    }
    return days;
}
