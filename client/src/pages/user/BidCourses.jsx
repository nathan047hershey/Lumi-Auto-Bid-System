import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Camera, FileText, Download, Search } from 'lucide-react';
import { userAPI, adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import {
    BID_COURSE_STATUS_FILTERS,
    BID_COURSE_KIND_RANK,
    BID_COURSE_LEGEND,
    bidCourseFilterBucket,
    computeBidCourseStats
} from '@/lib/bidCourseFilters';
import { cn } from '@/lib/utils';
import { bidClockStartAt } from '@/lib/bidClock';
import TeachAndCheckPanel from '@/components/TeachAndCheckPanel';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import { DatePicker } from '@/components/DatePicker';

function displayCompanyName(c) {
    const n = String(c?.company_name || '').trim();
    if (n && !/^(unknown|company|job|engineering|product|department|team)$/i.test(n)) {
        return n;
    }
    try {
        const host = new URL(c?.job_url || '').hostname.replace(/^www\./, '');
        if (host) return host;
    } catch { /* ignore */ }
    return 'Company';
}

function runForCourse(c) {
    const statusEv = lastStatusEvent(c);
    const run = courseRunStatus({
        ...c,
        last_event_type: statusEv.event_type || c.last_event_type,
        last_event_meta: statusEv.meta || c.last_event_meta
    });
    return { statusEv, run };
}

function filterKind(run) {
    return bidCourseFilterBucket(run);
}

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
            <div className="flex min-h-[12rem] items-center justify-center rounded-lg border border-dashed border-white/10 px-3 py-6 text-sm text-muted-foreground">
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
                className="max-h-[min(52vh,32rem)] min-h-[14rem] w-full rounded-lg border border-white/10 object-contain object-top bg-black/20"
            />
            <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
        </figure>
    );
}

