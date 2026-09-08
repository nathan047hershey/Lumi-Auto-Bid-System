import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import DonutChart from '@/components/dashboard/DonutChart';
import { PieChart } from 'lucide-react';

const STATUS_COLORS = {
    pending: '#a1a1aa',
    applied: '#67e8f9',
    interview: '#5eead4',
    rejected: '#f87171'
};

const STATUS_LABELS = {
    pending: 'Pending',
    applied: 'Applied',
    interview: 'Interview',
    rejected: 'Rejected'
};

export default function StatusDistributionChart({ statuses = {}, title = 'Pipeline status', description }) {
    const segments = ['pending', 'applied', 'interview', 'rejected'].map((key) => ({
        label: STATUS_LABELS[key],
        value: statuses[key] || 0,
        color: STATUS_COLORS[key]
    }));

    return (
        <Card className="border-white/[0.08] bg-card/80">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 font-display text-base">
                    <PieChart className="h-4 w-4 text-primary" />
                    {title}
                </CardTitle>
                {description && <CardDescription>{description}</CardDescription>}
            </CardHeader>
            <CardContent>
                <DonutChart segments={segments} emptyText="No applications yet" />
            </CardContent>
        </Card>
    );
}

/**
 * Sum lifetime statuses across all users (admin org-wide view).
 */
export function aggregateUserStatuses(users = []) {
    const out = { pending: 0, applied: 0, interview: 0, rejected: 0, total: 0 };
    for (const u of users) {
        const s = u.statuses || {};
        for (const key of ['pending', 'applied', 'interview', 'rejected']) {
            out[key] += s[key] || 0;
        }
        out.total += s.total || 0;
    }
    return out;
}
