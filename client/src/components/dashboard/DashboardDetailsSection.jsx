import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

/**
 * Collapsible block for heavy admin tables (link breakdown, etc.).
 */
export default function DashboardDetailsSection({
    title,
    description,
    badge,
    defaultOpen = false,
    children,
    className
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className={cn('overflow-hidden rounded-xl border border-white/[0.08] bg-card/80', className)}>
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-secondary/40"
            >
                <div className="min-w-0 flex-1">
                    <p className="font-display text-sm font-semibold text-foreground">{title}</p>
                    {description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                    )}
                </div>
                {badge}
                <ChevronDown
                    className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
                />
            </button>
            {open && (
                <div className="border-t border-border px-5 py-4">
                    {children}
                </div>
            )}
        </div>
    );
}
