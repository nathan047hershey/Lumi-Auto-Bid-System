import PageHeader from '@/components/PageHeader';
import { cn } from '@/lib/utils';

/**
 * Page shell. Prefer putting search/filters/actions in PageCommandBar inside children
 * so embedded hub tabs never get an orphan floating button strip.
 */
export default function AppPage({
    icon,
    title,
    description,
    meta,
    actions,
    filters,
    footer,
    children,
    flush = false,
    embedded = false,
    className
}) {
    // Embedded hub pages: title lives in subnav — only show a thin meta row if needed.
    // Do NOT render a standalone actions strip (that looked like the old broken header).
    const showTitleHeader = !embedded && !!(title || icon || description || meta || actions);
    const showEmbeddedMeta = embedded && !!meta && !actions && !filters;

    return (
        <div className={cn('flex min-h-full w-full flex-col', className)}>
            {showTitleHeader && (
                <div className="shrink-0 border-b border-white/[0.06] px-3 py-3 sm:px-4 lg:px-5">
                    <PageHeader
                        icon={icon}
                        title={title}
                        description={description}
                        meta={meta}
                        actions={actions}
                    />
                </div>
            )}

            {showEmbeddedMeta && (
                <div className="shrink-0 border-b border-white/[0.06] px-4 py-2 sm:px-6 lg:px-8">
                    <p className="font-mono text-[11px] text-white/35">{meta}</p>
                </div>
            )}

            {/* Legacy filters slot — prefer PageCommandBar inside children */}
            {filters && !embedded && (
                <div className="shrink-0 border-b border-white/[0.06] bg-black/15 px-4 py-3 sm:px-6 lg:px-8">
                    {filters}
                </div>
            )}

            <div className={cn('min-h-0 flex-1', flush ? 'flex flex-col' : 'px-3 py-3 sm:px-4 sm:py-4 lg:px-5')}>
                {/* When embedded + legacy filters/actions were passed, fold into content top */}
                {embedded && (actions || filters) ? (
                    <div className="mb-4 space-y-3">
                        {actions || filters ? (
                            <div className="rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.85)] p-3 sm:p-4">
                                {actions ? (
                                    <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
                                        {actions}
                                    </div>
                                ) : null}
                                {filters}
                            </div>
                        ) : null}
                        {children}
                    </div>
                ) : (
                    children
                )}
            </div>

            {footer && (
                <div className="shrink-0 border-t border-white/[0.06] px-4 py-3 font-mono text-xs text-white/35 sm:px-6 lg:px-8">
                    {footer}
                </div>
            )}
        </div>
    );
}
