import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { CHART } from '@/lib/chartTheme';

/**
 * Grouped vertical bar chart — lightweight SVG, no dependencies.
 *
 * data: [{ label, values: { [seriesKey]: number } }]
 * series: [{ key, label, color }]
 */
export default function BarChart({
    data = [],
    series = [],
    height = 220,
    yMax,
    className,
    emptyText = 'No data yet'
}) {
    const [hoverIdx, setHoverIdx] = useState(null);
    const width = 800;
    const padding = { top: 20, right: 16, bottom: 36, left: 40 };

    const { maxY, bars, gridLines } = useMemo(() => {
        if (!data.length || !series.length) {
            return { maxY: 1, bars: [], gridLines: [] };
        }

        const allValues = data.flatMap((d) => series.map((s) => d.values?.[s.key] || 0));
        const computedMax = yMax ?? Math.max(...allValues, 1);
        const innerW = width - padding.left - padding.right;
        const innerH = height - padding.top - padding.bottom;
        const groupW = innerW / data.length;
        const barW = Math.min(28, (groupW * 0.7) / series.length);
        const groupGap = groupW * 0.15;

        const barGroups = data.map((d, gi) => {
            const groupX = padding.left + gi * groupW + groupGap;
            const barsInGroup = series.map((s, si) => {
                const val = d.values?.[s.key] || 0;
                const h = (val / computedMax) * innerH;
                const x = groupX + si * (barW + 4);
                const y = padding.top + innerH - h;
                return { x, y, w: barW, h, val, color: s.color, seriesKey: s.key, label: d.label };
            });
            return { gi, bars: barsInGroup, label: d.label };
        });

        const lines = [0, 0.5, 1].map((frac) => ({
            y: padding.top + innerH - frac * innerH,
            label: Math.round(computedMax * frac).toLocaleString()
        }));

        return { maxY: computedMax, bars: barGroups, gridLines: lines };
    }, [data, series, yMax, height]);

    if (!data.length || !series.length) {
        return (
            <div
                className={cn(
                    'flex items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-card/40 px-4 text-sm text-muted-foreground',
                    className
                )}
                style={{ height }}
            >
                {emptyText}
            </div>
        );
    }

    const innerH = height - padding.top - padding.bottom;

    return (
        <div className={cn('w-full', className)}>
            <svg
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="none"
                className="w-full"
                style={{ height }}
                role="img"
                onMouseLeave={() => setHoverIdx(null)}
            >
                {gridLines.map((g, i) => (
                    <g key={i}>
                        <line
                            x1={padding.left}
                            x2={width - padding.right}
                            y1={g.y}
                            y2={g.y}
                            stroke={CHART.grid}
                            strokeWidth="1"
                        />
                        <text
                            x={padding.left - 6}
                            y={g.y + 4}
                            fontSize="11"
                            fill={CHART.axis}
                            textAnchor="end"
                        >
                            {g.label}
                        </text>
                    </g>
                ))}

                {bars.map((group) =>
                    group.bars.map((bar) => (
                        <rect
                            key={`${group.gi}-${bar.seriesKey}`}
                            x={bar.x}
                            y={bar.y}
                            width={bar.w}
                            height={Math.max(bar.h, bar.val > 0 ? 2 : 0)}
                            fill={bar.color}
                            rx={3}
                            opacity={hoverIdx === group.gi ? 1 : 0.85}
                            onMouseEnter={() => setHoverIdx(group.gi)}
                        />
                    ))
                )}

                {bars.map((group, i) => {
                    const showEvery = Math.max(1, Math.ceil(data.length / 10));
                    if (i % showEvery !== 0 && i !== data.length - 1) return null;
                    const groupW = (width - padding.left - padding.right) / data.length;
                    const x = padding.left + i * groupW + groupW / 2;
                    return (
                        <text
                            key={`lbl-${i}`}
                            x={x}
                            y={height - 10}
                            fontSize="11"
                            fill={CHART.axis}
                            textAnchor="middle"
                        >
                            {group.label}
                        </text>
                    );
                })}
            </svg>

            {hoverIdx != null && bars[hoverIdx] && (
                <div className="pointer-events-none flex justify-center">
                    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                        <p className="mb-1 font-semibold">{bars[hoverIdx].label}</p>
                        {bars[hoverIdx].bars.map((b) => {
                            const s = series.find((x) => x.key === b.seriesKey);
                            return (
                                <div key={b.seriesKey} className="flex items-center gap-2">
                                    <span className="h-2 w-2 rounded-sm" style={{ background: b.color }} />
                                    <span>{s?.label}: <strong>{b.val}</strong></span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            <div className="mt-2 flex flex-wrap justify-center gap-4 text-xs text-foreground/80">
                {series.map((s) => (
                    <span key={s.key} className="flex items-center gap-1.5">
                        <span className="h-2 w-3 rounded-sm" style={{ background: s.color }} />
                        {s.label}
                    </span>
                ))}
            </div>
        </div>
    );
}

/**
 * Horizontal bar chart for rankings / tech stacks.
 */
export function HorizontalBarChart({
    items = [],
    accent = '#2dd4bf',
    maxItems = 8,
    className,
    emptyText = 'No data'
}) {
    const slice = items.slice(0, maxItems);
    const max = Math.max(...slice.map((i) => i.value), 1);

    if (!slice.length) {
        return (
            <div className={cn('flex h-32 items-center justify-center text-sm text-muted-foreground', className)}>
                {emptyText}
            </div>
        );
    }

    return (
        <div className={cn('space-y-2.5', className)}>
            {slice.map((item, i) => (
                <div key={item.label + i}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                        <span className="truncate font-medium text-foreground">{item.label}</span>
                        <span className="shrink-0 font-mono text-foreground/80">{item.value}</span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full" style={{ background: CHART.track }}>
                        <div
                            className="h-full rounded-full transition-all"
                            style={{
                                width: `${(item.value / max) * 100}%`,
                                background: item.color || accent,
                                opacity: 1 - i * 0.06
                            }}
                        />
                    </div>
                </div>
            ))}
        </div>
    );
}
