import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

const TONE_STYLES = {
    warning: {
        box: 'border-amber-500/45 bg-amber-500/12',
        title: 'text-amber-200',
        body: 'text-foreground/90',
        icon: 'text-amber-300'
    },
    info: {
        box: 'border-cyan-500/40 bg-cyan-500/10',
        title: 'text-cyan-100',
        body: 'text-foreground/90',
        icon: 'text-cyan-300'
    },
    neutral: {
        box: 'border-border bg-secondary',
        title: 'text-foreground',
        body: 'text-foreground/85',
        icon: 'text-foreground/70'
    }
};

/**
 * Expandable notice — readable on dark backgrounds.
 */
export default function CollapsibleNotice({
    title,
    children,
    tone = 'warning',
    defaultOpen = false,
    className
}) {
    const [open, setOpen] = useState(defaultOpen);
    const styles = TONE_STYLES[tone] || TONE_STYLES.neutral;

    return (
        <div className={cn('overflow-hidden rounded-lg border', styles.box, className)}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium"
            >
                <Info className={cn('h-4 w-4 shrink-0', styles.icon)} />
                <span className={cn('flex-1', styles.title)}>{title}</span>
                <ChevronDown className={cn('h-4 w-4 shrink-0 text-foreground/60 transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
                <div className={cn('border-t border-border/60 px-3 py-3 text-sm leading-relaxed', styles.body)}>
                    {children}
                </div>
            )}
        </div>
    );
}
