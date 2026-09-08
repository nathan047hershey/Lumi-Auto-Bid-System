import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import { userAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

function pct(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return `${n}%`;
}

function money(n) {
    if (n == null) return '—';
    return `$${Number(n).toLocaleString('en-US')}`;
}

function BidInsights({ embedded = false }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const { data: insights } = await userAPI.getBidInsights();
            setData(insights);
        } catch (err) {
            console.error('Failed to load bid insights:', err);
            setError(err.response?.data?.error || 'Failed to load bid insights');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const summary = data?.summary;
    const playbook = data?.playbook;

    return (
        <AppPage
            embedded={embedded}
            icon={TrendingUp}
            title="Bid insights"
            description="What your bid courses and interviews suggest works — used to improve autofill answers."
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Bid insights</p>
                            <p className="truncate text-xs text-white/40">
                                Interview patterns that guide autofill answers
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" onClick={load} disabled={loading}>
                            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                />

                {error && (
                    <div className="rounded-xl border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-red-200">
                        {error}
                    </div>
                )}

                {loading && !data ? (
                    <p className="text-sm text-white/40">Loading insights…</p>
                ) : (
                    <div className="space-y-6">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardDescription>Courses logged</CardDescription>
                                    <CardTitle className="text-2xl">{summary?.courses ?? 0}</CardTitle>
                                </CardHeader>
                            </Card>
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardDescription>Applied</CardDescription>
                                    <CardTitle className="text-2xl">{summary?.applied ?? 0}</CardTitle>
                                </CardHeader>
                            </Card>
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardDescription>Interviews</CardDescription>
                                    <CardTitle className="text-2xl">{summary?.interview ?? 0}</CardTitle>
                                </CardHeader>
                            </Card>
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardDescription>Interview rate (of applied)</CardDescription>
                                    <CardTitle className="text-2xl">{pct(summary?.interview_rate)}</CardTitle>
                                </CardHeader>
                            </Card>
                        </div>

                        {data?.bidder_ops && (
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">Bidder Ops</CardTitle>
                                    <CardDescription>
                                        How Auto Bidder ran recently — funnel, lanes, CAPTCHA, incompletes (Studying Engine).
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4 text-sm">
                                    <div className="grid gap-2 sm:grid-cols-5">
                                        {[
                                            ['Opened', data.bidder_ops.funnel?.opened],
                                            ['Form', data.bidder_ops.funnel?.form_ready],
                                            ['Filled', data.bidder_ops.funnel?.filled],
                                            ['Submit', data.bidder_ops.funnel?.submit_clicked],
                                            ['Applied', data.bidder_ops.funnel?.applied]
                                        ].map(([label, n]) => (
                                            <div key={label} className="rounded-lg border border-white/10 px-3 py-2">
                                                <p className="text-xs text-white/40">{label}</p>
                                                <p className="text-lg font-semibold text-white/90">{n ?? 0}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-3 text-xs text-white/60">
                                        <span>Stuck: {data.bidder_ops.stuck ?? 0}</span>
                                        <span>Memory hits: {data.bidder_ops.memory_hits ?? 0}</span>
                                        <span>
                                            Unique avg sim:{' '}
                                            {data.bidder_ops.unique_health?.avg_similarity ?? '—'}
                                        </span>
                                        <span>
                                            CAPTCHA clear/abandon:{' '}
                                            {data.bidder_ops.captcha_rollup?.clear ?? 0}
                                            /
                                            {data.bidder_ops.captcha_rollup?.abandon ?? 0}
                                        </span>
                                    </div>
                                    {data.bidder_ops.lane_mix && (
                                        <div>
                                            <p className="mb-1 text-xs font-medium text-white/50">Lane mix</p>
                                            <div className="flex flex-wrap gap-2">
                                                {Object.entries(data.bidder_ops.lane_mix).map(([lane, n]) => (
                                                    n > 0 ? (
                                                        <span
                                                            key={lane}
                                                            className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-white/70"
                                                        >
                                                            {lane}: {n}
                                                        </span>
                                                    ) : null
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                    {Array.isArray(data.bidder_ops.incomplete_top)
                                        && data.bidder_ops.incomplete_top.length > 0 && (
                                        <div>
                                            <p className="mb-1 text-xs font-medium text-white/50">Top incomplete labels</p>
                                            <ul className="list-inside list-disc text-white/70">
                                                {data.bidder_ops.incomplete_top.slice(0, 8).map((row) => (
                                                    <li key={row.label}>
                                                        {row.label}
                                                        {' '}
                                                        ({row.count})
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                    {Array.isArray(data.answer_clusters)
                                        && data.answer_clusters.length > 0 && (
                                        <div>
                                            <p className="mb-1 text-xs font-medium text-white/50">Answer clusters</p>
                                            <div className="flex flex-wrap gap-2">
                                                {data.answer_clusters.slice(0, 10).map((c) => (
                                                    <span
                                                        key={c.cluster}
                                                        className="rounded-full border border-white/10 px-2 py-0.5 text-xs text-white/70"
                                                    >
                                                        {c.cluster}
                                                        {' '}
                                                        ({(c.interview_examples?.length || 0)
                                                            + (c.other_examples?.length || 0)})
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Winning playbook</CardTitle>
                                <CardDescription>
                                    Learns answer *style* from interview wins (short, human-sounding, etc.).
                                    Content stays unique per company/role. Add interview milestones to teach.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-3 text-sm">
                                {!playbook?.interview_count ? (
                                    <p className="text-muted-foreground">
                                        No interview outcomes yet. Generate → fill → apply, then add an
                                        interview milestone when you get one. Insights appear here and
                                        guide future answers.
                                    </p>
                                ) : (
                                    <>
                                        {playbook.preferred_fill_hours?.length > 0 && (
                                            <p>
                                                <span className="font-medium">Stronger fill hours: </span>
                                                {playbook.preferred_fill_hours.map((h) => `${h}:00`).join(', ')}
                                            </p>
                                        )}
                                        {playbook.preferred_template_id != null && (
                                            <p>
                                                <span className="font-medium">CV template correlated with interviews: </span>
                                                #{playbook.preferred_template_id}
                                                {playbook.preferred_font_family
                                                    ? ` (${playbook.preferred_font_family})`
                                                    : ''}
                                            </p>
                                        )}
                                        {playbook.answer_style_description && (
                                            <p>
                                                <span className="font-medium">Answer style: </span>
                                                {playbook.answer_style_description}
                                            </p>
                                        )}
                                        {playbook.salary_note && (
                                            <p className="text-muted-foreground">{playbook.salary_note}</p>
                                        )}
                                        {(playbook.styles_by_cluster || []).length > 0 && (
                                            <div className="space-y-2">
                                                <div className="font-medium">Style by question type</div>
                                                <p className="text-xs text-muted-foreground">
                                                    Learned length/tone only — each new job still gets a fresh,
                                                    company-specific answer (Google ≠ Amazon).
                                                </p>
                                                <ul className="space-y-2">
                                                    {playbook.styles_by_cluster.map((s) => (
                                                        <li
                                                            key={s.cluster}
                                                            className="rounded-md border border-border px-3 py-2"
                                                        >
                                                            <div className="text-xs uppercase tracking-wide text-muted-foreground">
                                                                {s.cluster}
                                                                {s.length_band ? ` · ${s.length_band}` : ''}
                                                                {s.human_like ? ' · human' : ''}
                                                            </div>
                                                            <div className="mt-1">{s.description}</div>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </>
                                )}
                            </CardContent>
                        </Card>

                        <div className="grid gap-4 lg:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">Fill hour vs interviews</CardTitle>
                                    <CardDescription>Which clock hours correlate with more interviews</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {(data?.by_fill_hour || []).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">No fill timestamps yet.</p>
                                    ) : (
                                        <ul className="space-y-1 text-sm">
                                            {(data.by_fill_hour || []).slice(0, 8).map((row) => (
                                                <li key={row.hour} className="flex justify-between gap-2">
                                                    <span>{row.hour}:00</span>
                                                    <span className="text-muted-foreground">
                                                        {row.interview}/{row.total} · {pct(row.interview_rate)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">Fill day vs interviews</CardTitle>
                                    <CardDescription>Which weekdays correlate with more interviews</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {(data?.by_fill_day || []).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">No fill timestamps yet.</p>
                                    ) : (
                                        <ul className="space-y-1 text-sm">
                                            {(data.by_fill_day || []).map((row) => (
                                                <li key={row.day} className="flex justify-between gap-2">
                                                    <span>{row.day_name}</span>
                                                    <span className="text-muted-foreground">
                                                        {row.interview}/{row.total} · {pct(row.interview_rate)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">CV template vs interviews</CardTitle>
                                    <CardDescription>Which resume template / font correlates with interviews</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {(data?.by_template || []).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">No template data yet.</p>
                                    ) : (
                                        <ul className="space-y-1 text-sm">
                                            {(data.by_template || []).slice(0, 8).map((row) => (
                                                <li
                                                    key={String(row.template_id ?? 'none')}
                                                    className="flex justify-between gap-2"
                                                >
                                                    <span>
                                                        {row.template_id != null ? `Template #${row.template_id}` : 'No template'}
                                                        {row.font_family ? ` · ${row.font_family}` : ''}
                                                    </span>
                                                    <span className="text-muted-foreground">
                                                        {row.interview}/{row.total} · {pct(row.interview_rate)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-base">Answers provider vs interviews</CardTitle>
                                    <CardDescription>Local Ollama vs cloud for form answers</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {(data?.by_answers_provider || []).length === 0 ? (
                                        <p className="text-sm text-muted-foreground">No provider data yet.</p>
                                    ) : (
                                        <ul className="space-y-1 text-sm">
                                            {(data.by_answers_provider || []).map((row) => (
                                                <li key={row.provider} className="flex justify-between gap-2">
                                                    <span>{row.provider}</span>
                                                    <span className="text-muted-foreground">
                                                        {row.interview}/{row.total} · {pct(row.interview_rate)}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Salary (analytics only)</CardTitle>
                                <CardDescription>
                                    Historical averages for your curiosity. Autofill still picks a new number
                                    for each job from that posting’s range ∩ your profile range.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="text-sm">
                                <p>
                                    Interview wins: <span className="font-medium">{money(data?.salary?.avg_interview)}</span>
                                    {' '}({data?.salary?.interview_samples || 0} samples)
                                </p>
                                <p className="mt-1 text-muted-foreground">
                                    Other courses: {money(data?.salary?.avg_other)}
                                    {' '}({data?.salary?.other_samples || 0} samples)
                                </p>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Recent courses</CardTitle>
                            </CardHeader>
                            <CardContent>
                                {(data?.recent_courses || []).length === 0 ? (
                                    <p className="text-sm text-muted-foreground">
                                        No courses yet. Use Alt+Shift+G then Alt+Shift+F (or Generate in the app).
                                    </p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-left text-sm">
                                            <thead className="text-muted-foreground">
                                                <tr>
                                                    <th className="py-1 pr-3 font-medium">App</th>
                                                    <th className="py-1 pr-3 font-medium">Company</th>
                                                    <th className="py-1 pr-3 font-medium">Role</th>
                                                    <th className="py-1 pr-3 font-medium">Outcome</th>
                                                    <th className="py-1 pr-3 font-medium">Filled</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(data.recent_courses || []).map((c) => (
                                                    <tr key={c.id} className="border-t border-border">
                                                        <td className="py-1.5 pr-3">#{c.application_id}</td>
                                                        <td className="py-1.5 pr-3">{c.company_name || '—'}</td>
                                                        <td className="py-1.5 pr-3">{c.job_role || '—'}</td>
                                                        <td className="py-1.5 pr-3">{c.outcome}</td>
                                                        <td className="py-1.5 pr-3 text-muted-foreground">
                                                            {c.filled_at
                                                                ? new Date(c.filled_at).toLocaleString()
                                                                : '—'}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>
                )}
            </div>
        </AppPage>
    );
}

export default BidInsights;
