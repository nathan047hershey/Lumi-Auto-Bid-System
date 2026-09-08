import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import BarChart from '@/components/dashboard/BarChart';
import { CHART_SERIES } from '@/lib/chartTheme';

const PERIOD_LABELS = {
    workday: 'Workday',
    week: 'Week',
    month: 'Month',
    '24h': '24h',
    '7d': '7 days',
    '30d': '30 days'
};

/**
 * Compare applied / replied / scheduled across standard periods.
 */
export default function PeriodCompareChart({ periods = {} }) {
    const { data, series } = useMemo(() => {
        const keys = ['workday', 'week', 'month'].filter((k) => periods[k]);
        const chartData = keys.map((key) => {
            const p = periods[key] || {};
            return {
                label: PERIOD_LABELS[key] || key,
                values: {
                    applied: p.appliedCount || 0,
                    replied: p.repliedCount || 0,
                    scheduled: p.scheduledCount || 0
                }
            };
        });

        return {
            data: chartData,
            series: CHART_SERIES
        };
    }, [periods]);

    return (
        <Card className="border-white/[0.08] bg-card/80">
            <CardHeader className="pb-2">
                <CardTitle className="font-display text-base">Period comparison</CardTitle>
                <CardDescription>Workday vs week vs month side by side</CardDescription>
            </CardHeader>
            <CardContent>
                <BarChart
                    data={data}
                    series={series}
                    height={200}
                    emptyText="Period data not available yet"
                />
            </CardContent>
        </Card>
    );
}
