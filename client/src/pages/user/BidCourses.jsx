import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useLocation, useNavigate } from 'react-router-dom';
import { RefreshCw, Camera, FileText, Download } from 'lucide-react';
import { userAPI, adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    ModalTabs,
    ModalTabsContent,
    ModalTabsList,
    ModalTabsTrigger
} from '@/components/ui/modal-tabs';
import {
    failureLabel,
    isFailureEvent,
    courseRunStatus,
    lastStatusEvent,
    formatElapsedSince,
    sortScreenshotsForReview,
    screenshotStageLabel,
    runStatusBadgeClass,
    runStatusRowClass,
    runStatusBannerClass,
    runStatusHeadline
} from '@/lib/bidCourseFailure';
import { cn } from '@/lib/utils';

function AuthShot({ courseId, filename, stage, isAdmin }) {
    const [src, setSrc] = useState('');
    const [err, setErr] = useState('');
    const label = screenshotStageLabel(stage);
    useEffect(() => {
        let alive = true;
        let objectUrl = '';
        (async () => {
            try {
                const api = isAdmin ? adminAPI : userAPI;
                const { data } = await api.getBidCourseScreenshot(courseId, filename);
                if (!(data instanceof Blob) || data.size < 32) {
                    throw new Error('empty image');
                }
                objectUrl = URL.createObjectURL(data);
                if (alive) {
                    setSrc(objectUrl);
                    setErr('');
                }
            } catch (e) {
                if (alive) {
                    setSrc('');
                    setErr(e?.message || 'load failed');
                }
            }
        })();
        return () => {
            alive = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [courseId, filename, isAdmin]);
    if (!src) {
        return (
            <div className="flex min-h-[16rem] items-center justify-center rounded border border-dashed px-3 py-6 text-sm text-muted-foreground">
                {label}
                {err ? ` · ${err}` : ' · loading…'}
            </div>
        );
    }
    return (
        <figure className="space-y-1">
            <img
                src={src}
                alt={label}
                className="max-h-[min(60vh,36rem)] min-h-[18rem] w-full rounded border object-contain object-top bg-black/10"
            />
            <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
        </figure>
    );
}

function BidCourses({ embedded = false }) {
    const { id } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const isAdmin = location.pathname.startsWith('/admin');
    const basePath = isAdmin ? '/admin/performance' : '/user/performance';
    const coursePath = (courseId) => `${basePath}/courses/${courseId}`;
    const api = isAdmin ? adminAPI : userAPI;

    const [courses, setCourses] = useState([]);
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [pageTab, setPageTab] = useState(id ? 'form' : 'courses');

    useEffect(() => {
        setPageTab(id ? 'form' : 'courses');
    }, [id]);

    const loadList = useCallback(async () => {
        try {
            setLoading(true);
            setError('');
            const { data } = await api.listBidCourses({ limit: 100 });
            setCourses(data?.courses || []);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to load courses');
        } finally {
            setLoading(false);
        }
    }, [api]);

    const loadDetail = useCallback(async (courseId) => {
        if (!courseId) {
            setDetail(null);
            return;
        }
        try {
            setError('');
            const { data } = await api.getBidCourse(courseId);
            setDetail(data);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to load course');
        }
    }, [api]);

    useEffect(() => {
        loadList();
        const t = setInterval(loadList, 15000);
        return () => clearInterval(t);
    }, [loadList]);

    useEffect(() => {
        if (id) loadDetail(id);
        else setDetail(null);
    }, [id, loadDetail]);

    const exportJson = () => {
        if (!detail) return;
        const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bid-course-${detail.course?.id || id}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const shots = useMemo(() => {
        const raw = (detail?.screenshots?.length ? detail.screenshots : detail?.disk_screenshots || [])
            .map((s) => ({
                ...s,
                filename: s.filename || (s.url ? decodeURIComponent(s.url.split('/').pop()) : `${s.stage}.png`)
            }));
        return sortScreenshotsForReview(raw);
    }, [detail]);

    return (
        <AppPage
            embedded={embedded}
            icon={FileText}
            title="Bid Courses"
            description="Auto Bidder monitor — JD, CV, answers, screenshots, and timeline."
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">
                                {detail ? `Course #${detail.course?.id}` : 'Bid courses'}
                            </p>
                            <p className="truncate text-xs text-white/40">
                                {detail
                                    ? `${detail.application?.company_name || 'Company'} — ${detail.application?.job_role || 'Role'}`
                                    : `${courses.length} course${courses.length === 1 ? '' : 's'}`}
                            </p>
                        </div>
                    )}
                    actions={(
                        <>
                            <Button variant="outline" size="sm" className="h-10" onClick={loadList} disabled={loading}>
                                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                                <span className="hidden sm:inline">Refresh</span>
                            </Button>
                            {detail && (
                                <Button variant="outline" size="sm" className="h-10" onClick={exportJson}>
                                    <Download className="h-4 w-4" />
                                    <span className="hidden sm:inline">Download JSON</span>
                                </Button>
                            )}
                        </>
                    )}
                />

                {error && (
                    <div className="rounded-xl border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-red-200">
                        {error}
                    </div>
                )}

                <ModalTabs
                value={pageTab}
                onValueChange={(v) => {
                    setPageTab(v);
                    if (v === 'courses' && id) navigate(basePath);
                }}
                className="min-h-[70vh]"
            >
                <ModalTabsList>
                    <ModalTabsTrigger value="courses">
                        Courses
                        {courses.length ? (
                            <span className="ml-1.5 tabular-nums text-[10px] opacity-70">({courses.length})</span>
                        ) : null}
                    </ModalTabsTrigger>
                    <ModalTabsTrigger value="form" disabled={!id}>
                        Form
                    </ModalTabsTrigger>
                    <ModalTabsTrigger value="log" disabled={!id}>
                        Log
                    </ModalTabsTrigger>
                </ModalTabsList>

                <ModalTabsContent value="courses">
                    <Card className="flex min-h-0 flex-1 flex-col overflow-hidden border-border/70 bg-card/80 shadow-sm">
                        <CardHeader className="border-b border-border/50 pb-3 pt-4">
                            <CardTitle className="font-display text-base tracking-tight">Bid courses</CardTitle>
                        </CardHeader>
                        <CardContent className="max-h-[70vh] space-y-1.5 overflow-y-auto pt-3">
                            {!courses.length && (
                                <p className="rounded-lg border border-dashed border-border/80 px-4 py-10 text-center text-sm text-muted-foreground">
                                    No bid courses yet. Run Auto Bidder from Lumi.
                                </p>
                            )}
                            {courses.map((c) => {
                                const statusEv = lastStatusEvent(c);
                                const run = courseRunStatus({
                                    ...c,
                                    last_event_type: statusEv.event_type || c.last_event_type,
                                    last_event_meta: statusEv.meta || c.last_event_meta
                                });
                                const fail = failureLabel(
                                    statusEv.event_type || c.last_event_type,
                                    statusEv.meta || c.last_event_meta
                                );
                                const needsCaptcha = /needs_captcha|captcha_abandoned/i.test(
                                    statusEv.event_type || c.last_event_type || ''
                                );
                                const failed = run.kind === 'failed';
                                const active = String(id) === String(c.id);
                                const badgeClass = runStatusBadgeClass(run.kind);
                                return (
                                    <Link
                                        key={c.id}
                                        to={coursePath(c.id)}
                                        onClick={() => setPageTab('form')}
                                        className={`block rounded-xl border px-3.5 py-3 text-sm transition duration-150 ${runStatusRowClass(run.kind)} ${
                                            active
                                                ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
                                                : 'border-border/50 bg-background/40 hover:border-primary/25 hover:bg-card hover:shadow-sm'
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1 font-medium tracking-tight">
                                                {(() => {
                                                    const n = String(c.company_name || '').trim();
                                                    if (n && !/^(unknown|company|job|engineering|product|department|team)$/i.test(n)) {
                                                        return n;
                                                    }
                                                    try {
                                                        const host = new URL(c.job_url || '').hostname.replace(/^www\./, '');
                                                        if (host) return host;
                                                    } catch { /* ignore */ }
                                                    return 'Company';
                                                })()}{' '}
                                                — {c.job_role || 'Role'}
                                            </div>
                                            <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${badgeClass}`}>
                                                {run.short}
                                            </span>
                                        </div>
                                        <div className={`mt-1 text-xs ${failed ? 'text-red-300' : run.kind === 'success' ? 'text-emerald-300/90' : 'text-muted-foreground'}`}>
                                            #{c.id} · {run.label}
                                            {c.user_username ? ` · ${c.user_username}` : ''}
                                            {fail && (failed || needsCaptcha) ? ` · ${fail}` : ''}
                                            {needsCaptcha && !fail ? ' · Needs CAPTCHA' : ''}
                                        </div>
                                    </Link>
                                );
                            })}
                        </CardContent>
                    </Card>
                </ModalTabsContent>

                <ModalTabsContent value="form">
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
                        {!detail && (
                            <p className="text-sm text-muted-foreground">Select a course to see the form screenshots.</p>
                        )}
                        {detail && (
                            <>
                                {(() => {
                                    const statusEv = lastStatusEvent(detail.events || detail.course);
                                    const run = courseRunStatus({
                                        ...detail.course,
                                        last_event_type: statusEv.event_type || detail.course?.last_event_type,
                                        last_event_meta: statusEv.meta || detail.course?.last_event_meta,
                                        application_status: detail.application?.status
                                    });
                                    return (
                                        <div className={`rounded-lg border px-3 py-2.5 text-sm ${runStatusBannerClass(run.kind)}`}>
                                            <div className="font-bold tracking-wide">
                                                {runStatusHeadline(run.kind, run.short)}
                                            </div>
                                            <p className="mt-1 text-xs leading-relaxed opacity-95">{run.label}</p>
                                        </div>
                                    );
                                })()}
                                <Card className="border-border/70 shadow-sm">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="font-display text-base tracking-tight">
                                            {detail.application?.company_name} — {detail.application?.job_role}
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-2 text-sm">
                                        <div>
                                            <span className="text-muted-foreground">Apply URL: </span>
                                            <a className="text-primary underline" href={detail.application?.job_url} target="_blank" rel="noreferrer">
                                                {detail.application?.job_url}
                                            </a>
                                        </div>
                                        <div>
                                            Status: {detail.application?.status} · Generation: {detail.application?.generation_status}
                                        </div>
                                        {detail.application?.download_url && (
                                            <a className="inline-flex text-primary underline" href={detail.application.download_url} target="_blank" rel="noreferrer">
                                                Download CV
                                            </a>
                                        )}
                                    </CardContent>
                                </Card>

                                <Card className="border-border/70 shadow-sm">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="font-display flex items-center gap-2 text-base tracking-tight">
                                            <Camera className="h-4 w-4 text-primary" /> Screenshots
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="grid grid-cols-1 gap-4">
                                        {shots.map((s) => (
                                            <AuthShot
                                                key={s.stage + s.filename}
                                                courseId={detail.course?.id || id}
                                                filename={s.filename}
                                                stage={s.stage}
                                                isAdmin={isAdmin}
                                            />
                                        ))}
                                        {!shots.length && (
                                            <div className="space-y-1 text-sm text-muted-foreground">
                                                <p>No screenshots yet.</p>
                                                {(detail.events || []).some((e) => e.event_type === 'screenshot_failed') && (
                                                    <p className="text-amber-700 dark:text-amber-400">
                                                        Capture failed earlier — reload Lumi extension, then Process again.
                                                    </p>
                                                )}
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            </>
                        )}
                    </div>
                </ModalTabsContent>

                <ModalTabsContent value="log">
                    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
                        {!detail && (
                            <p className="text-sm text-muted-foreground">Select a course to see answers and timeline.</p>
                        )}
                        {detail && (
                            <>
                                <Card className="border-border/70 shadow-sm">
                                    <CardHeader className="pb-2">
                                        <CardTitle className="font-display text-base tracking-tight">Answers</CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-2 text-sm">
                                        {(detail.course?.answers || []).length === 0 && (
                                            <p className="text-muted-foreground">No answers logged.</p>
                                        )}
                                        {(detail.course?.answers || []).map((a, i) => (
                                            <div key={i} className="rounded border px-3 py-2">
                                                <div className="flex flex-wrap items-center gap-2 font-medium">
                                                    <span>{a.label || a.id}</span>
                                                    {a.lane && (
                                                        <span className="rounded-full border border-border/80 px-1.5 py-0 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                                                            {a.lane}
                                                            {a.match_source ? ` · ${a.match_source}` : ''}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-muted-foreground whitespace-pre-wrap">{a.answer || a.value || '—'}</div>
                                            </div>
                                        ))}
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-base">
                                            Field attempts
                                            {detail.engine_version ? (
                                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                                    {detail.engine_version}
                                                </span>
                                            ) : null}
                                        </CardTitle>
                                    </CardHeader>
                                    <CardContent className="max-h-72 space-y-1 overflow-y-auto text-xs">
                                        {(detail.field_attempts || []).length === 0 && (
                                            <p className="text-sm text-muted-foreground">No field attempts logged yet.</p>
                                        )}
                                        {(detail.field_attempts || []).map((a) => (
                                            <div
                                                key={a.id}
                                                className={`flex flex-wrap gap-2 border-b border-border/40 py-1 ${
                                                    a.ok ? '' : 'text-destructive'
                                                }`}
                                            >
                                                <span className="w-16 shrink-0 text-muted-foreground">p{a.page_index}#{a.attempt_n}</span>
                                                <span className="min-w-[8rem] flex-1 font-medium">{a.field_label || a.field_id}</span>
                                                <span className="text-muted-foreground">{a.strategy || '—'}</span>
                                                <span>{a.ok ? 'ok' : 'fail'}</span>
                                                <span className="w-full truncate text-muted-foreground" title={a.chosen || a.wanted}>
                                                    → {(a.chosen || a.wanted || '').slice(0, 120)}
                                                </span>
                                            </div>
                                        ))}
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-base">Job description</CardTitle>
                                    </CardHeader>
                                    <CardContent>
                                        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                                            {detail.application?.job_description || '—'}
                                        </pre>
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader className="pb-2">
                                        <CardTitle className="text-base">Timeline</CardTitle>
                                    </CardHeader>
                                    <CardContent className="space-y-1 text-sm">
                                        {(() => {
                                            const startAt = detail.course?.started_at
                                                || detail.events?.[0]?.at
                                                || detail.course?.created_at;
                                            return (detail.events || []).map((e) => {
                                                const meta = e.meta || e.meta_json;
                                                let metaText = '';
                                                try {
                                                    const m = typeof meta === 'string' ? JSON.parse(meta) : meta;
                                                    if (m && typeof m === 'object') {
                                                        metaText = m.error || m.reason || m.ats || m.stage || '';
                                                        if (m.ats && (m.reason || m.engine)) {
                                                            metaText = [m.ats, m.reason || m.engine].filter(Boolean).join(': ');
                                                        }
                                                    }
                                                } catch { /* ignore */ }
                                                const bad = isFailureEvent(e.event_type)
                                                    || /needs_captcha|captcha_abandoned|login_wall/i.test(e.event_type || '');
                                                const noise = /^(screenshot|screenshot_failed|live)$/i.test(e.event_type || '');
                                                if (noise && String(e.meta?.stage || '').toLowerCase() === 'live') {
                                                    return null;
                                                }
                                                const elapsed = formatElapsedSince(startAt, e.at);
                                                return (
                                                    <div key={e.id} className={`flex flex-wrap gap-2 border-b border-border/40 py-1 ${bad ? 'text-amber-800 dark:text-amber-300' : ''}`}>
                                                        <span className="w-24 shrink-0 text-xs font-medium text-sky-700 dark:text-sky-300">
                                                            {elapsed || '—'}
                                                        </span>
                                                        <span className="w-36 shrink-0 text-xs text-muted-foreground">{e.at}</span>
                                                        <span className="font-medium">{e.event_type}</span>
                                                        {metaText ? (
                                                            <span className="w-full text-xs text-muted-foreground pl-0 sm:pl-24">{String(metaText).slice(0, 180)}</span>
                                                        ) : null}
                                                    </div>
                                                );
                                            });
                                        })()}
                                    </CardContent>
                                </Card>
                            </>
                        )}
                    </div>
                </ModalTabsContent>
            </ModalTabs>
            </div>
        </AppPage>
    );
}

export default BidCourses;
