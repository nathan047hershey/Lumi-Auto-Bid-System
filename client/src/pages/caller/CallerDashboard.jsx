import { useState, useEffect } from 'react';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import {
    RefreshCw,
    Phone,
    Inbox,
    Video,
    MapPin,
    User,
    Mail,
    Calendar as CalendarIcon,
    Clock,
    StickyNote,
    Link as LinkIcon,
    Download,
    AlertCircle,
    PhoneCall,
    Building2,
    Briefcase
} from 'lucide-react';
import { callerAPI } from '@/api';
import { cn, formatDateTime } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

const STATUS_VARIANT = {
    pending: 'muted',
    applied: 'info',
    interview: 'success',
    rejected: 'destructive'
};

const INTERVIEW_TYPE_VARIANT = {
    Video: 'info',
    Phone: 'success',
    Onsite: 'warning'
};

function InterviewBadge({ type }) {
    if (!type) return <Badge variant="muted">Interview</Badge>;
    const Icon = type === 'Video' ? Video : type === 'Phone' ? Phone : MapPin;
    return (
        <Badge variant={INTERVIEW_TYPE_VARIANT[type] || 'muted'} className="gap-1 capitalize">
            <Icon className="h-3 w-3" />
            {type}
        </Badge>
    );
}

function CallerDashboard() {
    const [applications, setApplications] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [viewingApp, setViewingApp] = useState(null);

    useEffect(() => {
        fetchApplications();
    }, []);

    const fetchApplications = async () => {
        try {
            setLoading(true);
            setError('');
            const response = await callerAPI.getApplications();
            setApplications(Array.isArray(response.data) ? response.data : []);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to fetch applications');
            setApplications([]);
        } finally {
            setLoading(false);
        }
    };

    const handleDownloadResume = async (filename) => {
        try {
            await callerAPI.downloadResume(filename);
        } catch (err) {
            alert('Failed to download resume: ' + (err.response?.data?.error || err.message));
        }
    };

    const formatScheduledDate = (dateString) => {
        if (!dateString) return null;
        if (dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const [year, month, day] = dateString.split('-');
            return new Date(+year, +month - 1, +day).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        }
        return dateString;
    };

    return (
        <AppPage
            icon={PhoneCall}
            title="My Assigned Applications"
            description="Calls to make and applications to follow up on"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Assigned applications</p>
                            <p className="truncate text-xs text-white/40">
                                {loading
                                    ? 'Loading…'
                                    : `${applications.length} application${applications.length === 1 ? '' : 's'}`}
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" onClick={fetchApplications} disabled={loading}>
                            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                />

                {error && (
                    <div className="flex items-start gap-2 rounded-xl border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-red-200">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {loading ? (
                    <div className="space-y-2">
                        {[...Array(4)].map((_, i) => (
                            <Skeleton key={i} className="h-24 w-full rounded-2xl" />
                        ))}
                    </div>
                ) : applications.length === 0 ? (
                    <Card>
                        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                                <Inbox className="h-7 w-7" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-white/90">No Applications Assigned</h3>
                                <p className="text-sm text-white/45">
                                    You don't have any applications assigned yet.
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-2">
                        {applications.map((app) => (
                            <div
                                key={app.id}
                                className="group relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)]"
                            >
                                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0 flex-1 space-y-2">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <h3 className="font-semibold text-white/90">
                                                {app.first_name} {app.last_name}
                                            </h3>
                                            <Badge variant={STATUS_VARIANT[app.status] || 'muted'} className="capitalize">
                                                {app.status}
                                            </Badge>
                                            {app.interview_type && <InterviewBadge type={app.interview_type} />}
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
                                            <span className="inline-flex items-center gap-1">
                                                <Mail className="h-3 w-3" />
                                                {app.email || '—'}
                                            </span>
                                            <span className="inline-flex min-w-0 items-center gap-1">
                                                <Building2 className="h-3 w-3 shrink-0" />
                                                {app.job_url ? (
                                                    <a
                                                        href={app.job_url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="truncate text-white/70 hover:text-primary hover:underline"
                                                        title={app.job_url}
                                                    >
                                                        {app.company_name || '—'}
                                                    </a>
                                                ) : (
                                                    <span>{app.company_name || '—'}</span>
                                                )}
                                            </span>
                                            <span className="inline-flex items-center gap-1">
                                                <Briefcase className="h-3 w-3" />
                                                {app.job_role || '—'}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/35">
                                            {app.scheduled_date ? (
                                                <span className="inline-flex items-center gap-1">
                                                    <CalendarIcon className="h-3 w-3" />
                                                    {formatScheduledDate(app.scheduled_date)}
                                                </span>
                                            ) : (
                                                <span className="text-white/30">Not scheduled</span>
                                            )}
                                            {app.scheduled_time && (
                                                <span className="inline-flex items-center gap-1">
                                                    <Clock className="h-3 w-3" />
                                                    {app.scheduled_time}{app.timezone && ` (${app.timezone})`}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-9 shrink-0"
                                        onClick={() => setViewingApp(app)}
                                    >
                                        View
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <Dialog open={!!viewingApp} onOpenChange={(open) => !open && setViewingApp(null)}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>Application Details</DialogTitle>
                        <DialogDescription>
                            {viewingApp?.first_name} {viewingApp?.last_name} · {viewingApp?.company_name}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Candidate</Label>
                                <p className="font-medium">
                                    {viewingApp?.first_name} {viewingApp?.last_name}
                                </p>
                                <p className="text-sm text-muted-foreground">{viewingApp?.email}</p>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Company / Role</Label>
                                <p className="font-medium">{viewingApp?.company_name}</p>
                                <p className="text-sm text-muted-foreground">{viewingApp?.job_role}</p>
                                {viewingApp?.job_url && (
                                    <a
                                        href={viewingApp.job_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                    >
                                        <LinkIcon className="h-3.5 w-3.5" />
                                        Open job posting
                                    </a>
                                )}
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Status</Label>
                                <Badge variant={STATUS_VARIANT[viewingApp?.status] || 'muted'} className="capitalize">
                                    {viewingApp?.status}
                                </Badge>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Created</Label>
                                <p className="text-sm">{formatDateTime(viewingApp?.created_at)}</p>
                            </div>
                        </div>

                        {(viewingApp?.scheduled_date || viewingApp?.interview_type) && (
                            <div className="space-y-2 rounded-xl border border-white/[0.07] bg-black/20 p-4">
                                <h4 className="flex items-center gap-2 font-semibold">
                                    <CalendarIcon className="h-4 w-4 text-primary" />
                                    Interview
                                </h4>
                                <div className="grid gap-2 text-sm md:grid-cols-2">
                                    {viewingApp?.scheduled_date && (
                                        <div className="flex items-center gap-2">
                                            <CalendarIcon className="h-3 w-3 text-muted-foreground" />
                                            {formatScheduledDate(viewingApp.scheduled_date)}
                                        </div>
                                    )}
                                    {viewingApp?.scheduled_time && (
                                        <div className="flex items-center gap-2">
                                            <Clock className="h-3 w-3 text-muted-foreground" />
                                            {viewingApp.scheduled_time} {viewingApp?.timezone && `(${viewingApp.timezone})`}
                                        </div>
                                    )}
                                    {viewingApp?.interview_type && (
                                        <div className="flex items-center gap-2">
                                            <Phone className="h-3 w-3 text-muted-foreground" />
                                            {viewingApp.interview_type}
                                        </div>
                                    )}
                                    {viewingApp?.interviewer_name && (
                                        <div className="flex items-center gap-2">
                                            <User className="h-3 w-3 text-muted-foreground" />
                                            {viewingApp.interviewer_name}
                                        </div>
                                    )}
                                    {viewingApp?.location && (
                                        <div className="flex items-center gap-2">
                                            <MapPin className="h-3 w-3 text-muted-foreground" />
                                            {viewingApp.location}
                                        </div>
                                    )}
                                    {viewingApp?.meeting_link && (
                                        <a
                                            href={viewingApp.meeting_link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 text-primary hover:underline"
                                        >
                                            <LinkIcon className="h-3 w-3" />
                                            Open meeting
                                        </a>
                                    )}
                                </div>
                                {viewingApp?.interview_notes && (
                                    <div className="mt-2 flex items-start gap-2 text-sm">
                                        <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                                        <span className="text-muted-foreground">{viewingApp.interview_notes}</span>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="space-y-1">
                            <Label className="text-xs text-muted-foreground">Job Description</Label>
                            <div className="max-h-48 overflow-y-auto rounded-xl border border-white/[0.07] bg-black/25 p-3 text-sm">
                                <pre className="whitespace-pre-wrap font-sans">{viewingApp?.job_description || '—'}</pre>
                            </div>
                        </div>
                    </div>

                    <DialogFooter>
                        {viewingApp?.resume_filename && (
                            <Button
                                variant="outline"
                                onClick={() => handleDownloadResume(viewingApp.resume_filename)}
                            >
                                <Download className="h-4 w-4" />
                                Download Resume
                            </Button>
                        )}
                        <Button variant="gradient" onClick={() => setViewingApp(null)}>
                            Close
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AppPage>
    );
}

export default CallerDashboard;
