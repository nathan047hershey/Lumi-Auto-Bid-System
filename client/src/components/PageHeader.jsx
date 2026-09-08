import { cn } from '@/lib/utils';

/**
 * New-app page title — compact toolbar hierarchy.
 */
export default function PageHeader({
    icon: Icon,
    title,
    description,
    meta,
    actions,
    className
}) {
    if (!title && !Icon && !description && !meta) {
        if (!actions) return null;
        return (
            <div className={cn('flex flex-wrap items-center justify-end gap-2', className)}>
                {actions}
            </div>
        );
    }

    return (
        <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between', className)}>
            <div className="min-w-0 max-w-3xl">
                <div className="flex items-center gap-2">
                    {Icon ? (
                        <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                            <Icon className="h-4 w-4" aria-hidden />
                        </span>
                    ) : null}
                    {title ? (
                        <h1 className="font-display text-xl font-semibold tracking-tight text-white sm:text-2xl">
                            {title}
                        </h1>
                    ) : null}
                </div>
                {description ? (
                    <p className="mt-1.5 text-sm leading-snug text-white/45">
                        {description}
                    </p>
                ) : null}
                {meta ? (
                    <p className="mt-1 font-mono text-[11px] text-white/35">{meta}</p>
                ) : null}
            </div>
            {actions ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
            ) : null}
        </div>
    );
}
