import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

const TONE_DOT = {
    neutral: 'bg-zinc-400',
    success: 'bg-emerald-400',
    warning: 'bg-amber-400',
    info: 'bg-cyan-400',
    danger: 'bg-red-400'
};

const TONE_VALUE = {
    neutral: 'text-foreground',
    success: 'text-emerald-300',
    warning: 'text-amber-300',
    info: 'text-cyan-300',
    danger: 'text-red-300'
};

function StatusItem({ tone = 'neutral', label, value }) {
    return (
        <div className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/65">
                {label}
            </span>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone] || TONE_DOT.neutral, tone === 'info' && 'animate-pulse')} />
            <span className={cn('text-xs font-semibold leading-none', TONE_VALUE[tone] || TONE_VALUE.neutral)}>
                {value}
            </span>
        </div>
    );
}

/**
 * Ops status row — compact horizontal tiles (label + value on one line).
 */
export default function StatusStrip({ items = [], trailing, className }) {
    if (!items.length && !trailing) return null;
    return (
        <div className={cn('flex flex-nowrap items-center gap-2 overflow-x-auto', className)}>
            {items.map((item) => (
                <StatusItem key={item.key || item.label} {...item} />
            ))}
            {trailing}
        </div>
    );
}

export function StatusBadge({ variant = 'muted', children, className }) {
    return (
        <Badge variant={variant} className={cn('text-[11px] font-semibold uppercase tracking-wide', className)}>
            {children}
        </Badge>
    );
}
