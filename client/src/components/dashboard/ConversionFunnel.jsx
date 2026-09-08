import { cn } from '@/lib/utils';
import { CHART } from '@/lib/chartTheme';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ArrowDown } from 'lucide-react';

const STEPS = [
    { key: 'applied', label: 'Applied', theme: CHART.funnel.applied },
    { key: 'replied', label: 'Replied', theme: CHART.funnel.replied },
    { key: 'scheduled', label: 'Interviews', theme: CHART.funnel.scheduled }
];

export default function ConversionFunnel({
    applied = 0,
    replied = 0,
    scheduled = 0,
    onInterviewClick,
    className
}) {
    const values = { applied, replied, scheduled };
    const replyRate = applied > 0 ? Math.round((replied / applied) * 100) : 0;
    const interviewRate = applied > 0 ? Math.round((scheduled / applied) * 100) : 0;

    return (
        <Card className={cn('border-white/[0.08] bg-card/80 h-full', className)}>
            <CardHeader className="pb-2">
                <CardTitle className="font-display text-base">Funnel</CardTitle>
                <CardDescription>Applied → replied → interviews</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
                {STEPS.map((step, i) => {
                    const value = values[step.key];
                    const clickable = step.key === 'scheduled' && scheduled > 0 && onInterviewClick;
                    const width =
                        step.key === 'applied'
                            ? '100%'
                            : applied > 0
                              ? `${Math.max(35, (value / applied) * 100)}%`
                              : '35%';

                    const body = (
                        <div
                            className="rounded-md border-2 px-3 py-2 text-center text-white"
                            style={{ background: step.theme.bg, borderColor: step.theme.border, maxWidth: width, margin: '0 auto' }}
                        >
                            <p className="text-xl font-bold leading-none">{value}</p>
                            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/90">
                                {step.label}
                            </p>
                        </div>
                    );

                    return (
                        <div key={step.key}>
                            {i > 0 && (
                                <div className="mb-1.5 flex justify-center text-muted-foreground">
                                    <ArrowDown className="h-3 w-3" />
                                </div>
                            )}
                            {clickable ? (
                                <button type="button" onClick={onInterviewClick} className="block w-full">
                                    {body}
                                </button>
                            ) : (
                                body
                            )}
                        </div>
                    );
                })}

                <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3">
                    <div className="rounded-md bg-secondary/60 px-2 py-1.5 text-center">
                        <p className="text-sm font-semibold text-info">{replyRate}%</p>
                        <p className="text-[10px] text-foreground/70">Reply</p>
                    </div>
                    <div className="rounded-md bg-secondary/60 px-2 py-1.5 text-center">
                        <p className="text-sm font-semibold text-success">{interviewRate}%</p>
                        <p className="text-[10px] text-foreground/70">Interview</p>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