function BidCourses({ embedded = false }) {
    const { id } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const isAdmin = location.pathname.startsWith('/admin');
    const basePath = isAdmin ? '/admin/performance' : '/user/performance';
    const api = isAdmin ? adminAPI : userAPI;

    const stateFilter = BID_COURSE_STATUS_FILTERS.some((f) => f.id === searchParams.get('state'))
        ? searchParams.get('state')
        : 'all';
    const query = searchParams.get('q') || '';
    const profileFilter = searchParams.get('profile_id') || 'all';
    const dateFrom = searchParams.get('from') || '';
    const dateTo = searchParams.get('to') || '';

    const [courses, setCourses] = useState([]);
    const [profiles, setProfiles] = useState([]);
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [pageTab, setPageTab] = useState('review');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [teachSeed, setTeachSeed] = useState({ question: '', answer: '' });
    const [editIdx, setEditIdx] = useState(null);
    const [editAnswer, setEditAnswer] = useState('');
    const [correctBusy, setCorrectBusy] = useState(false);
    const [correctMsg, setCorrectMsg] = useState('');

    const listQuery = searchParams.toString();
    const coursePath = (courseId) => `${basePath}/courses/${courseId}${listQuery ? `?${listQuery}` : ''}`;
    const listPath = `${basePath}${listQuery ? `?${listQuery}` : ''}`;

    const patchParams = useCallback((mutate) => {
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            mutate(next);
            return next;
        }, { replace: true });
    }, [setSearchParams]);

    const loadList = useCallback(async () => {
        try {
            setLoading(true);
            setError('');
            const params = { limit: 100 };
            if (profileFilter && profileFilter !== 'all') params.profile_id = profileFilter;
            if (query.trim()) params.q = query.trim();
            if (dateFrom) params.from = dateFrom;
            if (dateTo) params.to = dateTo;
            const { data } = await api.listBidCourses(params);
            setCourses(data?.courses || []);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to load courses');
        } finally {
            setLoading(false);
        }
    }, [api, profileFilter, query, dateFrom, dateTo]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const { data } = await api.getProfiles();
                const list = Array.isArray(data)
                    ? data
                    : (data?.profiles || data?.data || []);
                if (!cancelled) setProfiles(list);
            } catch {
                if (!cancelled) setProfiles([]);
            }
        })();
        return () => { cancelled = true; };
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

    const decorated = useMemo(() => (
        (courses || []).map((c) => {
            const { statusEv, run } = runForCourse(c);
            return { course: c, statusEv, run, bucket: filterKind(run) };
        })
    ), [courses]);

    const stats = useMemo(() => computeBidCourseStats(decorated), [decorated]);

    const filtered = useMemo(() => {
        const rows = decorated.filter((row) => {
            if (stateFilter !== 'all' && row.bucket !== stateFilter) return false;
            return true;
        });
        rows.sort((a, b) => {
            const ra = BID_COURSE_KIND_RANK[a.run.kind] ?? 9;
            const rb = BID_COURSE_KIND_RANK[b.run.kind] ?? 9;
            if (ra !== rb) return ra - rb;
            return String(b.course.updated_at || b.course.created_at || '')
                .localeCompare(String(a.course.updated_at || a.course.created_at || ''));
        });
        return rows;
    }, [decorated, stateFilter]);

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

    const detailRun = useMemo(() => {
        if (!detail?.course) return null;
        const statusEv = lastStatusEvent(detail.events || detail.course);
        return courseRunStatus({
            ...detail.course,
            last_event_type: statusEv.event_type || detail.course?.last_event_type,
            last_event_meta: statusEv.meta || detail.course?.last_event_meta,
            application_status: detail.application?.status
        });
    }, [detail]);

    return (
        <AppPage
            embedded={embedded}
            icon={FileText}
            title="Bid Courses"
            description={BID_COURSE_LEGEND}
        >
            <div className="flex min-h-[calc(100vh-8.5rem)] flex-col gap-3">
                <PageCommandBar
                    search={(
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                            <Input
                                className="h-10 border-white/10 bg-black/25 pl-10"
                                placeholder="Search company, role, #id…"
                                value={query}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    patchParams((next) => {
                                        if (v) next.set('q', v);
                                        else next.delete('q');
                                    });
                                }}
                            />
                        </div>
                    )}
                    actions={(
                        <>
                            {id ? (
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10 lg:hidden"
                                    onClick={() => navigate(listPath)}
                                >
                                    <ArrowLeft className="h-4 w-4" />
                                    List
                                </Button>
                            ) : null}
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
                    filters={(
                        <>
                            <Select
                                value={profileFilter}
                                onValueChange={(v) => patchParams((next) => {
                                    if (!v || v === 'all') next.delete('profile_id');
                                    else next.set('profile_id', v);
                                })}
                            >
                                <SelectTrigger className="h-9 w-[9.5rem] border-white/10 bg-black/20">
                                    <SelectValue placeholder="Profile" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="all">All profiles</SelectItem>
                                    {profiles.map((p) => (
                                        <SelectItem key={p.id} value={String(p.id)}>
                                            {[p.first_name, p.last_name].filter(Boolean).join(' ') || `Profile #${p.id}`}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <DatePicker
                                value={dateFrom || undefined}
                                onChange={(e) => patchParams((next) => {
                                    const v = e?.target?.value || '';
                                    if (v) next.set('from', v);
                                    else next.delete('from');
                                })}
                                placeholder="From"
                                className="h-9 w-[8.5rem] border-white/10 bg-black/20"
                            />
                            <DatePicker
                                value={dateTo || undefined}
                                onChange={(e) => patchParams((next) => {
                                    const v = e?.target?.value || '';
                                    if (v) next.set('to', v);
                                    else next.delete('to');
                                })}
                                placeholder="To"
                                className="h-9 w-[8.5rem] border-white/10 bg-black/20"
                            />
                            {BID_COURSE_STATUS_FILTERS.map((f) => (
                                <button
                                    key={f.id}
                                    type="button"
                                    onClick={() => patchParams((next) => {
                                        if (f.id === 'all') next.delete('state');
                                        else next.set('state', f.id);
                                    })}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition',
                                        stateFilter === f.id
                                            ? `${runStatusBadgeClass(f.id === 'all' ? 'unknown' : f.id)} ring-1 ring-white/20`
                                            : 'border-white/10 bg-black/20 text-white/50 hover:bg-white/5 hover:text-white/80'
                                    )}
                                >
                                    {f.label}
                                    <span className="tabular-nums opacity-80">{stats[f.id] ?? 0}</span>
                                </button>
                            ))}
                        </>
                    )}
                />

                {error && (
                    <div className="rounded-xl border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-red-200">
                        {error}
                    </div>
                )}

                <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
                    <aside
                        data-testid="bid-course-list"
                        className={cn(
                        'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.72)]',
                        id ? 'hidden lg:flex' : 'flex'
                    )}
                    >
                        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2.5">
                            <p className="text-xs font-medium text-white/55">
                                {filtered.length}
                                {filtered.length !== decorated.length ? ` of ${decorated.length}` : ''}
                                {' '}
                                {decorated.length === 1 ? 'course' : 'courses'}
                            </p>
                            {stateFilter !== 'all' || query || profileFilter !== 'all' || dateFrom || dateTo ? (
                                <button
                                    type="button"
                                    className="text-[11px] text-white/40 hover:text-white/70"
                                    onClick={() => setSearchParams({}, { replace: true })}
                                >
                                    Clear filters
                                </button>
                            ) : null}
                        </div>
                        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                            {!filtered.length && (
                                <p className="rounded-lg border border-dashed border-white/10 px-4 py-10 text-center text-sm text-muted-foreground">
                                    {decorated.length
                                        ? 'No courses match this bidding state. Try All or another filter.'
                                        : 'No bid courses yet. Run Auto Bidder from Lumi.'}
                                </p>
                            )}
                            {filtered.map(({ course: c, statusEv, run }) => {
                                const fail = failureLabel(
                                    statusEv.event_type || c.last_event_type,
                                    statusEv.meta || c.last_event_meta
                                );
                                const failed = run.kind === 'failed';
                                const active = String(id) === String(c.id);
                                return (
                                    <Link
                                        key={c.id}
                                        to={coursePath(c.id)}
                                        onClick={() => setPageTab('review')}
                                        className={cn(
                                            'block rounded-xl border px-3 py-2.5 text-sm transition duration-150',
                                            runStatusRowClass(run.kind),
                                            active
                                                ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
                                                : 'border-white/[0.06] bg-black/20 hover:border-primary/25 hover:bg-card/60'
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate font-medium tracking-tight">
                                                    {displayCompanyName(c)}
                                                </div>
                                                <div className="truncate text-xs text-white/45">
                                                    {c.job_role || 'Role'}
                                                    {c.profile_name ? ` · ${c.profile_name}` : ''}
                                                </div>
                                            </div>
                                            <span className={cn(
                                                'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide',
                                                runStatusBadgeClass(run.kind)
                                            )}
                                            >
                                                {run.short}
                                            </span>
                                        </div>
                                        <div className={cn(
                                            'mt-1 truncate text-[11px]',
                                            failed
                                                ? 'text-red-300'
                                                : run.kind === 'success'
                                                    ? 'text-emerald-300/90'
                                                    : run.kind === 'filled'
                                                        ? 'text-sky-300/90'
                                                        : 'text-white/40'
                                        )}
                                        >
                                            #{c.id}
                                            {' · '}
                                            {run.short === 'SUCCESS' ? 'Applied on site' : run.label}
                                            {c.user_username ? ` · ${c.user_username}` : ''}
                                            {fail && failed ? ` · ${fail}` : ''}
                                        </div>
                                    </Link>
                                );
                            })}
                        </div>
                    </aside>

                    <section
                        data-testid="bid-course-detail"
                        className={cn(
                        'flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.55)]',
                        !id ? 'hidden min-h-[16rem] lg:flex' : 'flex'
                    )}
                    >
                        {!id && (
                            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
                                <p className="text-sm font-medium text-white/70">Select a course</p>
                                <p className="max-w-sm text-xs text-white/40">
                                    {BID_COURSE_LEGEND}
                                </p>
                            </div>
                        )}
                        {id && (
                            <ModalTabs
                                value={pageTab}
                                onValueChange={setPageTab}
                                className="min-h-0 flex-1 p-3"
                            >
                                <ModalTabsList>
                                    <ModalTabsTrigger value="review">Review</ModalTabsTrigger>
                                    <ModalTabsTrigger value="activity">Activity</ModalTabsTrigger>
                                </ModalTabsList>

                                <ModalTabsContent value="review">
                                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
                                        {!detail && (
                                            <p className="text-sm text-muted-foreground">Loading course…</p>
                                        )}
                                        {detail && detailRun && (
                                            <>
                                                <div className={cn('rounded-xl border px-3 py-2.5 text-sm', runStatusBannerClass(detailRun.kind))}>
                                                    <div className="font-bold tracking-wide">
                                                        {runStatusHeadline(detailRun.kind, detailRun.short)}
                                                    </div>
                                                    <p className="mt-1 text-xs leading-relaxed opacity-95">{detailRun.label}</p>
                                                </div>
                                                <Card className="border-white/[0.07] bg-black/15 shadow-none">
                                                    <CardHeader className="pb-2">
                                                        <CardTitle className="font-display text-base tracking-tight">
                                                            {detail.application?.company_name} — {detail.application?.job_role}
                                                        </CardTitle>
                                                    </CardHeader>
                                                    <CardContent className="space-y-2 text-sm">
                                                        <div className="break-all">
                                                            <span className="text-muted-foreground">Apply URL: </span>
                                                            <a className="text-primary underline" href={detail.application?.job_url} target="_blank" rel="noreferrer">
                                                                {detail.application?.job_url}
                                                            </a>
                                                        </div>
                                                        <div className="text-white/60">
                                                            {detail.application?.status
                                                                ? `App: ${detail.application.status}`
                                                                : null}
                                                            {detail.course?.profile_name
                                                                ? ` · ${detail.course.profile_name}`
                                                                : null}
                                                        </div>
                                                        {detail.application?.download_url && (
                                                            <a className="inline-flex text-primary underline" href={detail.application.download_url} target="_blank" rel="noreferrer">
                                                                Download CV
                                                            </a>
                                                        )}
                                                    </CardContent>
                                                </Card>

                                                <Card className="border-white/[0.07] bg-black/15 shadow-none">
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
                                                                    <p className="text-amber-400">
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

                                <ModalTabsContent value="activity">
                                    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
                                        {!detail && (
                                            <p className="text-sm text-muted-foreground">Loading course…</p>
                                        )}
                                        {detail && (
                                            <>
                                                <Card className="border-white/[0.07] bg-black/15 shadow-none">
                                                    <CardHeader className="pb-2">
                                                        <CardTitle className="font-display text-base tracking-tight">Answers</CardTitle>
                                                    </CardHeader>
                                                    <CardContent className="space-y-3 text-sm">
                                                        <p className="text-[11px] text-muted-foreground">
                                                            Found a wrong answer? Edit it and click <strong>Save &amp; learn</strong> — Lumi will use the correction next time.
                                                        </p>
                                                        <TeachAndCheckPanel
                                                            seedQuestion={teachSeed.question}
                                                            seedAnswer={teachSeed.answer}
                                                        />
                                                        {correctMsg ? (
                                                            <p className="text-[11px] text-emerald-300">{correctMsg}</p>
                                                        ) : null}
                                                        {(detail.course?.answers || []).length === 0 && (
                                                            <p className="text-muted-foreground">No answers logged.</p>
                                                        )}
                                                        {(detail.course?.answers || []).map((a, i) => (
                                                            <div key={i} className="rounded-lg border border-white/[0.06] px-3 py-2">
                                                                <div className="flex flex-wrap items-center gap-2 font-medium">
                                                                    <span>{a.label || a.id}</span>
                                                                    {a.lane && (
                                                                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{a.lane}</span>
                                                                    )}
                                                                    {a.corrected ? (
                                                                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] uppercase text-emerald-200">fixed</span>
                                                                    ) : null}
                                                                    <Button
                                                                        type="button"
                                                                        size="sm"
                                                                        variant="ghost"
                                                                        className="ml-auto h-7 text-[10px]"
                                                                        onClick={() => {
                                                                            setEditIdx(i);
                                                                            setEditAnswer(a.value || a.answer || '');
                                                                            setTeachSeed({
                                                                                question: a.label || a.id || '',
                                                                                answer: a.value || a.answer || ''
                                                                            });
                                                                            setCorrectMsg('');
                                                                        }}
                                                                    >
                                                                        Edit
                                                                    </Button>
                                                                </div>
                                                                {editIdx === i ? (
                                                                    <div className="mt-2 space-y-2">
                                                                        <textarea
                                                                            className="min-h-[52px] w-full rounded-md border border-border/60 bg-background/80 px-2 py-1.5 text-[12px]"
                                                                            value={editAnswer}
                                                                            disabled={correctBusy}
                                                                            onChange={(e) => setEditAnswer(e.target.value)}
                                                                        />
                                                                        <div className="flex flex-wrap gap-2">
                                                                            <Button
                                                                                type="button"
                                                                                size="sm"
                                                                                className="h-7 text-[11px]"
                                                                                disabled={correctBusy || !editAnswer.trim()}
                                                                                onClick={async () => {
                                                                                    setCorrectBusy(true);
                                                                                    setCorrectMsg('');
                                                                                    try {
                                                                                        await api.correctBidCourseAnswer(detail.course.id, {
                                                                                            index: i,
                                                                                            question: a.label || a.id || '',
                                                                                            answer: editAnswer.trim(),
                                                                                            update_all: true
                                                                                        });
                                                                                        setCorrectMsg('Saved — Lumi will reuse this answer next time.');
                                                                                        setEditIdx(null);
                                                                                        await loadDetail(detail.course.id);
                                                                                    } catch (err) {
                                                                                        setCorrectMsg(err.response?.data?.error || err.message || 'Save failed');
                                                                                    } finally {
                                                                                        setCorrectBusy(false);
                                                                                    }
                                                                                }}
                                                                            >
                                                                                {correctBusy ? 'Saving…' : 'Save & learn'}
                                                                            </Button>
                                                                            <Button
                                                                                type="button"
                                                                                size="sm"
                                                                                variant="ghost"
                                                                                className="h-7 text-[11px]"
                                                                                disabled={correctBusy}
                                                                                onClick={() => setEditIdx(null)}
                                                                            >
                                                                                Cancel
                                                                            </Button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{a.value || a.answer || '—'}</div>
                                                                )}
                                                            </div>
                                                        ))}
                                                    </CardContent>
                                                </Card>

                                                <Card className="border-white/[0.07] bg-black/15 shadow-none">
                                                    <CardHeader className="pb-2">
                                                        <CardTitle className="text-base">Timeline</CardTitle>
                                                    </CardHeader>
                                                    <CardContent className="space-y-1 text-sm">
                                                        {(() => {
                                                            const startAt = bidClockStartAt({
                                                                events: detail.events,
                                                                course: detail.course
                                                            })
                                                                || (detail.events || []).find((ev) => (
                                                                    !/^(generate_done|cv_regenerat)/i.test(ev.event_type || '')
                                                                ))?.at
                                                                || detail.events?.[0]?.at;
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
                                                                const human = failureLabel(e.event_type, meta) || e.event_type;
                                                                return (
                                                                    <div key={e.id} className={`flex flex-wrap gap-2 border-b border-border/40 py-1 ${bad ? 'text-amber-300' : ''}`}>
                                                                        <span className="w-24 shrink-0 text-xs font-medium text-sky-300">
                                                                            {elapsed || '—'}
                                                                        </span>
                                                                        <span className="font-medium">{human}</span>
                                                                        {metaText ? (
                                                                            <span className="w-full text-xs text-muted-foreground">{String(metaText).slice(0, 180)}</span>
                                                                        ) : null}
                                                                    </div>
                                                                );
                                                            });
                                                        })()}
                                                    </CardContent>
                                                </Card>

                                                <div className="pt-1">
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 text-xs text-muted-foreground"
                                                        onClick={() => setShowAdvanced((v) => !v)}
                                                    >
                                                        {showAdvanced ? 'Hide advanced' : 'Show advanced'}
                                                    </Button>
                                                </div>

                                                {showAdvanced && (
                                                    <>
                                                        <Card className="border-white/[0.07] bg-black/15 shadow-none">
                                                            <CardHeader className="pb-2">
                                                                <CardTitle className="text-base">Job description</CardTitle>
                                                            </CardHeader>
                                                            <CardContent>
                                                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                                                                    {detail.application?.job_description || '—'}
                                                                </pre>
                                                            </CardContent>
                                                        </Card>
                                                        <Card className="border-white/[0.07] bg-black/15 shadow-none">
                                                            <CardHeader className="pb-2">
                                                                <CardTitle className="text-base">Field attempts</CardTitle>
                                                            </CardHeader>
                                                            <CardContent className="space-y-1 text-xs text-muted-foreground">
                                                                {(detail.field_attempts || detail.attempts || []).length
                                                                    ? (detail.field_attempts || detail.attempts || []).slice(0, 40).map((a, i) => (
                                                                        <div key={i} className="border-b border-border/30 py-1">
                                                                            {a.label || a.field || a.id || 'field'}
                                                                            {a.status ? ` · ${a.status}` : ''}
                                                                            {a.error ? ` · ${a.error}` : ''}
                                                                        </div>
                                                                    ))
                                                                    : <p>No field attempts logged.</p>}
                                                            </CardContent>
                                                        </Card>
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </ModalTabsContent>
                            </ModalTabs>
                        )}
                    </section>
                </div>
            </div>
        </AppPage>
    );
}

export default BidCourses;
