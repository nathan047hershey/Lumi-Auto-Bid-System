import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

/**
 * Renders the current time anchored to GMT-4 (matches the same
 * workday anchor the stats service uses). Updates every second.
 */
export default function EasternClock({
    serverISO,
    label = 'Current time (GMT-4)',
    className,
    showSeconds = true,
    tz = 'Etc/GMT+4'  // sign-inverted in IANA: Etc/GMT+4 == UTC-4
}) {
    const [now, setNow] = useState(() => new Date());

    useEffect(() => {
        if (serverISO) setNow(new Date(serverISO));
    }, [serverISO]);

    useEffect(() => {
        const tick = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(tick);
    }, []);

    const timeFormatter = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        second: showSeconds ? '2-digit' : undefined,
        hour12: true,
        timeZone: tz
    });
    const dayFormatter = new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: tz
    });

    const localParts = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
        timeZone: tz
    }).formatToParts(now);
    const localHour = parseInt(localParts.find((p) => p.type === 'hour')?.value ?? '0', 10);

    // Compute the current "workday" status (before / during / after)
    let workdayLabel = null;
    if (localHour >= 7 && localHour < 22) {
        workdayLabel = 'Workday in session';
    } else if (localHour === 22 || localHour === 23 || localHour < 4) {
        workdayLabel = 'Workday ended';
    } else {
        // 4-6 GMT-4 = pre-workday window
        workdayLabel = 'Pre-workday window';
    }

    return (
        <div
            className={cn(
                'flex flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3',
                className
            )}
        >
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-foreground/75">
                <Clock className="h-3 w-3" />
                {label}
            </div>
            <div className="flex items-baseline gap-3">
                <span className="font-mono text-2xl font-bold text-foreground">
                    {timeFormatter.format(now)}
                </span>
                <span className="text-sm font-medium text-muted-foreground">GMT-4</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-foreground/80">
                <span>{dayFormatter.format(now)}</span>
                {workdayLabel && (
                    <>
                        <span className="text-border">·</span>
                        <span className="text-primary">{workdayLabel}</span>
                    </>
                )}
            </div>
        </div>
    );
}
