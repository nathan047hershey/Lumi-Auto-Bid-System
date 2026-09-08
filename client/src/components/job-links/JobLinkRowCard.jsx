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
import { cvGenerationTimeLabel } from '@/lib/cvGenerationTime';

const STACK_ACCENT = {
    python: 'from-yellow-500 to-amber-600',
    java: 'from-orange-500 to-red-600',
    dotnet: 'from-violet-500 to-indigo-600',
    golang: 'from-cyan-500 to-blue-600',
    nodejs: 'from-emerald-500 to-green-600',
    frontend: 'from-pink-500 to-rose-600'
};

const PROFILE_VISIBLE = 2;

function profileChipMeta(p) {
    if (p.status === 'rejected' || p.state === 'rejected' || p.state === 'cancelled') {
        return { label: 'FAIL', className: 'border-red-500/50 bg-red-500/20 text-red-200' };
    }
    if (p.status === 'applied' || p.bid_applied || p.bid_outcome === 'applied') {
        return { label: 'OK', className: 'border-emerald-500/50 bg-emerald-500/20 text-emerald-200' };
    }
    if (p.status === 'interview') {
        return { label: 'INT', className: 'border-sky-500/50 bg-sky-500/20 text-sky-200' };
    }
    if (p.bid_filled && !p.bid_applied) {
        return { label: 'FILL', className: 'border-sky-500/50 bg-sky-500/15 text-sky-200' };
    }
    if (p.generation_status === 'ready') {
        return { label: 'CV', className: 'border-teal-500/45 bg-teal-500/15 text-teal-200' };
    }
    if (p.generation_status === 'failed') {
        return { label: 'CV✗', className: 'border-orange-500/50 bg-orange-500/15 text-orange-200' };
    }
    if (p.generation_status === 'generating' || p.generation_status === 'pending') {
        return {
            label: '…',
            className: 'border-blue-500/45 bg-blue-500/15 text-blue-200'
        };
    }
    return { label: '—', className: 'border-border/60 bg-muted/40 text-muted-foreground' };
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
    const list = Array.isArray(profiles) ? profiles : [];
    if (!list.length) {
        return <span className="text-[10px] text-white/30">0 profiles</span>;
    }

    const shown = list.slice(0, PROFILE_VISIBLE);
    const extra = list.length - shown.length;
    const fullTitle = list.map((p) => {
        const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || `#${p.profile_id}`;
        const gen = cvGenerationTimeLabel(p);
        return `${name}: ${profileChipMeta(p).label}${gen ? ` (${gen})` : ''}`;
    }).join('\n');

    return (
        <div className="flex items-center gap-1" title={fullTitle}>
            {shown.map((p) => {
                const meta = profileChipMeta(p);
                const gen = cvGenerationTimeLabel(p);
                return (
                    <span
                        key={p.profile_id}
                        className={cn(
                            'inline-flex max-w-[8.5rem] items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[9px] font-medium leading-none',
                            meta.className
                        )}
                        title={gen ? `Generated in ${gen}` : undefined}
                    >
                        <span className="truncate">{shortName(p)}</span>
                        <span className="shrink-0 font-bold opacity-90">{meta.label}</span>
                        {gen ? (
                            <span className="shrink-0 font-mono tabular-nums opacity-80">{gen}</span>
                        ) : null}
                    </span>
                );
            })}
            {extra > 0 ? (
                <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold text-white/50">
                    +{extra}
                </span>
            ) : null}
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

                <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
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
                    className="hidden w-[11.5rem] shrink-0 xl:block"
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
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefetch} title="Refetch JD">
                        <RefreshCw className="h-3.5 w-3.5" />
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
