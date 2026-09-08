import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { HorizontalBarChart } from '@/components/dashboard/BarChart';
import { Wrench } from 'lucide-react';

const STACK_COLORS = ['#5eead4', '#67e8f9', '#6ee7b7', '#7dd3fc', '#86efac', '#93c5fd', '#a5f3fc', '#6ee7b7'];

export default function TechStackChart({ techStacks = [], topStack, className }) {
    const items = (techStacks || []).slice(0, 8).map((t, i) => ({
        label: t.skill,
        value: t.count,
        color: STACK_COLORS[i % STACK_COLORS.length]
    }));

    return (
        <Card className="border-white/[0.08] bg-card/80">
            <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                    <div>
                        <CardTitle className="flex items-center gap-2 font-display text-base">
                            <Wrench className="h-4 w-4 text-primary" />
                            Tech stacks
                        </CardTitle>
                        <CardDescription>
                            {topStack
                                ? `Top skill: ${topStack} — from scheduled interviews`
                                : 'Skills mentioned in scheduled interviews'}
                        </CardDescription>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <HorizontalBarChart
                    items={items}
                    emptyText="No tech stack data in this period"
                />
            </CardContent>
        </Card>
    );
}
