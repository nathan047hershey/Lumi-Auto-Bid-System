import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { CHART } from '@/lib/chartTheme';

/**
 * Lightweight, dependency-free SVG line / area chart.
 *
 * Props
 *  - data: Array<{ x: number|string, y: number, label?: string }>
 *      x is treated as a category / ordinal (positions left → right).
 *  - height: pixel height of the SVG (default 220)
 *  - yMax: optional override for the upper y-axis bound (otherwise auto)
 *  - yLabel: optional callback (y) => string for axis labels
 *  - accent: primary stroke color (defaults to Win11 blue #0078d4)
 *  - secondary: optional second line series color
 *  - showGrid: bool
 *  - showDots: bool
 *  - showFill: bool (paint area under the primary line)
 *  - tooltipFormat: optional (point) => ReactNode for custom hover tooltip
 */
export default function LineChart({
    data = [],
    height = 220,
    yMax,
    yLabel,
    accent = '#0078d4',
    secondary,
    primaryLabel = 'Cumulative',
    secondaryLabel = 'Per hour',
    showGrid = true,
    showDots = true,
    showFill = true,
    className,
    emptyText = 'No data yet'
}) {
    const [hoverIdx, setHoverIdx] = useState(null);
    const width = 800;
    const padding = { top: 24, right: 16, bottom: 32, left: 44 };

    const { maxY, points, areaPath, gridLines } = useMemo(() => {
        if (!data.length) {
            return { maxY: 1, points: [], areaPath: '', gridLines: [] };
        }
        const ys = data.map((d) => d.y);
        const computedMax = yMax ?? Math.max(...ys, 1);
        const innerW = width - padding.left - padding.right;
        const innerH = height - padding.top - padding.bottom;

        const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;
        const pts = data.map((d, i) => {
            const x = padding.left + stepX * i;
            const y = padding.top + innerH - (d.y / computedMax) * innerH;
            return { x, y, raw: d };
        });

        const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
        const area = `${linePath} L${pts[pts.length - 1].x},${padding.top + innerH} L${pts[0].x},${padding.top + innerH} Z`;

        const lines = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
            const yVal = computedMax * frac;
            const yPos = padding.top + innerH - frac * innerH;
            return { y: yPos, label: yLabel ? yLabel(yVal) : Math.round(yVal).toLocaleString() };
        });

        return { maxY: computedMax, points: pts, areaPath: area, gridLines: lines };
    }, [data, yMax, yLabel, height, width]);

    if (!data.length) {
        return (
            <div
                className={cn(
                    'flex items-center justify-center rounded-md border border-dashed border-border bg-card/40 px-4 text-sm text-muted-foreground',
                    className
                )}
                style={{ height }}
            >
                {emptyText}
            </div>
        );
    }

    const innerH = height - padding.top - padding.bottom;
    const innerW = width - padding.left - padding.right;
    const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

    return (
        <div className={cn('w-full', className)}>
            <svg
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="none"
                className="w-full"
                style={{ height }}
                role="img"
                aria-label="Line chart"
                onMouseLeave={() => setHoverIdx(null)}
                onMouseMove={(e) => {
                    const target = e.currentTarget;
                    const rect = target.getBoundingClientRect();
                    const xRatio = (e.clientX - rect.left) / rect.width;
                    const idx = Math.round(xRatio * (data.length - 1));
                    if (idx >= 0 && idx < data.length) setHoverIdx(idx);
                }}
            >
                <defs>
                    <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={accent} stopOpacity="0.45" />
                        <stop offset="100%" stopColor={accent} stopOpacity="0" />
                    </linearGradient>
                </defs>

                {/* Grid */}
                {showGrid && gridLines.map((g, i) => (
                    <line
                        key={i}
                        x1={padding.left}
                        x2={width - padding.right}
                        y1={g.y}
                        y2={g.y}
                        stroke={CHART.grid}
                        strokeWidth="1"
                    />
                ))}

                {/* Y axis labels */}
                {showGrid && gridLines.map((g, i) => (
                    <text
                        key={`l-${i}`}
                        x={padding.left - 8}
                        y={g.y + 4}
                        fontSize="11"
                        fill={CHART.axis}
                        textAnchor="end"
                    >
                        {g.label}
                    </text>
                ))}

                {/* Area under primary line */}
                {showFill && (
                    <path d={areaPath} fill="url(#lineFill)" />
                )}

                {/* Secondary line */}
                {secondary && data.some((d) => typeof d.secondary === 'number') && (
                    <polyline
                        fill="none"
                        stroke={secondary}
                        strokeWidth="2"
                        strokeDasharray="4 4"
                        points={data.map((d, i) => {
                            const x = padding.left + stepX * i;
                            const y = padding.top + innerH - (d.secondary / maxY) * innerH;
                            return `${x},${y}`;
                        }).join(' ')}
                    />
                )}

                {/* Primary line */}
                <polyline
                    fill="none"
                    stroke={accent}
                    strokeWidth="2.5"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                />

                {/* Dots */}
                {showDots && points.map((p, i) => (
                    <circle
                        key={i}
                        cx={p.x}
                        cy={p.y}
                        r={hoverIdx === i ? 5 : 3}
                        fill={accent}
                        stroke="#18181b"
                        strokeWidth={1.5}
                    />
                ))}

                {/* X axis labels — every Nth to avoid overflow */}
                {data.map((d, i) => {
                    const showLabelEvery = Math.max(1, Math.ceil(data.length / 12));
                    if (i % showLabelEvery !== 0 && i !== data.length - 1) return null;
                    const x = padding.left + stepX * i;
                    return (
                        <text
                            key={`x-${i}`}
                            x={x}
                            y={height - padding.bottom + 16}
                            fontSize="11"
                            fill={CHART.axis}
                            textAnchor="middle"
                        >
                            {d.label || d.x}
                        </text>
                    );
                })}

                {/* Vertical hover line */}
                {hoverIdx != null && points[hoverIdx] && (
                    <line
                        x1={points[hoverIdx].x}
                        x2={points[hoverIdx].x}
                        y1={padding.top}
                        y2={height - padding.bottom}
                        stroke={CHART.axis}
                        strokeOpacity={0.35}
                    />
                )}
            </svg>

            {hoverIdx != null && points[hoverIdx] && (
                <div className="pointer-events-none -mt-2 flex justify-center">
                    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg">
                        <div className="font-semibold text-popover-foreground">
                            {data[hoverIdx].label || data[hoverIdx].x}
                        </div>
                        <div className="flex flex-col gap-1 text-popover-foreground">
                            <div>
                                <span className="mr-1 inline-block h-2 w-3 rounded-full align-middle" style={{ background: accent }} />
                                <span className="font-semibold" style={{ color: accent }}>
                                    {data[hoverIdx].y.toLocaleString()}
                                </span>{' '}
                                {primaryLabel.toLowerCase()}
                            </div>
                            {typeof data[hoverIdx].secondary === 'number' && secondary && (
                                <div>
                                    <span
                                        className="mr-1 inline-block h-0 w-3 border-t-2 border-dashed align-middle"
                                        style={{ borderColor: secondary }}
                                    />
                                    <span className="font-semibold" style={{ color: secondary }}>
                                        {data[hoverIdx].secondary.toLocaleString()}
                                    </span>{' '}
                                    {secondaryLabel.toLowerCase()}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
