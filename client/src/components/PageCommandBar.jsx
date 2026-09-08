import { cn } from '@/lib/utils';

/**
 * Unified page command surface — search, filters, and primary actions in one panel.
 * Replaces the old split AppPage actions strip + labeled filter-bar.
 */
export default function PageCommandBar({
    search,
    filters,
    actions,
    chips,
    className
}) {
    return (
        <div
            className={cn(
                'rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.85)] p-3 shadow-[0_16px_48px_-28px_rgba(0,0,0,0.65)] backdrop-blur-sm sm:p-4',
                className
            )}
        >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                {search ? <div className="min-w-0 flex-1">{search}</div> : null}
                {actions ? (
                    <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                        {actions}
                    </div>
                ) : null}
            </div>

            {filters ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                    {filters}
                </div>
            ) : null}

            {chips ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                    {chips}
                </div>
            ) : null}
        </div>
    );
}
