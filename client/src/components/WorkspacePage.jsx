import { cn } from '@/lib/utils';

/**
 * Two-column workspace for list-heavy pages.
 */
export default function WorkspacePage({
    toolbar,
    sidebar,
    sidebarWidth = 'w-[17.5rem]',
    children,
    className
}) {
    return (
        <div className={cn('flex h-full min-h-0 flex-col', className)}>
            {toolbar && (
                <div className="shrink-0 border-b border-white/[0.06] px-4 py-3 sm:px-6">
                    {toolbar}
                </div>
            )}
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                {sidebar && (
                    <aside
                        className={cn(
                            'shrink-0 border-b border-white/[0.06] bg-black/20 lg:border-b-0 lg:border-r lg:border-white/[0.06]',
                            sidebarWidth
                        )}
                    >
                        <div className="max-h-[40vh] overflow-y-auto p-3 lg:max-h-none lg:sticky lg:top-0 lg:h-full lg:p-4">
                            {sidebar}
                        </div>
                    </aside>
                )}
                <div className="min-w-0 flex-1 overflow-auto p-3 sm:p-4 md:p-5">
                    {children}
                </div>
            </div>
        </div>
    );
}

export function WorkspaceToolbar({ title, eyebrow, meta, actions, className }) {
    return (
        <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between', className)}>
            <div className="min-w-0">
                {eyebrow && (
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary/90">
                        {eyebrow}
                    </p>
                )}
                <h1 className="font-display text-lg font-semibold tracking-tight text-white sm:text-xl">{title}</h1>
                {meta && <p className="mt-1 text-xs text-white/40">{meta}</p>}
            </div>
            {actions && (
                <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
            )}
        </div>
    );
}
