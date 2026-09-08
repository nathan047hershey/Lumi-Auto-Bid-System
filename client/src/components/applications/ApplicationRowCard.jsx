import {
    Calendar,
    ExternalLink,
    Eye,
    FileText,
    Trash2,
    User,
    UserMinus
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import { milestoneLabel } from '@/components/MilestoneList';
import { cn } from '@/lib/utils';

const APPLICATION_STATUS_META = {
    pending: { label: 'Pending', variant: 'secondary' },
    applied: { label: 'Applied', variant: 'default' },
    interview: { label: 'Interview', variant: 'outline' },
    rejected: { label: 'Rejected', variant: 'destructive' }
};

const REQUEST_STATUS_META = {
    requested: { label: 'Requested', variant: 'secondary' },
    scheduled: { label: 'Scheduled', variant: 'default' },
    completed: { label: 'Completed', variant: 'outline' },
    cancelled: { label: 'Cancelled', variant: 'destructive' }
};

const STATE_OPTIONS = [
    { value: 'in_progress', label: 'In progress' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'rejected', label: 'Rejected' }
];

function interviewLabel(app) {
    if (app.interview_request_id) {
        const date = app.request_scheduled_date || 'TBD';
        const time = app.request_scheduled_time ? ` · ${app.request_scheduled_time}` : '';
        return `${date}${time}`;
    }
    if (app.interview_id) {
        const date = app.scheduled_date || 'Scheduled';
        const time = app.scheduled_time ? ` · ${app.scheduled_time}` : '';
        return `${date}${time}`;
    }
    return 'Not scheduled';
}

/**
 * Compact application row — same density as Job Links.
 */
export default function ApplicationRowCard({
    app,
    variant = 'admin',
    selected = false,
    onSelect,
    title,
    onView,
    onInterview,
    onAssignCaller,
    onDelete,
    onStateChange,
    onUnassignCaller,
    onDownloadResume,
    onDownloadGeneratedResume,
    onPreviewResume,
    onStatusChange,
    onCaptureInterview,
    interviewRequest,
    onViewJobDescription
}) {
    const statusMeta = APPLICATION_STATUS_META[app.status] || { label: app.status || '—', variant: 'secondary' };
    const requestMeta = app.interview_request_id
        ? REQUEST_STATUS_META[app.interview_request_status] || { label: app.interview_request_status, variant: 'secondary' }
        : null;
    const displayName = title
        || (app.profile_name
            ? app.profile_name
            : `${app.first_name || ''} ${app.last_name || ''}`.trim())
        || 'Application';

    const userReqMeta = interviewRequest?.status
        ? REQUEST_STATUS_META[interviewRequest.status] || { label: interviewRequest.status, variant: 'secondary' }
        : null;

    const companyRole = [app.company_name, app.job_role].filter(Boolean).join(' · ') || '—';

    return (
        <article
            className={cn(
                'group relative flex overflow-hidden rounded-xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] transition-colors',
                'hover:border-primary/30 hover:bg-[hsl(222_24%_11%/0.9)]',
                selected && 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
            )}
        >
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 sm:gap-2.5 sm:px-2.5">
                {onSelect ? (
                    <Checkbox
                        checked={selected}
                        onCheckedChange={(checked) => onSelect(!!checked)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${displayName}`}
                        className="shrink-0"
                    />
                ) : null}

                {variant === 'admin' ? (
                    <Badge variant={statusMeta.variant} className="h-5 shrink-0 px-1.5 text-[9px] font-bold uppercase">
                        {statusMeta.label}
                    </Badge>
                ) : app.state && app.state !== 'in_progress' ? (
                    <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[9px] font-bold uppercase">
                        {app.state}
                    </Badge>
                ) : (
                    <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                        <Select
                            value={app.status || 'pending'}
                            onValueChange={(value) => onStatusChange?.(app.id, value)}
                        >
                            <SelectTrigger className="h-6 w-[5.75rem] border-white/10 bg-black/20 px-1.5 text-[9px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="pending">Pending</SelectItem>
                                <SelectItem value="applied">Applied</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                )}

                <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={onView || (() => onViewJobDescription?.(app))}
                >
                    <p className="truncate text-[13px] font-semibold leading-tight text-white group-hover:text-primary">
                        {displayName}
                    </p>
                    <p className="truncate text-[11px] leading-tight text-white/45">
                        {app.job_url ? (
                            <a
                                href={app.job_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex max-w-full items-center gap-1 hover:text-primary hover:underline"
                                onClick={(e) => e.stopPropagation()}
                                title={app.job_url}
                            >
                                <span className="truncate">{companyRole}</span>
                                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" />
                            </a>
                        ) : (
                            companyRole
                        )}
                    </p>
                </button>

                {variant === 'admin' ? (
                    <>
                        <div
                            className="hidden shrink-0 items-center gap-1 lg:flex"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <Badge variant="secondary" className="h-5 max-w-[7rem] truncate px-1.5 text-[9px]">
                                {app.latest_milestone?.kind
                                    ? milestoneLabel(app.latest_milestone.kind)
                                    : 'No milestone'}
                            </Badge>
                            <Select
                                value={app.state || 'in_progress'}
                                onValueChange={(value) => onStateChange(app.id, value, app)}
                            >
                                <SelectTrigger className="h-6 w-[7rem] border-white/10 bg-black/20 px-1.5 text-[9px]">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {STATE_OPTIONS.map((opt) => (
                                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="hidden min-w-0 max-w-[9rem] shrink-0 xl:block">
                            <p className="truncate text-[10px] text-white/35">
                                Int · {interviewLabel(app)}
                            </p>
                            <p className="truncate text-[10px] text-white/35">
                                {app.caller_username ? (
                                    <span className="inline-flex items-center gap-1">
                                        Caller · {app.caller_username}
                                        {onUnassignCaller ? (
                                            <button
                                                type="button"
                                                className="text-destructive hover:opacity-80"
                                                title="Unassign"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onUnassignCaller(app, app.caller_id);
                                                }}
                                            >
                                                <UserMinus className="h-3 w-3" />
                                            </button>
                                        ) : null}
                                    </span>
                                ) : (
                                    'Caller · —'
                                )}
                            </p>
                        </div>

                        {requestMeta ? (
                            <Badge variant={requestMeta.variant} className="hidden h-5 shrink-0 px-1.5 text-[9px] md:inline-flex">
                                {requestMeta.label}
                            </Badge>
                        ) : null}
                        {app.assigned_users ? (
                            <Badge variant="outline" className="hidden h-5 max-w-[5rem] shrink-0 truncate px-1.5 text-[9px] 2xl:inline-flex">
                                {app.assigned_users}
                            </Badge>
                        ) : null}
                    </>
                ) : (
                    <>
                        {userReqMeta ? (
                            <Badge variant={userReqMeta.variant} className="hidden h-5 shrink-0 px-1.5 text-[9px] sm:inline-flex">
                                {userReqMeta.label}
                            </Badge>
                        ) : null}
                        <Button
                            variant="outline"
                            size="sm"
                            className="hidden h-7 shrink-0 border-white/10 bg-black/20 px-2 text-[10px] sm:inline-flex"
                            onClick={(e) => {
                                e.stopPropagation();
                                onCaptureInterview?.(app);
                            }}
                        >
                            <Calendar className="mr-1 h-3 w-3" />
                            {interviewRequest ? 'Request' : 'Interview'}
                        </Button>
                    </>
                )}

                <div
                    className="ml-auto flex shrink-0 items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                >
                    {variant === 'admin' ? (
                        <>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onView} title="View">
                                <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onInterview} title="Interview">
                                <Calendar className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onAssignCaller} title="Assign caller">
                                <User className="h-3.5 w-3.5" />
                            </Button>
                            {(app.resume_filename || app.draft_html) && onPreviewResume ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    onClick={() => onPreviewResume(app)}
                                    title="Preview CV"
                                >
                                    <FileText className="h-3.5 w-3.5" />
                                </Button>
                            ) : null}
                            {app.resume_filename && onDownloadResume ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="hidden h-7 px-1.5 text-[9px] font-semibold lg:inline-flex"
                                    onClick={() => onDownloadResume(app.resume_filename)}
                                    title="DOCX"
                                >
                                    DOCX
                                </Button>
                            ) : null}
                            {app.resume_filename && onDownloadGeneratedResume ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="hidden h-7 px-1.5 text-[9px] font-semibold xl:inline-flex"
                                    onClick={() => onDownloadGeneratedResume(app)}
                                >
                                    Gen
                                </Button>
                            ) : null}
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive"
                                onClick={onDelete}
                                title="Delete"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                        </>
                    ) : (
                        <>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 sm:hidden"
                                onClick={() => onCaptureInterview?.(app)}
                                title="Interview"
                            >
                                <Calendar className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => onViewJobDescription?.(app)}
                                title="View job description"
                            >
                                <Eye className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => onDownloadResume?.(app.resume_filename)}
                                disabled={!app.resume_filename}
                                title={app.resume_filename ? 'Download resume' : 'No resume'}
                            >
                                <FileText className="h-3.5 w-3.5" />
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </article>
    );
}
