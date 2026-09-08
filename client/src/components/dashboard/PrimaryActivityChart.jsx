import { useMemo } from 'react';
import { Activity, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import BarChart from '@/components/dashboard/BarChart';
import LineChart from '@/components/LineChart';
import { formatDateTime } from '@/lib/utils';
import { CHART, CHART_SERIES } from '@/lib/chartTheme';

const CARD = 'border-white/[0.08] bg-card/80';

/**
 * Single primary chart for the dashboard — no duplicate trend cards.
 */
export default function PrimaryActivityChart({
    isWorkday,
    dailyBuckets = [],
    hourlyBuckets = [],
    periodStart,
    periodEnd,
    scopeLabel
}) {
    const dailyBarData = useMemo(
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

    const hourlyLineData = useMemo(
        () =>
            hourlyBuckets.map((b) => ({
                x: b.index,
                y: b.applied,
                secondary: b.newApplied,
                label: b.hourLabel
            })),
        [hourlyBuckets]
    );

    const hourlyBarData = useMemo(
        () =>
            hourlyBuckets.map((b) => ({
                label: b.hourLabel,
                values: {
                    applied: b.newApplied || 0,
                    scheduled: b.newScheduled || 0
                }
            })),
        [hourlyBuckets]
    );

    const lineMax = Math.max(
        ...hourlyLineData.map((d) => d.y),
        ...hourlyLineData.map((d) => d.secondary || 0),
        1
    );

    if (isWorkday) {
        return (
            <Card className={CARD}>
                <CardHeader className="pb-3">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/20 text-primary">
                            <Activity className="h-4 w-4" />
                        </div>
                        <div>
                            <CardTitle className="font-display text-base">Workday activity</CardTitle>
                            <CardDescription>
                                {scopeLabel ? `${scopeLabel} · ` : ''}
                                {formatDateTime(periodStart)} → {formatDateTime(periodEnd)}
                            </CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-6">
                    <LineChart
                        data={hourlyLineData}
                        height={200}
                        accent={CHART.primary}
                        secondary={CHART.secondary}
                        primaryLabel="Cumulative applied"
                        secondaryLabel="New this hour"
                        yMax={lineMax + 2}
                        emptyText="No activity in this workday yet"
                    />
                    <BarChart
                        data={hourlyBarData}
                        series={[
                            { key: 'applied', label: 'New applied', color: CHART.applied },
                            { key: 'scheduled', label: 'New scheduled', color: CHART.scheduled }
                        ]}
                        height={160}
                        emptyText="No hourly activity yet"
                    />
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className={CARD}>
            <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/20 text-primary">
                        <BarChart3 className="h-4 w-4" />
                    </div>
                    <div>
                        <CardTitle className="font-display text-base">Daily activity</CardTitle>
                        <CardDescription>
                            {scopeLabel ? `${scopeLabel} · ` : ''}
                            {formatDateTime(periodStart)} → {formatDateTime(periodEnd)}
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <BarChart
                    data={dailyBarData}
                    series={CHART_SERIES}
                    height={240}
                    emptyText="No daily activity in this range"
                />
            </CardContent>
        </Card>
    );
}
