import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarChart } from '@/components/dashboard/BarChart';
import { Users } from 'lucide-react';

/**
 * Admin leaderboard — applied count in active period per user.
 */
export default function UserLeaderboard({ users = [], periodLabel = 'period' }) {
    const items = [...users]
        .map((u) => ({
            label: u.username,
            value: u.activePeriod?.appliedCount || 0
        }))
        .filter((u) => u.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);

    if (users.length === 0) return null;

    return (
        <Card className="border-white/[0.08] bg-card/80">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 font-display text-base">
                    <Users className="h-4 w-4 text-primary" />
                    User activity
                </CardTitle>
                <CardDescription>
                    Applications submitted per user in the {periodLabel.toLowerCase()}
                </CardDescription>
            </CardHeader>
            <CardContent>
                {items.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                        No application activity from team members in this period.
                    </p>
                ) : (
                    <HorizontalBarChart items={items} accent="#2dd4bf" maxItems={10} />
                )}
            </CardContent>
        </Card>
    );
}
