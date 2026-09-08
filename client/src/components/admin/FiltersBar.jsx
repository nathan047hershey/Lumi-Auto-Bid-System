import { useEffect, useMemo } from 'react';
import { Users, CalendarRange, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import { DatePicker } from '@/components/DatePicker';
import PeriodPills, { ADMIN_PERIOD_OPTIONS } from '@/components/dashboard/PeriodPills';
import { cn } from '@/lib/utils';

/**
 * Compact admin dashboard toolbar — period pills, user scope, optional custom range.
 */
export default function FiltersBar({
    period,
    customRange,
    userId,
    users,
    usersLoading,
    onPeriodChange,
    onCustomRangeChange,
    onUserChange,
    onReset,
    loading,
    className
}) {
    const isCustom = period === 'custom';

    useEffect(() => {
        if (!isCustom) return;
        if (customRange?.from && customRange?.to && customRange.from > customRange.to) {
            onCustomRangeChange({ from: customRange.to, to: customRange.from });
        }
    }, [isCustom, customRange?.from, customRange?.to]); // eslint-disable-line react-hooks/exhaustive-deps

    const userOptions = useMemo(() => {
        const list = Array.isArray(users) ? users : [];
        return list.map((u) => ({ value: String(u.id), label: u.username }));
    }, [users]);

    const hasActiveFilters = (period && period !== '24h') || userId;

    const selectedUserLabel = userId
        ? userOptions.find((o) => o.value === String(userId))?.label
        : null;

    return (
        <div className={cn('space-y-3', className)}>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        Period
                    </span>
                    <PeriodPills
                        options={ADMIN_PERIOD_OPTIONS}
                        value={period || '24h'}
                        onChange={onPeriodChange}
                        disabled={loading}
                    />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        value={userId ? String(userId) : 'all'}
                        onValueChange={(v) => onUserChange(v === 'all' ? '' : v)}
                        disabled={loading || usersLoading}
                    >
                        <SelectTrigger className="h-9 w-[180px] border-border/60 bg-background/40">
                            <div className="flex items-center gap-2">
                                <Users className="h-3.5 w-3.5 text-muted-foreground" />
                                <SelectValue placeholder="All users" />
                            </div>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All users</SelectItem>
                            {userOptions.map((u) => (
                                <SelectItem key={u.value} value={u.value}>
                                    {u.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    {hasActiveFilters && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={onReset}
                            disabled={loading}
                            className="h-9 text-xs"
                        >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Reset
                        </Button>
                    )}
                </div>
            </div>

            {isCustom && (
                <div className="flex flex-col gap-3 rounded-lg border border-border/50 bg-background/30 p-3 sm:flex-row sm:items-end">
                    <div className="flex-1 space-y-1.5">
                        <Label htmlFor="from-input" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            From
                        </Label>
                        <div className="flex items-center gap-2">
                            <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <DatePicker
                                id="from-input"
                                className="flex-1"
                                value={customRange?.from || ''}
                                onChange={(e) =>
                                    onCustomRangeChange({
                                        ...(customRange || {}),
                                        from: e.target.value
                                    })
                                }
                                disabled={loading}
                                placeholder="From"
                            />
                        </div>
                    </div>
                    <div className="flex-1 space-y-1.5">
                        <Label htmlFor="to-input" className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            To
                        </Label>
                        <div className="flex items-center gap-2">
                            <CalendarRange className="h-4 w-4 shrink-0 text-muted-foreground" />
                            <DatePicker
                                id="to-input"
                                className="flex-1"
                                value={customRange?.to || ''}
                                onChange={(e) =>
                                    onCustomRangeChange({
                                        ...(customRange || {}),
                                        to: e.target.value
                                    })
                                }
                                disabled={loading}
                                placeholder="To"
                            />
                        </div>
                    </div>
                    {(!customRange?.from || !customRange?.to) && (
                        <p className="text-xs text-amber-500 sm:pb-2">
                            Select both dates to apply the custom range.
                        </p>
                    )}
                </div>
            )}

            {(selectedUserLabel || (period && period !== '24h')) && (
                <div className="flex flex-wrap gap-2 font-mono text-[10px] text-muted-foreground">
                    {period && period !== '24h' && (
                        <span className="rounded-md border border-border/50 bg-card/40 px-2 py-0.5">
                            {ADMIN_PERIOD_OPTIONS.find((p) => p.value === period)?.label || period}
                        </span>
                    )}
                    {selectedUserLabel && (
                        <span className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-primary">
                            @{selectedUserLabel}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
