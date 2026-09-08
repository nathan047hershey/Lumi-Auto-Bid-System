import { useMemo } from 'react';
import { Activity, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import LineChart from '@/components/LineChart';
import BarChart from '@/components/dashboard/BarChart';
import { formatDateTime } from '@/lib/utils';
import { CHART, CHART_SERIES } from '@/lib/chartTheme';

const CARD = 'border-white/[0.08] bg-card/80';

/**
 * Daily volume bar chart — uses server dailyBuckets when available.
 */
export function DailyVolumeChart({
    dailyBuckets = [],
    periodStart,
    periodEnd,
    scopeLabel
}) {
    const chartData = useMemo(
        () =>
            dailyBuckets.map((d) => ({
                label: d.label || d.date,
                values: {
                    applied: d.applied || 0,
                    replied: d.replied || 0,
                    scheduled: d.scheduled || 0
                }
            })),
        [dailyBuckets]
    );

    const lineData = useMemo(
        () =>
            dailyBuckets.map((d) => ({
                x: d.date,
                y: d.applied || 0,
                secondary: d.scheduled || 0,
                label: d.label
            })),
        [dailyBuckets]
    );

    const max = Math.max(
        ...lineData.map((d) => d.y),
        ...lineData.map((d) => d.secondary || 0),
        1
    );

    return (
        <div className="space-y-4">
            <Card className={CARD}>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/20 text-primary">
                            <BarChart3 className="h-5 w-5" />
                        </div>
                        <div>
                            <CardTitle className="font-display text-base text-foreground">Daily volume</CardTitle>
                            <CardDescription className="text-muted-foreground">
                                {scopeLabel ? `${scopeLabel} · ` : ''}
                                {formatDateTime(periodStart)} → {formatDateTime(periodEnd)}
                            </CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <BarChart
                        data={chartData}
                        series={CHART_SERIES}
                        height={220}
                        emptyText="No daily activity in this range"
                    />
                </CardContent>
            </Card>

            <Card className={CARD}>
                <CardHeader className="pb-3">
                    <CardTitle className="font-display text-base text-foreground">Applied trend</CardTitle>
                    <CardDescription className="text-muted-foreground">
                        Applied per day vs interviews scheduled
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <LineChart
                        data={lineData}
                        height={200}
                        accent={CHART.primary}
                        secondary={CHART.tertiary}
                        primaryLabel="Applied"
                        secondaryLabel="Scheduled"
                        yMax={max + 2}
                        emptyText="No trend data yet"
                    />
                </CardContent>
            </Card>
        </div>
    );
}

/**
 * Workday view — hourly cumulative line + hourly delta bars.
 */
export function WorkdayVolumeCharts({
    buckets = [],
    periodStart,
    periodEnd,
    scopeLabel
}) {
    const lineData = buckets.map((b) => ({
        x: b.index,
        y: b.applied,
        secondary: b.newApplied,
        label: b.hourLabel
    }));

    const barData = buckets.map((b) => ({
        label: b.hourLabel,
        values: {
            applied: b.newApplied || 0,
            scheduled: b.newScheduled || 0
        }
    }));

    const maxCumulative = Math.max(...lineData.map((d) => d.y), 1);
    const maxDelta = Math.max(...barData.flatMap((d) => [d.values.applied, d.values.scheduled]), 1);

    return (
        <div className="space-y-4">
            <Card className={CARD}>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/20 text-primary">
                            <Activity className="h-5 w-5" />
                        </div>
                        <div>
                            <CardTitle className="font-display text-base text-foreground">Workday cumulative</CardTitle>
                            <CardDescription className="text-muted-foreground">
                                {scopeLabel ? `${scopeLabel} · ` : ''}
                                {formatDateTime(periodStart)} → {formatDateTime(periodEnd)} (EST)
                            </CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent>
                    <LineChart
                        data={lineData}
                        height={220}
                        accent={CHART.primary}
                        secondary={CHART.secondary}
                        primaryLabel="Cumulative applied"
                        secondaryLabel="New this hour"
                        yMax={Math.max(maxCumulative, maxDelta) + 2}
                        emptyText="No application activity in the workday window yet"
                    />
                </CardContent>
            </Card>

            <Card className={CARD}>
                <CardHeader className="pb-3">
                    <CardTitle className="font-display text-base text-foreground">Hourly activity</CardTitle>
                    <CardDescription className="text-muted-foreground">
                        New applications and interviews scheduled per hour
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <BarChart
                        data={barData}
                        series={[
                            { key: 'applied', label: 'New applied', color: CHART.applied },
                            { key: 'scheduled', label: 'New scheduled', color: CHART.scheduled }
                        ]}
                        height={200}
                        emptyText="No hourly activity yet"
                    />
                </CardContent>
            </Card>
        </div>
    );
}
