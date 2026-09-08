/**
 * Visual bidding progress — same stages as Auto Bidder status copy /
 * Lumi on-page autofill panel.
 */
import { Progress } from '@/components/ui/progress';
import { BID_PROGRESS_STEPS } from '@/lib/bidCourseFailure';

const TONE = {
    sky: {
        bar: 'bg-primary',
        track: 'bg-primary/20',
        text: 'text-foreground',
        stepOn: 'text-primary',
        stepOff: 'text-muted-foreground/50'
    },
    amber: {
        bar: 'bg-amber-500',
        track: 'bg-amber-500/20',
        text: 'text-amber-50',
        stepOn: 'text-amber-100',
        stepOff: 'text-amber-100/40'
    },
    emerald: {
        bar: 'bg-emerald-500',
        track: 'bg-emerald-500/20',
        text: 'text-emerald-100',
        stepOn: 'text-emerald-200',
        stepOff: 'text-emerald-200/40'
    },
    rose: {
        bar: 'bg-rose-500',
        track: 'bg-rose-500/20',
        text: 'text-rose-100',
        stepOn: 'text-rose-200',
        stepOff: 'text-rose-200/40'
    },
    muted: {
        bar: 'bg-primary',
        track: 'bg-secondary',
        text: 'text-muted-foreground',
        stepOn: 'text-foreground',
        stepOff: 'text-muted-foreground/50'
    }
};

export default function BidProgressBar({
    pct = 0,
    label = '',
    tone = 'sky',
    stepIndex = -1,
    steps = BID_PROGRESS_STEPS,
    compact = false,
    className = ''
}) {
    if (pct <= 0 && !label && stepIndex < 0) return null;
    const t = TONE[tone] || TONE.muted;
    const safePct = Math.max(0, Math.min(100, Number(pct) || 0));

    return (
        <div className={`space-y-1.5 ${className}`}>
            {!(compact && !label) ? (
                <div className={`flex items-center justify-between gap-2 ${compact ? 'text-[10px]' : 'text-[11px]'}`}>
                    <span className={`min-w-0 truncate font-medium ${t.text}`}>
                        {label || 'Bidding…'}
                    </span>
                    <span className={`shrink-0 tabular-nums opacity-90 ${t.text}`}>
                        {safePct}%
                    </span>
                </div>
            ) : null}
            <Progress
                value={safePct}
                className={`h-1.5 ${t.track}`}
                indicatorClassName={`${t.bar} ${tone === 'sky' && safePct > 0 && safePct < 100 ? 'animate-pulse' : ''}`}
            />
            {!compact && steps?.length ? (
                <div className="flex justify-between gap-1">
                    {steps.map((s, i) => {
                        const on = stepIndex >= 0 && i <= stepIndex;
                        return (
                            <span
                                key={s.id}
                                className={`text-[9px] font-semibold uppercase tracking-wide ${
                                    on ? t.stepOn : t.stepOff
                                }`}
                            >
                                {s.label}
                            </span>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
}
