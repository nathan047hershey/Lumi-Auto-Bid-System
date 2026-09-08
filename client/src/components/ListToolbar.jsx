import { cn } from '@/lib/utils';

/**
 * List header above card stacks — select-all, count, optional trailing controls.
 */
export default function ListToolbar({
    leading,
    label,
    trailing,
    className
}) {
    return (
        <div
            className={cn(
                'flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.05] bg-black/20 px-3 py-2',
                className
            )}
        >
            <div className="flex min-w-0 items-center gap-2.5">
                {leading}
                {label ? (
                    <p className="truncate text-xs font-medium text-white/45">{label}</p>
                ) : null}
            </div>
            {trailing ? <div className="flex flex-wrap items-center gap-2">{trailing}</div> : null}
        </div>
    );
}
