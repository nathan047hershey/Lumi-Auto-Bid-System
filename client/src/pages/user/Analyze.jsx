import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BarChart3, RefreshCw, Sparkles, Camera } from 'lucide-react';
import { userAPI, adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DonutChart from '@/components/dashboard/DonutChart';
import BarChart, { HorizontalBarChart } from '@/components/dashboard/BarChart';
import { CHART } from '@/lib/chartTheme';
import { cn } from '@/lib/utils';

function pct(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return `${n}%`;
}

function money(n) {
    if (n == null) return '—';
    return `$${Number(n).toLocaleString('en-US')}`;
}

function shortLabel(text, max = 36) {
    const s = String(text || '').trim();
    if (!s) return '—';
    if (s.length <= max) return s;
    return `${s.slice(0, max - 1)}…`;
}

function Panel({ title, hint, className, children, actions }) {
    return (
        <section
            className={cn(
                'rounded-xl border border-white/[0.07] bg-black/20',
                className
            )}
        >
            {(title || actions) && (
                <header className="flex items-start justify-between gap-2 border-b border-white/[0.05] px-3 py-2">
                    <div className="min-w-0">
                        {title ? (
                            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-white/55">
                                {title}
                            </h3>
                        ) : null}
                        {hint ? (
                            <p className="mt-0.5 text-[11px] text-white/35">{hint}</p>
                        ) : null}
                    </div>
                    {actions}
                </header>
            )}
            <div className="p-3">{children}</div>
        </section>
    );
}

function Kpi({ label, value, hint, accent }) {
    return (
        <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
            <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-white/40">
                {label}
            </div>
            <div
                className={cn(
                    'mt-0.5 text-xl font-semibold tabular-nums leading-none tracking-tight',
                    accent === 'good' && 'text-emerald-400',
                    accent === 'warn' && 'text-amber-300',
                    !accent && 'text-white'
                )}
            >
                {value}
            </div>
            {hint ? (
                <div className="mt-1 truncate text-[10px] text-white/35">{hint}</div>
            ) : null}
        </div>
    );
}

function SignalChip({ label, value }) {
    return (
        <div className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                {label}
            </div>
            <div className="mt-0.5 text-xs font-medium text-white/85">{value || '—'}</div>
        </div>
    );
}

function RateTable({ rows, nameKey, nameHeader, empty }) {
    if (!rows?.length) {
        return <p className="text-xs text-white/40">{empty || 'No data yet.'}</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[320px] text-left text-xs">
                <thead>
                    <tr className="border-b border-white/[0.06] text-white/40">
                        <th className="py-1.5 pr-2 font-medium">{nameHeader}</th>
                        <th className="py-1.5 pr-2 font-medium">Bids</th>
                        <th className="py-1.5 pr-2 font-medium">Int.</th>
                        <th className="py-1.5 font-medium">Rate</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={`${row[nameKey]}-${i}`} className="border-b border-white/[0.04]">
                            <td className="py-1.5 pr-2 font-medium text-white/85">
                                {shortLabel(row[nameKey], 42)}
                            </td>
                            <td className="py-1.5 pr-2 tabular-nums text-white/70">{row.total ?? 0}</td>
                            <td className="py-1.5 pr-2 tabular-nums text-emerald-400">{row.interview ?? 0}</td>
                            <td className="py-1.5 tabular-nums text-white/70">{pct(row.interview_rate)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Analyze({ embedded = false }) {
    const location = useLocation();
    const isAdmin = location.pathname.startsWith('/admin');
    const api = isAdmin ? adminAPI : userAPI;
    const courseBase = isAdmin ? '/admin/performance' : '/user/performance';

    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [analysis, setAnalysis] = useState('');
    const [analysisMeta, setAnalysisMeta] = useState(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [analyzeError, setAnalyzeError] = useState('');
    const [analyzeInfo, setAnalyzeInfo] = useState('');
    const [cooldownUntil, setCooldownUntil] = useState(0);
    const [nowTick, setNowTick] = useState(Date.now());
    const [tab, setTab] = useState('overview');

    useEffect(() => {
        if (cooldownUntil <= Date.now()) return undefined;
        const t = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(t);
    }, [cooldownUntil]);

    const cooldownSec = Math.max(0, Math.ceil((cooldownUntil - nowTick) / 1000));
    const coolingDown = cooldownSec > 0;

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError('');
            const { data: payload } = await api.getAnalyze({ since_days: 30, limit: isAdmin ? 150 : 100 });
            setData(payload);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to load analyze data');
        } finally {
            setLoading(false);
        }
    }, [api, isAdmin]);

    useEffect(() => {
        load();
    }, [load]);

    const runAnalysis = async () => {
        if (coolingDown) {
            setAnalyzeInfo(`Please wait ${cooldownSec}s before running another MiniMax briefing.`);
            setAnalyzeError('');
            setTab('briefing');
            return;
        }
        try {
            setAnalyzing(true);
            setAnalyzeError('');
            setAnalyzeInfo('');
            setTab('briefing');
            const { data: result } = await api.runAnalyze({});
            setAnalysis(result?.analysis || '');
            setAnalysisMeta({
                generated_at: result?.generated_at,
                provider: result?.provider,
                model: result?.model
            });
            setCooldownUntil(Date.now() + 30_000);
            await load();
        } catch (err) {
            const status = err.response?.status;
            const msg = err.response?.data?.error || err.message || 'Analysis failed';
            const retry = Number(err.response?.data?.retry_after_sec) || (status === 429 ? 60 : 0);
            if (status === 429 || /rate|quota|wait \d+s/i.test(msg)) {
                if (retry > 0) setCooldownUntil(Date.now() + retry * 1000);
                setAnalyzeInfo(msg);
                setAnalyzeError('');
            } else {
                setAnalyzeError(msg);
                setAnalyzeInfo('');
            }
        } finally {
            setAnalyzing(false);
        }
    };

    const usage = data?.usage;
    const cc = usage?.chat_counts || {};
    const limits = usage?.limits || {};
    const insights = data?.insights;
    const summary = insights?.summary || data?.bids?.summary || {};
    const playbook = insights?.playbook;
    const salary = insights?.salary;

    const bidSeries = useMemo(
        () => [
            { key: 'bids', label: 'Bids', color: CHART.secondary },
            { key: 'interviews', label: 'Interviews', color: CHART.scheduled }
        ],
        []
    );

    const companyBars = useMemo(
        () => (insights?.by_company || []).slice(0, 12).map((r) => ({
            label: shortLabel(r.company_name, 26),
            value: r.interview || 0
        })),
        [insights]
    );

    const templateBars = useMemo(
        () => (insights?.by_template || []).slice(0, 8).map((r) => ({
            label: r.template_id != null
                ? `#${r.template_id}${r.font_family ? ` · ${r.font_family}` : ''}`
                : `None${r.font_family ? ` · ${r.font_family}` : ''}`,
            value: r.interview_rate || 0
        })),
        [insights]
    );

    const fontBars = useMemo(
        () => (insights?.by_font || []).slice(0, 8).map((r) => ({
            label: r.font_family || 'unknown',
            value: r.interview_rate || 0
        })),
        [insights]
    );

    const roleBars = useMemo(
        () => (insights?.by_role || []).slice(0, 10).map((r) => ({
            label: shortLabel(r.job_role, 28),
            value: r.interview || 0
        })),
        [insights]
    );

    const chatKindBars = useMemo(() => {
        const period = cc.by_kind_period || {};
        return ['chat', 'cv', 'answers', 'bidder', 'analyze', 'other']
            .filter((k) => period[k] || usage?.by_kind?.[k]?.calls)
            .map((k) => ({
                label: k === 'chat' ? 'Generate chat' : k,
                value: period[k] ?? usage?.by_kind?.[k]?.calls ?? 0
            }));
    }, [cc, usage]);

    const dayNamesFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const totalBids = summary.bids ?? summary.courses ?? 0;

    return (
        <AppPage
            embedded={embedded}
            icon={BarChart3}
            title="Analyze"
            description={
                isAdmin
                    ? 'What correlates with interviews — company, timing, CV, usage.'
                    : 'Interview signals by company, timing, CV style, and MiniMax usage.'
            }
        >
            <div className="space-y-3">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Analyze</p>
                            <p className="truncate text-xs text-white/40">
                                Last 30 days · denser read of bid outcomes
                            </p>
                        </div>
                    )}
                    actions={(
                        <>
                            <Button asChild variant="outline" size="sm" className="h-10">
                                <Link to={courseBase}>
                                    <Camera className="h-4 w-4" />
                                    <span className="hidden sm:inline">Bid courses</span>
                                </Link>
                            </Button>
                            <Button variant="outline" size="sm" className="h-10" onClick={load} disabled={loading}>
                                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                                <span className="hidden sm:inline">Refresh</span>
                            </Button>
                            <Button size="sm" className="h-10" onClick={runAnalysis} disabled={analyzing || loading || coolingDown}>
                                <Sparkles className={cn('h-4 w-4', analyzing && 'animate-pulse')} />
                                {analyzing
                                    ? 'Analyzing…'
                                    : coolingDown
                                        ? `Wait ${cooldownSec}s`
                                        : 'MiniMax briefing'}
                            </Button>
                        </>
                    )}
                />

                {error && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-red-200">
                        {error}
                    </div>
                )}
                {analyzeError && (
                    <div className="rounded-lg border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-red-200">
                        {analyzeError}
                    </div>
                )}
                {analyzeInfo && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                        {analyzeInfo}
                    </div>
                )}

                {loading && !data ? (
                    <p className="text-sm text-white/40">Loading analytics…</p>
                ) : (
                    <Tabs value={tab} onValueChange={setTab} className="space-y-3">
                        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
                            <TabsTrigger value="overview" className="text-xs sm:text-sm">Overview</TabsTrigger>
                            <TabsTrigger value="breakdowns" className="text-xs sm:text-sm">Breakdowns</TabsTrigger>
                            <TabsTrigger value="cv" className="text-xs sm:text-sm">CV & style</TabsTrigger>
                            <TabsTrigger value="usage" className="text-xs sm:text-sm">Usage</TabsTrigger>
                            <TabsTrigger value="briefing" className="text-xs sm:text-sm">Briefing</TabsTrigger>
                        </TabsList>

                        {/* Overview — KPIs + charts + signals */}
                        <TabsContent value="overview" className="mt-0 space-y-3">
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
                                <Kpi label="Total bids" value={totalBids} />
                                <Kpi label="Unknown" value={summary.unknown ?? 0} />
                                <Kpi label="Applied" value={summary.applied ?? 0} />
                                <Kpi label="Interviews" value={summary.interview ?? 0} accent="good" />
                                <Kpi label="Rejected" value={summary.rejected ?? 0} />
                                <Kpi
                                    label="Stuck"
                                    value={insights?.bidder_ops?.stuck ?? data?.bids?.stuck ?? 0}
                                    hint="Incomplete / CAPTCHA / form issues"
                                />
                                <Kpi
                                    label="Interview rate"
                                    value={pct(summary.interview_rate)}
                                    hint={`Of applied · all ${pct(summary.interview_rate_of_all)}`}
                                />
                            </div>

                            <Panel
                                title="What looks stronger"
                                hint={
                                    (playbook?.interview_count || 0) === 0
                                        ? 'Mark interviews on Bid Courses to unlock rankings.'
                                        : `From ${playbook.interview_count} interview(s) across ${playbook.sample_size} bids`
                                }
                            >
                                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                    <SignalChip
                                        label="Best fill hours"
                                        value={
                                            playbook?.preferred_fill_hours?.length
                                                ? playbook.preferred_fill_hours.map((h) => `${h}:00`).join(', ')
                                                : '—'
                                        }
                                    />
                                    <SignalChip
                                        label="CV template"
                                        value={
                                            playbook?.preferred_template_id != null
                                                ? `#${playbook.preferred_template_id}`
                                                : '—'
                                        }
                                    />
                                    <SignalChip
                                        label="CV font"
                                        value={playbook?.preferred_font_family || '—'}
                                    />
                                    <SignalChip
                                        label="Top companies"
                                        value={
                                            playbook?.preferred_companies?.length
                                                ? playbook.preferred_companies.slice(0, 3).join(', ')
                                                : '—'
                                        }
                                    />
                                </div>
                                {playbook?.answer_style_description ? (
                                    <p className="mt-2 rounded-md border border-white/[0.05] bg-white/[0.02] px-2.5 py-2 text-xs text-white/70">
                                        <span className="font-semibold text-white/45">Answer style · </span>
                                        {playbook.answer_style_description}
                                    </p>
                                ) : null}
                            </Panel>

                            <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
                                <Panel title="Outcome mix">
                                    <DonutChart
                                        segments={insights?.charts?.outcomes || []}
                                        size={128}
                                        strokeWidth={18}
                                        emptyText="No bids yet"
                                    />
                                </Panel>
                                <Panel title="By fill hour" hint="Bids vs interviews">
                                    <BarChart
                                        data={insights?.charts?.by_hour || []}
                                        series={bidSeries}
                                        height={168}
                                        emptyText="No fill timestamps yet"
                                    />
                                </Panel>
                            </div>

                            <Panel title="By weekday" hint="Bids vs interviews">
                                <BarChart
                                    data={insights?.charts?.by_day || []}
                                    series={bidSeries}
                                    height={156}
                                    emptyText="No weekday data yet"
                                />
                            </Panel>
                        </TabsContent>

                        {/* Breakdowns — company, role, time */}
                        <TabsContent value="breakdowns" className="mt-0 space-y-3">
                            <div className="grid gap-3 lg:grid-cols-2">
                                <Panel title="Company → interviews">
                                    <div className="space-y-3">
                                        <HorizontalBarChart
                                            items={companyBars}
                                            accent={CHART.scheduled}
                                            emptyText="No company data"
                                            maxItems={10}
                                        />
                                        <RateTable
                                            rows={insights?.by_company}
                                            nameKey="company_name"
                                            nameHeader="Company"
                                            empty="No companies yet"
                                        />
                                    </div>
                                </Panel>
                                <Panel title="Role → interviews">
                                    <div className="space-y-3">
                                        <HorizontalBarChart
                                            items={roleBars}
                                            accent={CHART.primary}
                                            emptyText="No role data"
                                            maxItems={10}
                                        />
                                        <RateTable
                                            rows={insights?.by_role}
                                            nameKey="job_role"
                                            nameHeader="Role"
                                            empty="No roles yet"
                                        />
                                    </div>
                                </Panel>
                            </div>

                            <div className="grid gap-3 lg:grid-cols-2">
                                <Panel title="Fill hour ranking" hint="Sorted by interview rate">
                                    <RateTable
                                        rows={(insights?.by_fill_hour || []).map((r) => ({
                                            ...r,
                                            label: `${r.hour}:00`
                                        }))}
                                        nameKey="label"
                                        nameHeader="Hour"
                                        empty="No hour data"
                                    />
                                </Panel>
                                <Panel title="Weekday ranking">
                                    <RateTable
                                        rows={(insights?.by_fill_day || []).map((r) => ({
                                            ...r,
                                            label: dayNamesFull[r.day] || r.day_name
                                        }))}
                                        nameKey="label"
                                        nameHeader="Day"
                                        empty="No day data"
                                    />
                                </Panel>
                            </div>
                        </TabsContent>

                        {/* CV & style */}
                        <TabsContent value="cv" className="mt-0 space-y-3">
                            <div className="grid gap-3 lg:grid-cols-2">
                                <Panel title="CV template + font">
                                    <div className="space-y-3">
                                        <HorizontalBarChart
                                            items={templateBars}
                                            accent={CHART.primary}
                                            emptyText="No template data"
                                            maxItems={8}
                                        />
                                        <div className="overflow-x-auto">
                                            <table className="w-full min-w-[360px] text-left text-xs">
                                                <thead>
                                                    <tr className="border-b border-white/[0.06] text-white/40">
                                                        <th className="py-1.5 pr-2 font-medium">Template</th>
                                                        <th className="py-1.5 pr-2 font-medium">Font</th>
                                                        <th className="py-1.5 pr-2 font-medium">Bids</th>
                                                        <th className="py-1.5 pr-2 font-medium">Int.</th>
                                                        <th className="py-1.5 font-medium">Rate</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {(insights?.by_template || []).map((r, i) => (
                                                        <tr key={i} className="border-b border-white/[0.04]">
                                                            <td className="py-1.5 pr-2">
                                                                {r.template_id != null ? `#${r.template_id}` : '—'}
                                                            </td>
                                                            <td className="py-1.5 pr-2">{r.font_family || '—'}</td>
                                                            <td className="py-1.5 pr-2 tabular-nums">{r.total}</td>
                                                            <td className="py-1.5 pr-2 tabular-nums text-emerald-400">
                                                                {r.interview}
                                                            </td>
                                                            <td className="py-1.5 tabular-nums">{pct(r.interview_rate)}</td>
                                                        </tr>
                                                    ))}
                                                    {!(insights?.by_template || []).length ? (
                                                        <tr>
                                                            <td colSpan={5} className="py-2 text-white/40">
                                                                No CV template data yet
                                                            </td>
                                                        </tr>
                                                    ) : null}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </Panel>
                                <Panel title="Font / CV style">
                                    <div className="space-y-3">
                                        <HorizontalBarChart
                                            items={fontBars}
                                            accent={CHART.secondary}
                                            emptyText="No font data"
                                            maxItems={8}
                                        />
                                        <RateTable
                                            rows={insights?.by_font}
                                            nameKey="font_family"
                                            nameHeader="Font"
                                            empty="No font data"
                                        />
                                    </div>
                                </Panel>
                            </div>

                            <div className="grid gap-3 lg:grid-cols-2">
                                <Panel title="Answers provider">
                                    <RateTable
                                        rows={(insights?.by_answers_provider || []).map((r) => ({
                                            ...r,
                                            name: r.provider
                                        }))}
                                        nameKey="name"
                                        nameHeader="Provider"
                                        empty="No answers provider data"
                                    />
                                </Panel>
                                <Panel title="CV provider">
                                    <RateTable
                                        rows={(insights?.by_cv_provider || []).map((r) => ({
                                            ...r,
                                            name: r.provider
                                        }))}
                                        nameKey="name"
                                        nameHeader="Provider"
                                        empty="No CV provider data"
                                    />
                                </Panel>
                            </div>

                            <div className="grid gap-3 lg:grid-cols-2">
                                <Panel
                                    title="Salary (analytics only)"
                                    hint="Historical averages — autofill still picks per job from JD ∩ profile"
                                >
                                    <div className="space-y-1.5 text-sm">
                                        <p>
                                            Interview wins:{' '}
                                            <span className="font-semibold tabular-nums text-emerald-400">
                                                {money(salary?.avg_interview)}
                                            </span>
                                            <span className="text-white/40">
                                                {' '}· {salary?.interview_samples || 0} samples
                                            </span>
                                        </p>
                                        <p className="text-white/50">
                                            Other courses: {money(salary?.avg_other)}
                                            <span className="text-white/35">
                                                {' '}· {salary?.other_samples || 0} samples
                                            </span>
                                        </p>
                                    </div>
                                </Panel>
                                <Panel title="Answer style by question type" hint="From interview wins">
                                    {(playbook?.styles_by_cluster || []).length ? (
                                        <ul className="space-y-1.5 text-xs">
                                            {playbook.styles_by_cluster.map((s) => (
                                                <li
                                                    key={s.cluster}
                                                    className="rounded-md border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5"
                                                >
                                                    <div className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                                                        {s.cluster}
                                                        {s.length_band ? ` · ${s.length_band}` : ''}
                                                        {s.human_like ? ' · human' : ''}
                                                        {s.sample_count ? ` · n=${s.sample_count}` : ''}
                                                    </div>
                                                    <div className="mt-0.5 text-white/75">{s.description}</div>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <p className="text-xs text-white/40">
                                            Need interview wins with saved answers to learn style clusters.
                                        </p>
                                    )}
                                </Panel>
                            </div>
                        </TabsContent>

                        {/* Usage */}
                        <TabsContent value="usage" className="mt-0 space-y-3">
                            <p className="text-xs text-white/45">
                                Each successful MiniMax API call = <span className="font-medium text-white/80">1 chat</span>.
                            </p>
                            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                                <Kpi
                                    label="Today"
                                    value={
                                        limits?.day
                                            ? `${cc.today ?? 0} / ${limits.day}`
                                            : (cc.today ?? 0)
                                    }
                                />
                                <Kpi label="Last 5 hours" value={cc.last_5_hours ?? 0} />
                                <Kpi label="Last 7 days" value={cc.last_7_days ?? 0} />
                                <Kpi
                                    label={`Period (${usage?.since_days ?? 30}d)`}
                                    value={cc.period ?? usage?.total_calls ?? 0}
                                />
                            </div>
                            <div className="grid gap-3 lg:grid-cols-2">
                                <Panel title="Chats by type">
                                    <HorizontalBarChart
                                        items={chatKindBars}
                                        accent={CHART.primary}
                                        emptyText="No MiniMax chats recorded yet"
                                        maxItems={8}
                                    />
                                </Panel>
                                <Panel title="Recent MiniMax calls" hint="1 row = 1 chat">
                                    {(usage?.recent || []).length ? (
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-left text-xs">
                                                <thead>
                                                    <tr className="border-b border-white/[0.06] text-white/40">
                                                        <th className="py-1.5 pr-2 font-medium">When</th>
                                                        <th className="py-1.5 pr-2 font-medium">Type</th>
                                                        <th className="py-1.5 font-medium">Model</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {usage.recent.slice(0, 12).map((row) => (
                                                        <tr key={row.id} className="border-b border-white/[0.04]">
                                                            <td className="whitespace-nowrap py-1.5 pr-2 text-white/45">
                                                                {row.created_at
                                                                    ? new Date(row.created_at).toLocaleString()
                                                                    : '—'}
                                                            </td>
                                                            <td className="py-1.5 pr-2 capitalize text-white/80">
                                                                {row.kind === 'chat' ? 'Generate chat' : row.kind}
                                                            </td>
                                                            <td className="py-1.5 font-mono text-[11px] text-white/60">
                                                                {row.model || '—'}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    ) : (
                                        <p className="text-xs text-white/40">No calls logged yet.</p>
                                    )}
                                </Panel>
                            </div>
                        </TabsContent>

                        {/* Briefing */}
                        <TabsContent value="briefing" className="mt-0 space-y-3">
                            <Panel
                                title="MiniMax pipeline read"
                                hint={
                                    analysisMeta?.generated_at
                                        ? `Generated ${new Date(analysisMeta.generated_at).toLocaleString()}`
                                            + (analysisMeta.model ? ` · ${analysisMeta.model}` : '')
                                        : 'Optional narrative (counts as 1 chat).'
                                }
                            >
                                {analysis ? (
                                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-white/85">
                                        {analysis}
                                    </pre>
                                ) : (
                                    <p className="text-sm text-white/40">
                                        Click MiniMax briefing for a short text summary of your bid analytics.
                                    </p>
                                )}
                            </Panel>
                        </TabsContent>
                    </Tabs>
                )}
            </div>
        </AppPage>
    );
}

export default Analyze;
