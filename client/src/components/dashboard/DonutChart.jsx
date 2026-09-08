import { useMemo } from 'react';
import { cn } from '@/lib/utils';

const DEFAULT_COLORS = ['#a1a1aa', '#67e8f9', '#5eead4', '#f87171'];

/**
 * SVG donut chart for status / category distribution.
 */
export default function DonutChart({
    segments = [],
    size = 160,
    strokeWidth = 22,
    className,
    emptyText = 'No data'
}) {
    const total = segments.reduce((s, seg) => s + seg.value, 0);

    const arcs = useMemo(() => {
        if (total <= 0) return [];
        const radius = (size - strokeWidth) / 2;
        const cx = size / 2;
        const cy = size / 2;
        let startAngle = -Math.PI / 2;

        return segments
            .filter((s) => s.value > 0)
            .map((seg, i) => {
                const angle = (seg.value / total) * Math.PI * 2;
                const endAngle = startAngle + angle;
                const x1 = cx + radius * Math.cos(startAngle);
                const y1 = cy + radius * Math.sin(startAngle);
                const x2 = cx + radius * Math.cos(endAngle);
                const y2 = cy + radius * Math.sin(endAngle);
                const large = angle > Math.PI ? 1 : 0;
                const path = `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`;
                const result = {
                    path,
                    color: seg.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
                    label: seg.label,
                    value: seg.value,
                    pct: Math.round((seg.value / total) * 100)
                };
                startAngle = endAngle;
                return result;
            });
    }, [segments, total, size, strokeWidth]);

    if (total <= 0) {
        return (
            <div
                className={cn(
                    'flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground',
                    className
                )}
                style={{ minHeight: size }}
            >
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                    <circle
                        cx={size / 2}
                        cy={size / 2}
                        r={(size - strokeWidth) / 2}
                        fill="none"
                        stroke="currentColor"
                        strokeOpacity={0.1}
                        strokeWidth={strokeWidth}
                    />
                </svg>
                {emptyText}
            </div>
        );
    }

    return (
        <div className={cn('flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6', className)}>
            <div className="relative shrink-0">
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                    {arcs.map((arc, i) => (
                        <path
                            key={i}
                            d={arc.path}
                            fill="none"
                            stroke={arc.color}
                            strokeWidth={strokeWidth}
                            strokeLinecap="round"
                        />
                    ))}
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="font-display text-2xl font-semibold">{total}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</span>
                </div>
            </div>

            <div className="flex-1 space-y-2">
                {arcs.map((arc) => (
                    <div key={arc.label} className="flex items-center justify-between gap-3 text-xs">
                        <span className="flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full" style={{ background: arc.color }} />
                            {arc.label}
                        </span>
                        <span className="font-mono text-foreground/85">
                            {arc.value} <span className="text-muted-foreground">({arc.pct}%)</span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
