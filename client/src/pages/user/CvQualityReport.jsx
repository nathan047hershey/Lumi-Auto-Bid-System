import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
    CheckCircle2,
    ClipboardCheck,
    ExternalLink,
    RefreshCw,
    XCircle
} from 'lucide-react';
import { userAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { PageLoader, Loader } from '@/components/Loader';

const LATEST_KEY = 'job_apply_cv_quality_latest';

function readLatestCache() {
    try {
        const raw = sessionStorage.getItem(LATEST_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

export function writeCvQualityCache(payload) {
    try {
        sessionStorage.setItem(LATEST_KEY, JSON.stringify({
            ...payload,
            saved_at: Date.now()
        }));
    } catch (_) { /* ignore */ }
}

function gradeClass(grade) {
    if (grade === 'A') return 'border-success/40 bg-success/10 text-success';
    if (grade === 'B') return 'border-primary/40 bg-primary/10 text-primary';
    if (grade === 'C') return 'border-warning/40 bg-warning/10 text-warning';
    return 'border-destructive/40 bg-destructive/10 text-destructive';
}

function QualityDetail({ report, meta }) {
    if (!report) return null;
    return (
        <div className="space-y-4">
            <div className={cn('rounded-xl border p-4', gradeClass(report.grade))}>
                <div className="flex flex-wrap items-end justify-between gap-3">
                    <div>
                        <p className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-80">
                            4-pass CV quality audit
                        </p>
                        <p className="mt-1 text-3xl font-semibold tracking-tight">
                            Grade {report.grade}
                            <span className="ml-2 text-lg font-normal opacity-80">({report.score}%)</span>
                        </p>
                        <p className="mt-1 text-sm opacity-90">{report.summary}</p>
                    </div>
                    {meta && (
                        <div className="text-right text-xs opacity-80">
                            {meta.company_name && <p className="font-medium">{meta.company_name}</p>}
                            {meta.job_role && <p>{meta.job_role}</p>}
                            {meta.application_id && <p>App #{meta.application_id}</p>}
                        </div>
                    )}
                </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
                {(report.passes || []).map((pass) => (
                    <Card key={pass.id} className="border-border/60">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center gap-2 text-base">
                                {pass.pass ? (
                                    <CheckCircle2 className="h-4 w-4 text-success" />
                                ) : (
                                    <XCircle className="h-4 w-4 text-destructive" />
                                )}
                                Pass {pass.id}: {pass.name}
                            </CardTitle>
                            <CardDescription>
                                {pass.passed}/{pass.total} checks passed
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {pass.issues?.length ? (
                                <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                                    {pass.issues.map((msg) => (
                                        <li key={msg}>{msg}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="text-sm text-success">All checks in this pass passed.</p>
                            )}
                        </CardContent>
                    </Card>
                ))}
            </div>

            {report.issues?.length > 0 && (
                <Card className="border-border/60">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">All open issues</CardTitle>
                        <CardDescription>
                            {report.critical_count || 0} critical · {report.warn_count || 0} warning(s)
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <ul className="space-y-2 text-sm">
                            {report.issues.map((issue) => (
                                <li key={`${issue.id}-${issue.message}`} className="flex items-start gap-2">
                                    <XCircle className={cn(
                                        'mt-0.5 h-3.5 w-3.5 shrink-0',
                                        issue.severity === 'critical' ? 'text-destructive' : 'text-warning'
                                    )} />
                                    <span>
                                        <span className="font-mono text-[10px] uppercase text-muted-foreground">
                                            Pass {issue.pass_id} · {issue.severity}
                                        </span>
                                        <br />
                                        {issue.message}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

export default function CvQualityReport() {
    const { applicationId: routeAppId } = useParams();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const queryAppId = searchParams.get('application_id') || routeAppId || '';

    const [apps, setApps] = useState([]);
    const [loadingList, setLoadingList] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [error, setError] = useState('');
    const [selectedId, setSelectedId] = useState(queryAppId || '');
    const [report, setReport] = useState(null);
    const [meta, setMeta] = useState(null);

    const loadList = useCallback(async () => {
        setLoadingList(true);
        setError('');
        try {
            const { data } = await userAPI.listCvQualityApplications();
            setApps(data.applications || []);
        } catch (err) {
            setError(err?.response?.data?.error || err.message || 'Failed to load applications');
        } finally {
            setLoadingList(false);
        }
    }, []);

    const runReport = useCallback(async (appId) => {
        if (!appId) return;
        setLoadingReport(true);
        setError('');
        setSelectedId(String(appId));
        try {
            const { data } = await userAPI.getCvQualityReport(appId);
            setReport(data.quality_report || null);
            setMeta({
                application_id: data.application_id,
                company_name: data.company_name,
                job_role: data.job_role,
                profile_id: data.profile_id
            });
            writeCvQualityCache({
                application_id: data.application_id,
                company_name: data.company_name,
                job_role: data.job_role,
                quality_report: data.quality_report
            });
            navigate(`/user/cv-quality/${data.application_id}`, { replace: true });
        } catch (err) {
            setError(err?.response?.data?.error || err.message || 'Quality check failed');
            setReport(null);
        } finally {
            setLoadingReport(false);
        }
    }, [navigate]);

    useEffect(() => {
        loadList();
    }, [loadList]);

    useEffect(() => {
        if (queryAppId) {
            runReport(queryAppId);
            return;
        }
        const cached = readLatestCache();
        if (cached?.quality_report) {
            setReport(cached.quality_report);
            setMeta({
                application_id: cached.application_id,
                company_name: cached.company_name,
                job_role: cached.job_role
            });
            if (cached.application_id) setSelectedId(String(cached.application_id));
        }
    }, [queryAppId, runReport]);

    if (loadingList && !report) {
        return <PageLoader message="Loading CV quality…" />;
    }

    return (
        <AppPage
            icon={ClipboardCheck}
            title="CV Quality Report"
            description="Four-pass audit of generated CVs. Generate uses one AI call by default; remake only when you click Regenerate (saves API keys)."
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Quality audit</p>
                            <p className="truncate text-xs text-white/40">
                                Four-pass CV check · regenerate only when needed
                            </p>
                        </div>
                    )}
                    actions={(
                        <>
                            <Button variant="outline" size="sm" className="h-10" onClick={loadList} disabled={loadingList}>
                                <RefreshCw className={cn('h-4 w-4', loadingList && 'animate-spin')} />
                                <span className="hidden sm:inline">Refresh list</span>
                            </Button>
                            {meta?.profile_id ? (
                                <Button variant="outline" size="sm" className="h-10" asChild>
                                    <Link to={`/user/generate/${meta.profile_id}`}>
                                        <ExternalLink className="h-4 w-4" />
                                        <span className="hidden sm:inline">Resume Generator</span>
                                    </Link>
                                </Button>
                            ) : (
                                <Button variant="outline" size="sm" className="h-10" asChild>
                                    <Link to="/user/generate">
                                        <ExternalLink className="h-4 w-4" />
                                        <span className="hidden sm:inline">Resume Generator</span>
                                    </Link>
                                </Button>
                            )}
                            {report && !report.pass && meta?.profile_id && (
                                <Button size="sm" className="h-10" asChild>
                                    <Link to={`/user/generate/${meta.profile_id}?regenerate=${meta.application_id || ''}`}>
                                        <RefreshCw className="h-4 w-4" />
                                        <span className="hidden sm:inline">Regenerate</span>
                                    </Link>
                                </Button>
                            )}
                        </>
                    )}
                />

            {error && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </div>
            )}

            <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                <Card className="h-fit">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-base">Applications with drafts</CardTitle>
                        <CardDescription>Pick one to run the 4-pass quality audit.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-1.5">
                        {!apps.length && (
                            <p className="text-sm text-muted-foreground">
                                No draft CVs yet. Generate a resume first.
                            </p>
                        )}
                        {apps.map((app) => (
                            <button
                                key={app.id}
                                type="button"
                                onClick={() => runReport(app.id)}
                                className={cn(
                                    'w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                                    String(selectedId) === String(app.id)
                                        ? 'border-primary/40 bg-primary/10'
                                        : 'border-white/[0.06] bg-black/15 hover:border-primary/30 hover:bg-white/[0.03]'
                                )}
                            >
                                <p className="truncate font-medium">{app.company_name || 'Unknown company'}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    #{app.id}
                                    {app.job_role ? ` · ${app.job_role}` : ''}
                                    {app.status ? ` · ${app.status}` : ''}
                                </p>
                            </button>
                        ))}
                    </CardContent>
                </Card>

                <div>
                    {loadingReport ? (
                        <div className="flex min-h-[240px] items-center justify-center gap-2 text-sm text-muted-foreground">
                            <Loader size="sm" />
                            Running 4-pass quality check…
                        </div>
                    ) : report ? (
                        <QualityDetail report={report} meta={meta} />
                    ) : (
                        <Card className="border-dashed border-white/10">
                            <CardContent className="py-12 text-center text-sm text-muted-foreground">
                                Select an application on the left, or generate a CV and open this page from Resume Generator.
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
            </div>
        </AppPage>
    );
}
