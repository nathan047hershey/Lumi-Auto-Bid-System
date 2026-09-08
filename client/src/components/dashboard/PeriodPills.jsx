import { cn } from '@/lib/utils';

/**
 * Segmented period selector — used for admin filters and user scope tabs.
 */
export default function PeriodPills({
    options,
    value,
    onChange,
    disabled = false,
    size = 'default',
    className
}) {
    const sizeClasses = size === 'sm'
        ? 'px-2.5 py-1 text-[11px]'
        : 'px-3 py-1.5 text-xs';

    return (
        <div
            className={cn(
                'inline-flex flex-wrap gap-1 rounded-lg border border-border bg-secondary p-1',
                className
            )}
            role="tablist"
            aria-label="Time period"
        >
            {options.map((opt) => {
                const active = value === opt.value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        disabled={disabled}
                        title={opt.hint}
                        onClick={() => onChange(opt.value)}
                        className={cn(
                            'rounded-md font-medium transition-colors',
                            sizeClasses,
                            active
                                ? 'bg-primary text-primary-foreground shadow-sm'
                                : 'text-foreground/80 hover:bg-accent hover:text-foreground',
                            disabled && 'pointer-events-none opacity-50'
                        )}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

export const ADMIN_PERIOD_OPTIONS = [
    { value: '24h', label: '24h', hint: 'Last 24 hours (7am GMT-4 anchor)' },
    { value: 'workday', label: 'Workday', hint: '7am GMT-4 today → tomorrow' },
    { value: '7d', label: '7 days', hint: 'Rolling 7-day window' },
    { value: '30d', label: '30 days', hint: 'Rolling 30-day window' },
    { value: 'custom', label: 'Custom', hint: 'Pick a date range' }
];

export const USER_PERIOD_OPTIONS = [
    { value: 'workday', label: 'Workday', hint: 'Today\'s workday window' },
    { value: 'week', label: 'Week', hint: 'This week' },
    { value: 'month', label: 'Month', hint: 'This month' }
];
