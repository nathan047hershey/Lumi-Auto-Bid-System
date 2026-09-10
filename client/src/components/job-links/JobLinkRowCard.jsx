import {
    Eye,
    ExternalLink,
    MessageSquare,
    Pencil,
    RefreshCw,
    Trash2,
    Zap
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { cvGenerationTimeLabel, useNowTick } from '@/lib/cvGenerationTime';

const STACK_ACCENT = {
    python: 'from-yellow-500 to-amber-600',
    java: 'from-orange-500 to-red-600',
    dotnet: 'from-violet-500 to-indigo-600',
    golang: 'from-cyan-500 to-blue-600',
    nodejs: 'from-emerald-500 to-green-600',
    frontend: 'from-pink-500 to-rose-600'
};

function profileChipMeta(p) {
    if (p.status === 'rejected' || p.state === 'rejected' || p.state === 'cancelled') {
        return { label: 'FAILED', className: 'border-red-500/50 bg-red-500/20 text-red-200' };
    }
    if (p.status === 'applied' || p.bid_applied || p.bid_outcome === 'applied') {
        return { label: 'SUCCESS', className: 'border-emerald-500/50 bg-emerald-500/20 text-emerald-200' };
    }
    if (p.status === 'interview') {
        return { label: 'INTERVIEW', className: 'border-sky-500/50 bg-sky-500/20 text-sky-200' };
    }
    if (p.bid_filled && !p.bid_applied) {
        return { label: 'FILLED', className: 'border-sky-500/50 bg-sky-500/15 text-sky-200' };
    }
    if (p.generation_status === 'ready') {
        return { label: 'CV READY', className: 'border-teal-500/45 bg-teal-500/15 text-teal-200' };
    }
    if (p.generation_status === 'failed') {
        return { label: 'CV FAIL', className: 'border-orange-500/50 bg-orange-500/15 text-orange-200' };
    }
    if (p.generation_status === 'generating' || p.generation_status === 'pending') {
        return {
            label: p.generation_status === 'generating' ? 'CV GEN…' : 'CV QUEUED',
            className: 'border-blue-500/45 bg-blue-500/15 text-blue-200'
        };
    }
    return { label: 'NO CV', className: 'border-border/60 bg-muted/40 text-muted-foreground' };
}

/** SUCCESS apply time as 2026/9/9 12:10:12 (local). */
function formatSuccessTime(value) {
    if (!value) return '';
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return '';
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${y}/${m}/${day} ${hh}:${mm}:${ss}`;
}

function profileChipRank(p) {
    const label = profileChipMeta(p).label;
    if (label === 'SUCCESS') return 0;
    if (label === 'INTERVIEW') return 1;
    if (label === 'FILLED') return 2;
    if (label === 'CV READY') return 3;
    if (label === 'FAILED' || label === 'CV FAIL') return 4;
    return 5;
}

function shortName(p) {
    const first = String(p.first_name || '').trim();
    const last = String(p.last_name || '').trim();
    if (first && last) return `${first} ${last[0]}.`;
    if (first) return first;
    if (last) return last;
    return `#${p.profile_id}`;
}

function ProfilesStrip({ profiles }) {
    const list = [...(Array.isArray(profiles) ? profiles : [])].sort(
        (a, b) => profileChipRank(a) - profileChipRank(b)
    );
    const live = list.some((p) => String(p.generation_status || '') === 'generating');
    const now = useNowTick(live);
    if (!list.length) {
        return <span className="text-[10px] text-white/30">No profiles</span>;
    }

    const fullTitle = list.map((p) => {
        const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || `#${p.profile_id}`;
        const gen = cvGenerationTimeLabel(p, { now });
        const meta = profileChipMeta(p);
        const successAt = formatSuccessTime(p.bid_applied_at);
        return `${name}: ${meta.label}${successAt ? ` @ ${successAt}` : ''}${gen ? ` (${gen})` : ''}`;
    }).join('\n');

    return (
        <div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5" title={fullTitle}>
            {list.map((p) => {
                const meta = profileChipMeta(p);
                const gen = cvGenerationTimeLabel(p, { now });
                const successAt = meta.label === 'SUCCESS' ? formatSuccessTime(p.bid_applied_at) : '';
                return (
                    <span
                        key={p.profile_id}
                        className={cn(
                            'inline-flex max-w-[16rem] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none',
                            meta.className
                        )}
                        title={
                            successAt
                                ? `${meta.label} · ${successAt}`
                                : (gen ? `${meta.label} · Generated in ${gen}` : meta.label)
                        }
                    >
                        <span className="truncate">{shortName(p)}</span>
                        <span className="shrink-0 font-bold opacity-90">{meta.label}</span>
                        {successAt ? (
                            <span className="shrink-0 font-mono tabular-nums opacity-90">{successAt}</span>
                        ) : gen ? (
                            <span className="shrink-0 font-mono tabular-nums opacity-80">{gen}</span>
                        ) : null}
                    </span>
                );
            })}
        </div>
    );
}

export default function JobLinkRowCard({
    row,
    rowNumber,
    techLabel,
    availability,
    jd,
    fetchStatus,
    selected,
    onSelect,
    onOpen,
    onToggleAvailable,
    onBid,
    onRefetch,
    refetching,
    onView,
    onEdit,
    onDelete,
    addedLabel
}) {
    const accent = STACK_ACCENT[row.techstack] || 'from-violet-500 to-fuchsia-600';
    const applyUrl = row.job_apply_url || row.source_url || row.linkedin_url || '';

    return (
        <article
            className={cn(
                'group relative flex overflow-hidden rounded-xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] transition-colors',
                'hover:border-primary/30 hover:bg-[hsl(222_24%_11%/0.9)]',
                selected && 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
            )}
        >
            <div className={cn('w-0.5 shrink-0 bg-gradient-to-b', accent)} aria-hidden />

            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 sm:gap-2.5 sm:px-2.5">
                <Checkbox
                    checked={selected}
                    onCheckedChange={onSelect}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select job ${rowNumber}`}
                    className="shrink-0"
                />

                <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-white/35">
                    #{rowNumber}
                </span>

                <Badge variant="secondary" className="hidden h-5 shrink-0 px-1.5 text-[9px] font-bold uppercase sm:inline-flex">
                    {techLabel}
                </Badge>
                <Badge variant="outline" className="hidden h-5 shrink-0 px-1.5 text-[9px] uppercase lg:inline-flex">
                    {row.location_flag || 'US'}
                </Badge>

                <button type="button" onClick={onOpen} className="w-[13.5rem] min-w-0 shrink-0 text-left sm:w-[16.5rem] lg:w-[18rem]">
                    <p className="truncate text-[13px] font-semibold leading-tight text-white group-hover:text-primary">
                        {row.company_name || row.position_title || `Job link ${row.id}`}
                    </p>
                    <p className="truncate text-[11px] leading-tight text-white/45">
                        {[row.position_title, row.location].filter(Boolean).join(' · ') || '—'}
                        {row.comment ? (
                            <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-200/70">
                                <MessageSquare className="h-2.5 w-2.5" />
                                <span className="max-w-[6rem] truncate">{row.comment}</span>
                            </span>
                        ) : null}
                    </p>
                </button>

                <div
                    className="flex min-w-0 flex-1 items-center justify-center px-2"
                    onClick={(e) => e.stopPropagation()}
                >
                    <ProfilesStrip profiles={row.available_profiles} />
                </div>

                <div
                    className="hidden shrink-0 items-center gap-1 lg:flex"
                    onClick={(e) => e.stopPropagation()}
                >
                    <button type="button" onClick={onToggleAvailable} className="hover:opacity-80">
                        <Badge variant={availability.variant} className="h-5 px-1.5 text-[9px]">
                            {availability.label}
                        </Badge>
                    </button>
                    <Badge variant={jd.variant} className="h-5 px-1.5 text-[9px]" title={jd.label === 'JD empty' ? 'No JD' : 'JD stored'}>
                        {jd.label}
                    </Badge>
                    <Badge variant={fetchStatus.variant} className="h-5 px-1.5 text-[9px]" title={row.fetch_error || fetchStatus.label}>
                        {fetchStatus.label}
                    </Badge>
                </div>

                <div
                    className="flex shrink-0 items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                >
                    <Button
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px] font-semibold"
                        title={jd.label === 'JD empty' ? 'Lumi — JD empty; refetch recommended' : 'Lumi for this link'}
                        onClick={onBid}
                    >
                        <Zap className="h-3 w-3" />
                        Bid
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={onRefetch}
                        disabled={refetching}
                        title="Refresh CVs for matching profiles (refetch JD if empty)"
                    >
                        <RefreshCw className={cn('h-3.5 w-3.5', refetching && 'animate-spin')} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onView} title="Quick view">
                        <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="hidden h-7 w-7 sm:inline-flex" onClick={onEdit} title="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {applyUrl ? (
                        <Button variant="ghost" size="icon" className="hidden h-7 w-7 md:inline-flex" asChild title="Open apply URL">
                            <a href={applyUrl} target="_blank" rel="noopener noreferrer">
                                <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                        </Button>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={onDelete}
                        title="Delete"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>

            {(row.created_by_username || addedLabel) && (
                <span className="sr-only">
                    {row.created_by_username ? `by ${row.created_by_username}` : ''} {addedLabel || ''}
                </span>
            )}
        </article>
    );
}
