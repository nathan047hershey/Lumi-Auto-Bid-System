// =============================================================================
// admin/JobLinks — admin-managed job-tracking directory
// =============================================================================
//
// The Job Links panel is the admin's "what jobs should the team be
// working on right now?" directory. Each row tracks:
//
//   - techstack (closed enum: Python | Java | C#/.NET | Golang |
//     Node.js | Frontend)
//   - source_url      (optional, any supported ATS — LinkedIn,
//     Greenhouse, Lever, Ashby, iCIMS, JobVite, Workday,
//     SuccessFactors, Paycom, ApplyToJob, Rippling)
//   - job_apply_url   (the URL the user will actually submit to)
//   - job_description (filled by the cron when source_url is set)
//
// The page renders:
//
//   1. A filters bar (date range, techstack, availability, free-text
//      search across every visible column).
//   2. A paginated, compact table. Long URLs and descriptions are
//      clamped with CSS line-clamp + a tooltip showing the full text on
//      hover.
//   3. An "Add New" button that opens a modal with the create form.
//   4. A "Fetch now" action on each row that triggers the cron
//      scraper for that single row.
//
// Pagination is server-side; we render the standard page-of-total-pages
// controls used by the rest of the admin pages so the UX stays
// consistent.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
    Building2,
    CheckSquare,
    ChevronLeft,
    ChevronRight,
    Copy,
    ExternalLink,
    Eye,
    Link as LinkIcon,
    Link2,
    Loader2,
    MapPin,
    MessageSquare,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    Zap
} from 'lucide-react';
import { adminAPI } from '@/api';
import { VALID_TECHSTACKS } from '@/lib/techstacks';
import { PageLoader, Loader } from '@/components/Loader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogBody
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/DatePicker';
import { cn } from '@/lib/utils';
import { cvGenerationTimeLabel, useNowTick } from '@/lib/cvGenerationTime';
import {
    jobLinksListStateToQuery,
    resolveJobLinksListState,
    writeSavedJobLinksListState
} from '@/lib/jobLinksListState';
import { LOCATION_FLAGS } from '@/lib/locationFlags';
import FilterChip from '@/components/FilterChip';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import JobLinkRowCard from '@/components/job-links/JobLinkRowCard';
import AutoBidderDialog from '@/components/job-links/AutoBidderDialog';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Canonical techstack values. Order is the same as in the dropdown
// menu so the table filter and the create-modal dropdown align.
const PLATFORMS = [
    { value: 'greenhouse', label: 'Greenhouse' },
    { value: 'lever', label: 'Lever' },
    { value: 'ashby', label: 'Ashby' },
    { value: 'gem', label: 'Gem' },
    { value: 'workday', label: 'Workday' },
    { value: 'icims', label: 'iCIMS' },
    { value: 'smartrecruiters', label: 'SmartRecruiters' },
    { value: 'bamboohr', label: 'BambooHR' },
    { value: 'oracle', label: 'Oracle Cloud HCM' },
    { value: 'linkedin', label: 'LinkedIn' },
    { value: 'rippling', label: 'Rippling' },
    { value: 'jobvite', label: 'Jobvite' },
    { value: 'paycom', label: 'Paycom' },
    { value: 'applytojob', label: 'ApplyToJob' },
    { value: 'paylocity', label: 'Paylocity' },
    { value: 'successfactors', label: 'SuccessFactors' },
    { value: 'generic', label: 'Other / generic' }
];
const PLATFORM_LABEL = Object.fromEntries(PLATFORMS.map((p) => [p.value, p.label]));

const TECHSTACKS = [
    { value: 'python',   label: 'Python' },
    { value: 'java',     label: 'Java' },
    { value: 'dotnet',   label: 'C# / .NET' },
    { value: 'golang',   label: 'Golang' },
    { value: 'nodejs',   label: 'Node.js' },
    { value: 'frontend', label: 'Frontend' }
];

// Debounce delay (ms) applied to the search text input. Keeps the UI
// snappy while coalescing keystrokes into a single fetch.
const FILTER_DEBOUNCE_MS = 400;
const DEFAULT_LIMIT = 10;
const SELECTED_IDS_KEY = 'lumi_job_links_selected_ids';

function readSelectedIds() {
    try {
        const raw = localStorage.getItem(SELECTED_IDS_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return new Set();
        return new Set(arr.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0));
    } catch {
        return new Set();
    }
}

function writeSelectedIds(ids) {
    try {
        localStorage.setItem(SELECTED_IDS_KEY, JSON.stringify([...ids]));
    } catch (_) { /* ignore */ }
}

// Display helpers ----------------------------------------------------------

const TECHSTACK_LABEL = Object.fromEntries(TECHSTACKS.map((t) => [t.value, t.label]));

const AVAILABILITY_META = {
    1: { label: 'Available', variant: 'success' },
    0: { label: 'Unavailable', variant: 'muted' }
};

function jobLinkAvailabilityMeta(row) {
    if (String(row?.closed_reason || '').toLowerCase() === 'expired') {
        return { label: 'Expired', variant: 'destructive' };
    }
    return AVAILABILITY_META[row?.is_available] || AVAILABILITY_META[1];
}

const FETCH_STATUS_META = {
    pending:  { label: 'Pending',  variant: 'muted' },
    fetching: { label: 'Fetching', variant: 'info' },
    success:  { label: 'Fetched',  variant: 'success' },
    failed:   { label: 'Failed',   variant: 'destructive' },
    dead:     { label: 'Dead',     variant: 'destructive' }
};

function jdStatusMeta(row) {
    const filled = !!(row?.job_description && String(row.job_description).trim());
    return filled
        ? { label: 'JD filled', variant: 'success' }
        : { label: 'JD empty', variant: 'destructive' };
}

function formatJobLinkTimestamp(value) {
    if (!value) return '—';
    const raw = String(value).trim();
    const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '—';
    return dt.toLocaleString();
}

/**
 * Single-line profile chips for a job link row.
 * Name + outcome badge (SUCCESS / FAILED / CV READY / …).
 */
function AvailableProfilesCell({ profiles }) {
    const list = Array.isArray(profiles) ? profiles : [];
    const live = list.some((p) => String(p.generation_status || '') === 'generating');
    const now = useNowTick(live);
    if (list.length === 0) {
        return <span className="text-xs text-muted-foreground">—</span>;
    }

    const chipMeta = (p) => {
        if (p.status === 'rejected' || p.state === 'rejected' || p.state === 'cancelled') {
            return {
                label: 'FAILED',
                className: 'border-red-500/50 bg-red-500/20 text-red-200'
            };
        }
        if (p.status === 'applied' || p.bid_applied || p.bid_outcome === 'applied') {
            return {
                label: 'SUCCESS',
                className: 'border-emerald-500/50 bg-emerald-500/20 text-emerald-200'
            };
        }
        if (p.status === 'interview') {
            return {
                label: 'INTERVIEW',
                className: 'border-sky-500/50 bg-sky-500/20 text-sky-200'
            };
        }
        // Form filled by Auto Bidder — not the same as site SUCCESS.
        if (p.bid_filled && !p.bid_applied) {
            return {
                label: 'FILLED',
                className: 'border-sky-500/50 bg-sky-500/15 text-sky-200'
            };
        }
        if (p.generation_status === 'ready') {
            return {
                label: 'CV READY',
                className: 'border-teal-500/45 bg-teal-500/15 text-teal-200'
            };
        }
        if (p.generation_status === 'failed') {
            return {
                label: 'CV FAIL',
                className: 'border-orange-500/50 bg-orange-500/15 text-orange-200'
            };
        }
        if (p.generation_status === 'generating' || p.generation_status === 'pending') {
            return {
                label: p.generation_status === 'generating' ? 'CV GEN…' : 'CV QUEUED',
                className: 'border-blue-500/45 bg-blue-500/15 text-blue-200'
            };
        }
        return {
            label: 'NO CV',
            className: 'border-border/60 bg-muted/40 text-muted-foreground'
        };
    };

    return (
        <div
            className="flex max-w-[26rem] flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap py-0.5"
            onClick={(e) => e.stopPropagation()}
            title={list.map((p) => {
                const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || `#${p.profile_id}`;
                const meta = chipMeta(p);
                const gen = cvGenerationTimeLabel(p, { now });
                const parts = [name, meta.label];
                if (gen) parts.push(gen);
                if (meta.label === 'FILLED') parts.push('form filled — not site SUCCESS');
                if (p.status) parts.push(p.status);
                if (p.generation_status) parts.push(p.generation_status);
                return parts.join(' · ');
            }).join('\n')}
        >
            {list.map((p) => {
                const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || `#${p.profile_id}`;
                const meta = chipMeta(p);
                const gen = cvGenerationTimeLabel(p, { now });
                return (
                    <span
                        key={p.profile_id}
                        className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none',
                            meta.className
                        )}
                        title={gen ? `Generated in ${gen}` : undefined}
                    >
                        <span className="max-w-[6.5rem] truncate">{name}</span>
                        <span className="font-bold tracking-wide opacity-95">{meta.label}</span>
                        {gen ? (
                            <span className="font-mono tabular-nums opacity-90">{gen}</span>
                        ) : null}
                    </span>
                );
            })}
        </div>
    );
}

// Clamp a string into a compact cell. Long URLs / descriptions are
// truncated with an ellipsis; the original is preserved in the
// `title` attribute so a hover shows the full value.
function TruncatedCell({ value, className, maxWidth = '12rem' }) {
    if (!value) return <span className="text-xs text-foreground/50">—</span>;
    return (
        <span
            className={cn('block truncate align-middle', className)}
            style={{ maxWidth }}
            title={value}
        >
            {value}
        </span>
    );
}

// A clickable URL cell. The link opens in a new tab; the visible
// text is the URL truncated to `maxWidth`. We stop click
// propagation so clicking the URL does NOT bubble up to the
// row's onClick (which navigates to the detail page) — without
// this the user gets a new tab AND a detail-page navigation in
// the same click, which is confusing.
function UrlCell({ value, maxWidth = '14rem', onCopied }) {
    const [copied, setCopied] = useState(false);
    if (!value) return <span className="text-xs text-foreground/50">—</span>;
    const handleCopy = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                // Fallback for older browsers / non-secure contexts
                const ta = document.createElement('textarea');
                ta.value = value;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopied(true);
            onCopied?.(value);
            // Reset the icon back to "copy" after 1.5s
            setTimeout(() => setCopied(false), 1500);
        } catch (err) {
            console.error('Copy failed:', err);
        }
    };
    return (
        <span
            className="inline-flex items-center gap-1"
            style={{ maxWidth }}
        >
            <a
                href={value}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex min-w-0 items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200 hover:underline"
                title={value}
            >
                <span className="truncate inline-block align-middle" style={{ maxWidth }}>
                    {value}
                </span>
                <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
            <button
                type="button"
                onClick={handleCopy}
                title={copied ? 'Copied!' : 'Copy URL'}
                aria-label="Copy URL"
                className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors',
                    copied
                        ? 'text-emerald-400'
                        : 'text-foreground/60 hover:bg-secondary hover:text-foreground'
                )}
            >
                <Copy className="h-3 w-3" />
            </button>
        </span>
    );
}

function primaryJobUrl(row) {
    if (!row) return '';
    return row.job_apply_url || row.source_url || row.linkedin_url || '';
}

/**
 * Parse bulk paste lines into { apply, source } pairs.
 * Formats per line:
 *   - https://apply...
 *   - https://apply... | https://source...
 *   - https://apply...\thttps://source...
 *   - https://apply...,https://source...  (comma only if both look like URLs)
 *
 * When source is the same posting as apply (tracking /apply noise),
 * only keep apply so we don't create a redundant second link.
 */
function parseBulkJobLinkLines(text) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const rows = [];
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let apply = '';
        let source = '';
        if (line.includes('|')) {
            const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
            apply = parts[0] || '';
            source = parts[1] || '';
        } else if (line.includes('\t')) {
            const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
            apply = parts[0] || '';
            source = parts[1] || '';
        } else if (/,https?:\/\//i.test(line)) {
            const idx = line.search(/,https?:\/\//i);
            apply = line.slice(0, idx).trim();
            source = line.slice(idx + 1).trim();
        } else {
            apply = line;
        }
        if (!/^https?:\/\//i.test(apply)) {
            errors.push(`Line ${i + 1}: not a valid URL — ${line.slice(0, 80)}`);
            continue;
        }
        if (source && !/^https?:\/\//i.test(source)) {
            errors.push(`Line ${i + 1}: source is not a valid URL — ${source.slice(0, 80)}`);
            continue;
        }
        if (source && sameJobLinkUrls(source, apply)) {
            source = '';
        }
        rows.push({ apply, source: source || null });
    }
    return { rows, errors };
}

/** Same posting? Strips tracking + common /apply|/application suffixes. */
function sameJobLinkUrls(a, b) {
    const key = (raw) => {
        try {
            const u = new URL(String(raw || '').trim());
            let path = (u.pathname || '')
                .replace(/\/(apply|application)\/?$/i, '')
                .replace(/\/+$/, '');
            return `${u.host.toLowerCase()}${path.toLowerCase()}`;
        } catch {
            return String(raw || '').trim().toLowerCase();
        }
    };
    const ka = key(a);
    const kb = key(b);
    return Boolean(ka && kb && ka === kb);
}

function LinksCell({ row }) {
    const apply = row?.job_apply_url || row?.linkedin_url || '';
    const source = row?.source_url || '';
    // Hide Source when it is the same posting as Apply (e.g. Lever
    // …/uuid vs …/uuid/apply?utm_source=jobright).
    const showSource = source && apply && !sameJobLinkUrls(source, apply)
        && source !== apply;
    return (
        <div className="min-w-[10rem] max-w-[16rem] space-y-1" onClick={(e) => e.stopPropagation()}>
            {apply ? (
                <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Apply</div>
                    <UrlCell value={apply} maxWidth="15rem" />
                </div>
            ) : (
                <UrlCell value={primaryJobUrl(row)} maxWidth="15rem" />
            )}
            {showSource ? (
                <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Source</div>
                    <UrlCell value={source} maxWidth="15rem" />
                </div>
            ) : null}
        </div>
    );
}

// -----------------------------------------------------------------------------
// Hooks
// -----------------------------------------------------------------------------

/**
 * Tie a piece of controlled input state to a debounced mirror. The
 * network layer only sees the debounced value so we never fire a
 * fetch per keystroke. Returns `[value, setValue, debounced]`.
 */
function useDebouncedValue(initial, delay = FILTER_DEBOUNCE_MS) {
    const [value, setValue] = useState(initial);
    const [debounced, setDebounced] = useState(initial);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return [value, setValue, debounced];
}

// -----------------------------------------------------------------------------
// Add-new modal
// -----------------------------------------------------------------------------

function AddJobLinkModal({ open, onOpenChange, onCreated }) {
    const [mode, setMode] = useState('single'); // 'single' | 'bulk'
    const [techstack, setTechstack] = useState('');
    const flagManuallySetRef = useRef(false);
    const [applyUrl, setApplyUrl] = useState('');
    const [sourceUrl, setSourceUrl] = useState('');
    const [bulkText, setBulkText] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [locationFlag, setLocationFlag] = useState('US');
    const [comment, setComment] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);
    const [bulkProgress, setBulkProgress] = useState(null);

    const bulkPreview = useMemo(() => parseBulkJobLinkLines(bulkText), [bulkText]);

    useEffect(() => {
        if (open) {
            setMode('single');
            setTechstack('');
            setApplyUrl('');
            setSourceUrl('');
            setBulkText('');
            setDescription('');
            setLocation('');
            setLocationFlag('US');
            setComment('');
            flagManuallySetRef.current = false;
            setError(null);
            setBulkProgress(null);
        }
    }, [open]);

    const sharedPayload = () => ({
        techstack,
        job_description: mode === 'single' ? (description.trim() || null) : null,
        location: location.trim() || null,
        location_flag: LOCATION_FLAGS.includes(locationFlag) ? locationFlag : 'US',
        comment: comment.trim() || null
    });

    const handleSubmit = async (e) => {
        e?.preventDefault?.();
        setError(null);
        setBulkProgress(null);
        if (!techstack) {
            setError('Techstack is required');
            return;
        }

        if (mode === 'single') {
            if (!applyUrl.trim()) {
                setError('Apply URL is required');
                return;
            }
            setSubmitting(true);
            try {
                const apply = applyUrl.trim();
                const sourceRaw = sourceUrl.trim();
                const source = sourceRaw && !sameJobLinkUrls(sourceRaw, apply)
                    ? sourceRaw
                    : null;
                const res = await adminAPI.createJobLink({
                    ...sharedPayload(),
                    // Server accepts null source; scrape falls back to apply URL.
                    source_url: source,
                    job_apply_url: apply
                });
                onCreated?.(res.data?.data);
                onOpenChange(false);
            } catch (err) {
                const data = err.response?.data;
                const existingId = data?.existing_id;
                const baseMsg = data?.error || 'Failed to save job link';
                if (err.response?.status === 409 && existingId) {
                    setError(`${baseMsg} (existing row #${existingId})`);
                } else {
                    setError(baseMsg);
                }
            } finally {
                setSubmitting(false);
            }
            return;
        }

        const { rows, errors: parseErrors } = parseBulkJobLinkLines(bulkText);
        if (!rows.length) {
            setError(parseErrors[0] || 'Paste at least one apply URL (one per line).');
            return;
        }

        setSubmitting(true);
        const created = [];
        const failed = [...parseErrors];
        try {
            for (let i = 0; i < rows.length; i++) {
                const { apply, source } = rows[i];
                setBulkProgress({ current: i + 1, total: rows.length });
                try {
                    const res = await adminAPI.createJobLink({
                        ...sharedPayload(),
                        source_url: source || null,
                        job_apply_url: apply
                    });
                    created.push(res.data?.data || { job_apply_url: apply });
                } catch (err) {
                    const data = err.response?.data;
                    const existingId = data?.existing_id;
                    const baseMsg = data?.error || err.message || 'Failed';
                    failed.push(
                        existingId
                            ? `${apply} — ${baseMsg} (#${existingId})`
                            : `${apply} — ${baseMsg}`
                    );
                }
            }
            if (created.length) {
                onCreated?.(created[created.length - 1]);
            }
            if (!failed.length) {
                onOpenChange(false);
            } else {
                setError(
                    `Added ${created.length} of ${rows.length}. ` +
                    (failed.length ? `Skipped/failed:\n${failed.slice(0, 8).join('\n')}` : '') +
                    (failed.length > 8 ? `\n…and ${failed.length - 8} more` : '')
                );
            }
        } finally {
            setSubmitting(false);
            setBulkProgress(null);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Add job link{mode === 'bulk' ? 's' : ''}</DialogTitle>
                    <DialogDescription>
                        {mode === 'bulk'
                            ? 'Paste several apply URLs (one per line). After save, JDs are fetched and matching profiles get CVs automatically.'
                            : 'Paste the apply URL and optionally a separate source/JD URL. Matching profiles get CVs automatically once the JD is ready.'}
                    </DialogDescription>
                </DialogHeader>
                <DialogBody>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="flex gap-1 rounded-lg border border-border/70 bg-muted/30 p-1">
                            <Button
                                type="button"
                                size="sm"
                                variant={mode === 'single' ? 'default' : 'ghost'}
                                className="flex-1"
                                onClick={() => setMode('single')}
                            >
                                Single
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant={mode === 'bulk' ? 'default' : 'ghost'}
                                className="flex-1"
                                onClick={() => setMode('bulk')}
                            >
                                Several at once
                            </Button>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="jl-techstack">Techstack *</Label>
                            <Select value={techstack || undefined} onValueChange={setTechstack}>
                                <SelectTrigger id="jl-techstack">
                                    <SelectValue placeholder="Pick a techstack" />
                                </SelectTrigger>
                                <SelectContent>
                                    {TECHSTACKS.map((t) => (
                                        <SelectItem key={t.value} value={t.value}>
                                            {t.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {mode === 'bulk' ? (
                                <p className="text-xs text-muted-foreground">
                                    Applied to every URL in the list.
                                </p>
                            ) : null}
                        </div>

                        {mode === 'single' ? (
                            <>
                                <div className="space-y-1.5">
                                    <Label htmlFor="jl-apply-url">Apply URL *</Label>
                                    <Input
                                        id="jl-apply-url"
                                        placeholder="https://boards.greenhouse.io/... (apply form)"
                                        value={applyUrl}
                                        onChange={(e) => setApplyUrl(e.target.value)}
                                        autoComplete="off"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Used by Lumi to open and fill the application.
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="jl-source-url">Source / JD URL (optional)</Label>
                                    <Input
                                        id="jl-source-url"
                                        placeholder="https://www.linkedin.com/jobs/... or listing page"
                                        value={sourceUrl}
                                        onChange={(e) => setSourceUrl(e.target.value)}
                                        autoComplete="off"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Used to scrape the job description. Leave blank to use the Apply URL.
                                    </p>
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="jl-description">Job description (optional)</Label>
                                    <Textarea
                                        id="jl-description"
                                        placeholder="Paste a job description here if you have it on hand…"
                                        rows={4}
                                        value={description}
                                        onChange={(e) => setDescription(e.target.value)}
                                    />
                                </div>
                            </>
                        ) : (
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-bulk-urls">URLs * ({bulkPreview.rows.length} ready)</Label>
                                <Textarea
                                    id="jl-bulk-urls"
                                    placeholder={'https://boards.greenhouse.io/acme/jobs/123\nhttps://jobs.lever.co/acme/abc\nhttps://boards.greenhouse.io/... | https://linkedin.com/jobs/view/456'}
                                    rows={10}
                                    value={bulkText}
                                    onChange={(e) => setBulkText(e.target.value)}
                                    className="font-mono text-xs"
                                />
                                <p className="text-xs text-muted-foreground">
                                    One apply URL per line. Optional dual link: apply | source
                                </p>
                                {bulkPreview.errors.length ? (
                                    <p className="whitespace-pre-wrap text-xs text-amber-400">
                                        {bulkPreview.errors.slice(0, 5).join('\n')}
                                        {bulkPreview.errors.length > 5
                                            ? `\n…and ${bulkPreview.errors.length - 5} more`
                                            : ''}
                                    </p>
                                ) : null}
                            </div>
                        )}

                        <div className="space-y-1.5">
                            <Label htmlFor="jl-comment">Comment / notes (optional)</Label>
                            <Textarea
                                id="jl-comment"
                                placeholder="Team notes — e.g. priority, contact, why we skipped…"
                                rows={2}
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                            />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-location">Location (optional)</Label>
                                <Input
                                    id="jl-location"
                                    placeholder="e.g. Sao Paulo, Brazil"
                                    value={location}
                                    onChange={(e) => setLocation(e.target.value)}
                                    autoComplete="off"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-flag">Region flag</Label>
                                <Select
                                    value={locationFlag}
                                    onValueChange={(v) => {
                                        flagManuallySetRef.current = true;
                                        setLocationFlag(v);
                                    }}
                                >
                                    <SelectTrigger id="jl-flag">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {LOCATION_FLAGS.map((flag) => (
                                            <SelectItem key={flag} value={flag}>
                                                {flag}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        {error && (
                            <div className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                {error}
                            </div>
                        )}
                        {bulkProgress && (
                            <p className="text-xs text-muted-foreground">
                                Adding {bulkProgress.current} of {bulkProgress.total}…
                            </p>
                        )}
                    </form>
                </DialogBody>
                <DialogFooter>
                    <Button variant="ghost" type="button" onClick={() => onOpenChange(false)} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button type="submit" onClick={handleSubmit} disabled={submitting}>
                        {submitting ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                {mode === 'bulk' && bulkProgress
                                    ? `${bulkProgress.current}/${bulkProgress.total}`
                                    : 'Saving…'}
                            </>
                        ) : mode === 'bulk' ? (
                            `Add ${bulkPreview.rows.length || ''} link${bulkPreview.rows.length === 1 ? '' : 's'}`.trim()
                        ) : (
                            'Save'
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// -----------------------------------------------------------------------------
// Edit modal — open from any row's pencil button. Lets the user
// correct the cron-parsed values (company / position / location /
// description), change the techstack, swap a Source or Job-apply URL,
// and toggle availability. Saving a different Source URL re-queues
// the row for the cron (the backend resets fetch_status='pending'
// when the URL changes).
// -----------------------------------------------------------------------------

function EditJobLinkModal({ row, open, onOpenChange, onSaved }) {
    const [techstack, setTechstack] = useState('');
    const flagManuallySetRef = useRef(false);
    const [applyUrl, setApplyUrl] = useState('');
    const [sourceUrl, setSourceUrl] = useState('');
    const [company, setCompany] = useState('');
    const [positionTitle, setPositionTitle] = useState('');
    const [location, setLocation] = useState('');
    const [locationFlag, setLocationFlag] = useState('US');
    const [description, setDescription] = useState('');
    const [comment, setComment] = useState('');
    const [isAvailable, setIsAvailable] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(null);

    // Hydrate the form whenever a different row is opened. Without
    // this, switching between rows without closing the modal would
    // show the previous row's stale values.
    useEffect(() => {
        if (row && open) {
            setTechstack(row.techstack || '');
            setApplyUrl(row.job_apply_url || row.linkedin_url || '');
            setSourceUrl(row.source_url || row.linkedin_url || '');
            setCompany(row.company_name || '');
            setPositionTitle(row.position_title || '');
            setLocation(row.location || '');
            setLocationFlag(row.location_flag || 'US');
            flagManuallySetRef.current = false;
            setDescription(row.job_description || '');
            setComment(row.comment || '');
            setIsAvailable(row.is_available ? 1 : 0);
            setError(null);
        }
    }, [row, open]);

    if (!row) return null;

    const handleSubmit = async (e) => {
        e?.preventDefault?.();
        setError(null);
        if (!techstack || !VALID_TECHSTACKS.includes(techstack)) {
            setError(`techstack must be one of: ${VALID_TECHSTACKS.join(', ')}`);
            return;
        }
        if (!applyUrl.trim()) {
            setError('Apply URL is required');
            return;
        }
        setSubmitting(true);
        try {
            const apply = applyUrl.trim();
            const sourceRaw = sourceUrl.trim();
            // Omit redundant source (same posting / empty). Server also coalesces.
            const source = sourceRaw && !sameJobLinkUrls(sourceRaw, apply)
                ? sourceRaw
                : null;
            const res = await adminAPI.updateJobLink(row.id, {
                techstack,
                source_url: source,
                job_apply_url: apply,
                company_name: company.trim() || null,
                position_title: positionTitle.trim() || null,
                location: location.trim() || null,
                location_flag: LOCATION_FLAGS.includes(locationFlag) ? locationFlag : 'US',
                job_description: description.trim() || null,
                comment: comment.trim() || null,
                is_available: isAvailable ? 1 : 0,
            });
            onSaved?.(res.data?.data);
            onOpenChange(false);
        } catch (err) {
            // 409 with `existing_id` on a PATCH means the new URL
            // collides with a different row. Show the existing row
            // id so the user can jump to it instead of staring at
            // a dead-end error.
            const data = err.response?.data;
            const existingId = data?.existing_id;
            const baseMsg = data?.error || 'Failed to save job link';
            if (err.response?.status === 409 && existingId && existingId !== row.id) {
                setError(`${baseMsg} (existing row #${existingId})`);
            } else {
                setError(baseMsg);
            }
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Edit job link #{row.id}</DialogTitle>
                    <DialogDescription>
                        Update apply / source URLs, techstack, or scraped fields.
                        Changing the Source URL re-queues scrape for a fresh description.
                    </DialogDescription>
                </DialogHeader>

                <DialogBody>
                    <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-edit-techstack">Techstack *</Label>
                                <Select value={techstack || undefined} onValueChange={setTechstack}>
                                    <SelectTrigger id="jl-edit-techstack">
                                        <SelectValue placeholder="Pick a techstack" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {TECHSTACKS.map((t) => (
                                            <SelectItem key={t.value} value={t.value}>
                                                {t.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-1.5">
                                <Label htmlFor="jl-edit-available">Availability</Label>
                                <Select
                                    value={isAvailable ? '1' : '0'}
                                    onValueChange={(v) => setIsAvailable(v === '1' ? 1 : 0)}
                                >
                                    <SelectTrigger id="jl-edit-available">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="1">Available</SelectItem>
                                        <SelectItem value="0">Unavailable</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="jl-edit-apply-url">Apply URL *</Label>
                            <Input
                                id="jl-edit-apply-url"
                                placeholder="https://boards.greenhouse.io/... (where the form is)"
                                value={applyUrl}
                                onChange={(e) => setApplyUrl(e.target.value)}
                                autoComplete="off"
                            />
                            <p className="text-xs text-muted-foreground">
                                Used by Lumi. Must be unique across job links.
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="jl-edit-source-url">Source / JD URL (optional)</Label>
                            <Input
                                id="jl-edit-source-url"
                                placeholder="https://www.linkedin.com/jobs/... or listing page"
                                value={sourceUrl}
                                onChange={(e) => setSourceUrl(e.target.value)}
                                autoComplete="off"
                            />
                            <p className="text-xs text-muted-foreground">
                                Used to scrape the job description. Leave blank to use the Apply URL.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-edit-company">Company</Label>
                                <Input
                                    id="jl-edit-company"
                                    placeholder="e.g. Acme Corp"
                                    value={company}
                                    onChange={(e) => setCompany(e.target.value)}
                                    autoComplete="off"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-edit-position">Position title</Label>
                                <Input
                                    id="jl-edit-position"
                                    placeholder="e.g. Senior Backend Engineer"
                                    value={positionTitle}
                                    onChange={(e) => setPositionTitle(e.target.value)}
                                    autoComplete="off"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-edit-location">Location</Label>
                                <Input
                                    id="jl-edit-location"
                                    placeholder="e.g. Remote (United States)"
                                    value={location}
                                    onChange={(e) => setLocation(e.target.value)}
                                    autoComplete="off"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="jl-edit-flag">Region flag</Label>
                                <Select
                                    value={locationFlag}
                                    onValueChange={(v) => {
                                        flagManuallySetRef.current = true;
                                        setLocationFlag(v);
                                    }}
                                >
                                    <SelectTrigger id="jl-edit-flag">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {LOCATION_FLAGS.map((flag) => (
                                            <SelectItem key={flag} value={flag}>
                                                {flag}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <p className="text-xs text-muted-foreground">
                                    Profiles only appear when their region and techstack match this job.
                                </p>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="jl-edit-description">Job description</Label>
                            <Textarea
                                id="jl-edit-description"
                                placeholder="Paste or write the full job description here. If a Source URL is set, the cron will overwrite this on the next scrape."
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={8}
                                className="font-sans"
                            />
                            <p className="text-xs text-muted-foreground">
                                {description ? `${description.length.toLocaleString()} chars` : 'Empty'}
                                {row.fetch_status === 'success' && (
                                    <span className="ml-2">
                                        — will be replaced on the next cron scrape unless the Source URL is empty.
                                    </span>
                                )}
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <Label htmlFor="jl-edit-comment">Comment / notes</Label>
                            <Textarea
                                id="jl-edit-comment"
                                placeholder="Team notes — priority, contact, skip reason…"
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                rows={3}
                            />
                        </div>

                        {error && (
                            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                                {error}
                            </div>
                        )}
                    </form>
                </DialogBody>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                        Cancel
                    </Button>
                    <Button onClick={handleSubmit} disabled={submitting}>
                        {submitting ? (
                            <>
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                Saving…
                            </>
                        ) : (
                            'Save'
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// -----------------------------------------------------------------------------
// View-detail modal
// -----------------------------------------------------------------------------
//
// Read-only modal that surfaces the full state of a single row:
// title / company / location / description (whatever the scraper
// has stored), plus metadata (fetch status, timestamps). Used by
// the row's eye-icon button so users can see why a row's status is
// `failed` or read the auto-fetched description without leaving the
// page.
//
// The description is rendered in a scrollable box with whitespace
// preserved (it's plain text — no HTML escaping needed beyond what
// React already does for text children).

function JobLinkDetailModal({ row, open, onOpenChange, onAvailabilityToggled }) {
    if (!row) return null;

    const fetchMeta = FETCH_STATUS_META[row.fetch_status] || FETCH_STATUS_META.pending;
    const jdMeta = jdStatusMeta(row);
    const av = jobLinkAvailabilityMeta(row);

    const techLabel = TECHSTACK_LABEL[row.techstack] || row.techstack || '—';
    const title = row.position_title || '—';
    const company = row.company_name || '—';
    const location = row.location || '—';
    const description = row.job_description || '';

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="font-medium">{techLabel}</Badge>
                        <Badge variant={av.variant}>{av.label}</Badge>
                        <Badge variant={fetchMeta.variant}>Fetch: {fetchMeta.label}</Badge>
                        <Badge variant={jdMeta.variant}>JD: {jdMeta.label}</Badge>
                        {row.clearance_required && (
                            <Badge variant="destructive" title={`Auto-disabled by the scraper: ${row.clearance_required}`}>
                                Clearance: {row.clearance_required}
                            </Badge>
                        )}
                    </div>
                    <DialogTitle className="mt-2 leading-tight">{title}</DialogTitle>
                    <DialogDescription className="space-y-1">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                            <span className="inline-flex items-center gap-1.5">
                                <Building2 className="h-3 w-3" />
                                {company}
                            </span>
                            {row.location && (
                                <span className="inline-flex items-center gap-1.5">
                                    <MapPin className="h-3 w-3" />
                                    {location}
                                </span>
                            )}
                        </div>
                    </DialogDescription>
                </DialogHeader>

                <DialogBody>
                    <div className="space-y-4">
                        {/* Dual links: apply + optional source/JD */}
                        <div className="space-y-2">
                            {row.job_apply_url ? (
                                <div>
                                    <Label className="text-[11px] uppercase text-muted-foreground">Apply URL</Label>
                                    <a
                                        href={row.job_apply_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block break-all text-xs text-primary hover:underline"
                                    >
                                        {row.job_apply_url}
                                    </a>
                                </div>
                            ) : primaryJobUrl(row) ? (
                                <div>
                                    <Label className="text-[11px] uppercase text-muted-foreground">Apply URL</Label>
                                    <a
                                        href={primaryJobUrl(row)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block break-all text-xs text-primary hover:underline"
                                    >
                                        {primaryJobUrl(row)}
                                    </a>
                                </div>
                            ) : (
                                <span className="text-xs text-muted-foreground">No apply URL</span>
                            )}
                            {row.source_url
                                && row.source_url !== row.job_apply_url
                                && row.source_url !== (row.linkedin_url || '') ? (
                                <div>
                                    <Label className="text-[11px] uppercase text-muted-foreground">Source / JD URL</Label>
                                    <a
                                        href={row.source_url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block break-all text-xs text-primary hover:underline"
                                    >
                                        {row.source_url}
                                    </a>
                                </div>
                            ) : null}
                        </div>

                        {/* Available profiles + state */}
                        <div>
                            <Label className="text-[11px] uppercase text-muted-foreground">
                                Available profiles
                                {Array.isArray(row.available_profiles) && (
                                    <span className="ml-2 normal-case text-muted-foreground/80">
                                        ({row.available_profiles.length})
                                    </span>
                                )}
                            </Label>
                            <div className="mt-1">
                                <AvailableProfilesCell profiles={row.available_profiles} />
                            </div>
                        </div>

                        {/* Description */}
                        <div>
                            <Label className="text-[11px] uppercase text-muted-foreground">
                                Comment / notes
                            </Label>
                            {row.comment ? (
                                <p className="mt-1 rounded-md border bg-muted/40 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                                    {row.comment}
                                </p>
                            ) : (
                                <div className="mt-1 rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                                    No comment yet. Edit the row to add team notes.
                                </div>
                            )}
                        </div>

                        <div>
                            <Label className="text-[11px] uppercase text-muted-foreground">
                                Job description
                                {description && (
                                    <span className="ml-2 normal-case text-muted-foreground/80">
                                        ({description.length.toLocaleString()} chars)
                                    </span>
                                )}
                            </Label>
                            {description ? (
                                <pre className="mt-1 max-h-[50vh] overflow-y-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words font-sans">
{description}
                                </pre>
                            ) : (
                                <div className="mt-1 rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                                    No description yet. The background scraper fetches this automatically;
                                    refresh the table in a minute or two.
                                </div>
                            )}
                        </div>

                        {/* Fetch metadata */}
                        <div className="grid grid-cols-1 gap-2 rounded-md border bg-muted/30 p-3 text-xs sm:grid-cols-2">
                            <div>
                                <div className="text-[10px] uppercase text-muted-foreground">Fetch status</div>
                                <div className="font-medium">{fetchMeta.label}</div>
                            </div>
                            <div>
                                <div className="text-[10px] uppercase text-muted-foreground">Added by</div>
                                <div className="font-medium">{row.created_by_username || '—'}</div>
                            </div>
                            <div>
                                <div className="text-[10px] uppercase text-muted-foreground">Added</div>
                                <div className="font-medium">{formatJobLinkTimestamp(row.created_at)}</div>
                            </div>
                            <div>
                                <div className="text-[10px] uppercase text-muted-foreground">Last fetched</div>
                                <div className="font-medium">
                                    {row.last_fetched_at
                                        ? formatJobLinkTimestamp(row.last_fetched_at)
                                        : '—'}
                                </div>
                            </div>
                            <div>
                                <div className="text-[10px] uppercase text-muted-foreground">Row id</div>
                                <div className="font-mono text-xs">#{row.id}</div>
                            </div>
                            {row.fetch_error && (
                                <div className="sm:col-span-2">
                                    <div className="text-[10px] uppercase text-destructive">Fetch error</div>
                                    <div className="text-xs text-destructive/90 break-words">{row.fetch_error}</div>
                                </div>
                            )}
                        </div>
                    </div>
                </DialogBody>

                <DialogFooter>
                    {onAvailabilityToggled && (
                        <Button
                            variant="outline"
                            onClick={() => onAvailabilityToggled(row)}
                        >
                            Mark as {row.is_available ? 'unavailable' : 'available'}
                        </Button>
                    )}
                    <Button onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

function JobLinks({ embedded = false }) {
    // The page is the team's shared job directory. Any logged-in user
    // can browse, add, edit (techstack/availability/URLs), and delete
    // rows.
    // Click handler for opening the new detail page. We keep the
    // row-level click independent from the per-action buttons so
    // clicking the row body opens the detail page while clicking
    // a button (edit / delete / view-modal) only fires the
    // button's onClick (we stopPropagation on those).
    const navigate = useNavigate();
    // The JobLinks component is rendered under both /admin/job-links
    // and /user/job-links, so the row click has to derive its
    // detail-page URL from the current location prefix instead of
    // hardcoding /admin/.... This way the same component works on
    // both sides without a role check.
    const location = useLocation();
    // Hub mount: /user/pipeline or /admin/pipeline → detail under .../pipeline/links/:id
    const detailPrefix = (() => {
        const path = location.pathname.replace(/\/$/, '');
        if (/\/pipeline(?:\/|$)/.test(path)) {
            const root = path.startsWith('/admin') ? '/admin' : '/user';
            return `${root}/pipeline/links`;
        }
        return path;
    })();

    // Filters are seeded from URL search params so bookmarked / shared
    // links restore the same view after navigation. If the URL is empty
    // (Back from a job, or the sidebar Job Links tab), restore the last
    // list view from sessionStorage so page + filters are not wiped.
    const [searchParams, setSearchParams] = useSearchParams();
    const initialFiltersRef = useRef(resolveJobLinksListState(searchParams));

    // Filter state (text inputs are local; only debounced values drive the request).
    const [search, setSearch, debouncedSearch] = useDebouncedValue(initialFiltersRef.current.search);
    const [techstackFilter, setTechstackFilter] = useState(initialFiltersRef.current.techstack);
    const [platformFilter, setPlatformFilter] = useState(initialFiltersRef.current.platform);
    const [availableFilter, setAvailableFilter] = useState(initialFiltersRef.current.available);
    const [bidStateFilter, setBidStateFilter] = useState(initialFiltersRef.current.bidState || 'all');
    // Restrict the list to job_links that have at least one
    // job_applications row with a ready resume. Useful for the
    // post-batch pass — show only what actually produced a
    // downloadable DOCX instead of the full backlog.
    const [hasGeneratedResumeFilter, setHasGeneratedResumeFilter] = useState(
        initialFiltersRef.current.hasGeneratedResume
    );
    const [dateFrom, setDateFrom, debouncedDateFrom] = useDebouncedValue(initialFiltersRef.current.dateFrom);
    const [dateTo, setDateTo, debouncedDateTo] = useDebouncedValue(initialFiltersRef.current.dateTo);
    // "Today" is a quick-filter shortcut: when on, it sets both date
    // bounds to today's local date and pins them. Toggling off
    // clears both bounds so the user gets back to the unfiltered
    // view. We track the state separately so the active-chip list
    // and the button label can react to it.
    const [isTodayActive, setIsTodayActive] = useState(initialFiltersRef.current.today);

    // Pagination. We mirror the page number to the URL search
    // params (?page=N) so the user lands back on the same page
    // after navigating into a job-link detail page and back —
    // either via the in-app Back button, the browser back button, or a
    // shared/bookmarked URL. URL wins when it has list state;
    // otherwise we hydrate from sessionStorage (see resolve above).
    const [page, setPageState] = useState(initialFiltersRef.current.page);
    // setPage wraps the raw state setter so every navigation /
    // pagination click also updates the URL. We pass a `replace`
    // flag (default true) so the page number doesn't pollute the
    // browser history — otherwise every pagination click would
    // push a new history entry and Back would only step back one
    // page at a time.
    const setPage = useCallback((updater) => {
        setPageState((prev) => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            return Math.max(1, Number.isFinite(next) ? next : 1);
        });
    }, []);

    // Keep URL search params and sessionStorage in sync with React
    // filter + page state so Back from a job remounts the same view.
    useEffect(() => {
        const snapshot = {
            page,
            search: search || debouncedSearch,
            techstack: techstackFilter,
            platform: platformFilter,
            available: availableFilter,
            bidState: bidStateFilter,
            hasGeneratedResume: hasGeneratedResumeFilter,
            dateFrom: dateFrom || debouncedDateFrom,
            dateTo: dateTo || debouncedDateTo,
            today: isTodayActive
        };
        writeSavedJobLinksListState(snapshot);
        const nextQuery = jobLinksListStateToQuery({
            ...snapshot,
            search: debouncedSearch,
            dateFrom: debouncedDateFrom,
            dateTo: debouncedDateTo
        });
        const next = new URLSearchParams(nextQuery.startsWith('?') ? nextQuery.slice(1) : nextQuery);
        if (searchParams.toString() === next.toString()) return;
        setSearchParams(next, { replace: true });
    }, [
        page,
        search,
        dateFrom,
        dateTo,
        debouncedSearch,
        techstackFilter,
        platformFilter,
        availableFilter,
        bidStateFilter,
        hasGeneratedResumeFilter,
        debouncedDateFrom,
        debouncedDateTo,
        isTodayActive,
        searchParams,
        setSearchParams
    ]);
    const [limit] = useState(DEFAULT_LIMIT);
    const [total, setTotal] = useState(0);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    // When the result set shrinks below the current page (e.g. a
    // shared link pointed at ?page=5 but only 2 pages exist, or
    // filters narrowed the result), bounce back to the last
    // available page so the user doesn't see an empty table.
    // Also runs on first load once `total` is populated.
    useEffect(() => {
        if (total > 0 && page > totalPages) {
            setPage(totalPages);
        }
    }, [total, page, totalPages]);

    // Data + UI state
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tableLoading, setTableLoading] = useState(false);
    const [syncingCvs, setSyncingCvs] = useState(false);
    const [refreshingRowIds, setRefreshingRowIds] = useState(() => new Set());
    const [error, setError] = useState(null);
    const [showAdd, setShowAdd] = useState(false);
    const [viewRow, setViewRow] = useState(null);
    const [viewOpen, setViewOpen] = useState(false);
    const [editRow, setEditRow] = useState(null);
    const [editOpen, setEditOpen] = useState(false);
    const [cronStatus, setCronStatus] = useState(null);
    // Bulk-copy selection. We store `Set<id>` so toggling costs
    // O(1) and re-renders only the rows whose membership
    // changed. Reset on every fresh fetch so the user doesn't
    // accidentally copy rows that scrolled off the page.
    const [selectedIds, setSelectedIds] = useState(() => readSelectedIds());
    const [bulkCopyOpen, setBulkCopyOpen] = useState(false);
    const [bulkCopied, setBulkCopied] = useState(false);
    const [autoBidderOpen, setAutoBidderOpen] = useState(false);
    const [biddingBanner, setBiddingBanner] = useState('');
    const isAdminPath = location.pathname.startsWith('/admin');

    useEffect(() => {
        writeSelectedIds(selectedIds);
    }, [selectedIds]);

    // Drop selections that are no longer on this page (filters / empty list).
    useEffect(() => {
        setSelectedIds((prev) => {
            if (prev.size === 0) return prev;
            const visible = new Set(rows.map((r) => r.id));
            const next = new Set([...prev].filter((id) => visible.has(id)));
            return next.size === prev.size ? prev : next;
        });
    }, [rows]);

    // Reset page in the same event tick as immediate filter changes so
    // the fetch never runs with a stale page number (e.g. page=2 from
    // the unfiltered list while techstackFilter has already switched).
    const changeTechstackFilter = useCallback((value) => {
        setTechstackFilter(value);
        setPage(1);
    }, [setPage]);
    const changePlatformFilter = useCallback((value) => {
        setPlatformFilter(value);
        setPage(1);
    }, [setPage]);
    const changeAvailableFilter = useCallback((value) => {
        setAvailableFilter(value);
        setPage(1);
    }, [setPage]);
    const changeHasGeneratedResumeFilter = useCallback((value) => {
        setHasGeneratedResumeFilter(Boolean(value));
        setPage(1);
    }, [setPage]);
    const changeBidStateFilter = useCallback((value) => {
        setBidStateFilter(value || 'all');
        setPage(1);
    }, [setPage]);

    // Active-filter chip list for the top bar.
    const activeChips = useMemo(() => {
        const out = [];
        if (techstackFilter !== 'all') {
            out.push({
                key: 'techstack',
                label: `Tech: ${TECHSTACK_LABEL[techstackFilter] || techstackFilter}`,
                onClear: () => changeTechstackFilter('all')
            });
        }
        if (platformFilter !== 'all') {
            out.push({
                key: 'platform',
                label: `Platform: ${PLATFORM_LABEL[platformFilter] || platformFilter}`,
                onClear: () => changePlatformFilter('all')
            });
        }
        if (availableFilter !== 'all') {
            out.push({
                key: 'available',
                label: availableFilter === '1' ? 'Available only' : 'Unavailable only',
                onClear: () => changeAvailableFilter('all')
            });
        }
        if (bidStateFilter !== 'all') {
            out.push({
                key: 'bid_state',
                label: `Bid: ${bidStateFilter.toUpperCase()}`,
                onClear: () => changeBidStateFilter('all')
            });
        }
        if (hasGeneratedResumeFilter) {
            out.push({
                key: 'has_generated_resume',
                label: 'Resume generated only',
                onClear: () => changeHasGeneratedResumeFilter(false)
            });
        }
        if (debouncedDateFrom) {
            out.push({
                key: 'date_from',
                label: `From: ${debouncedDateFrom}`,
                onClear: () => setDateFrom('')
            });
        }
        if (debouncedDateTo) {
            out.push({
                key: 'date_to',
                label: `To: ${debouncedDateTo}`,
                onClear: () => setDateTo('')
            });
        }
        if (debouncedSearch) {
            out.push({
                key: 'search',
                label: `Search: ${debouncedSearch}`,
                onClear: () => setSearch('')
            });
        }
        if (isTodayActive) {
            out.push({
                key: 'today',
                label: 'Today',
                onClear: () => {
                    setPage(1);
                    setIsTodayActive(false);
                    setDateFrom('');
                    setDateTo('');
                }
            });
        }
        return out;
    }, [techstackFilter, platformFilter, availableFilter, bidStateFilter, hasGeneratedResumeFilter, debouncedDateFrom, debouncedDateTo, debouncedSearch, isTodayActive, changeTechstackFilter, changePlatformFilter, changeAvailableFilter, changeBidStateFilter, changeHasGeneratedResumeFilter]);

    const resetFilters = () => {
        setSearch('');
        setTechstackFilter('all');
        setPlatformFilter('all');
        setAvailableFilter('all');
        setBidStateFilter('all');
        setHasGeneratedResumeFilter(false);
        setDateFrom('');
        setDateTo('');
        setIsTodayActive(false);
        setPage(1);
    };

    // "Today" is a shortcut for the date bounds. When toggled on,
    // we pin both From and To to today's local date (YYYY-MM-DD)
    // so the API's date_from/date_to range shrinks to a single day.
    // Toggling off clears both bounds and lets the user pick
    // manually again. We deliberately bypass resetting the
    // debounced state directly — the debounced hook will mirror
    // the raw value once it stabilises.
    const handleToggleToday = () => {
        setPage(1);
        if (isTodayActive) {
            setIsTodayActive(false);
            setDateFrom('');
            setDateTo('');
        } else {
            const today = new Date().toISOString().split('T')[0];
            setIsTodayActive(true);
            setDateFrom(today);
            setDateTo(today);
        }
    };

    // Reset to page 1 when debounced filters actually change. Compare
    // against the hydrated snapshot instead of "skip first effect"
    // — React Strict Mode re-runs effects, and that skip-first ref
    // was sending users back to page 1 after opening a job and
    // clicking Back.
    const hydratedDebouncedRef = useRef({
        search: initialFiltersRef.current.search,
        dateFrom: initialFiltersRef.current.dateFrom,
        dateTo: initialFiltersRef.current.dateTo
    });
    useEffect(() => {
        const prev = hydratedDebouncedRef.current;
        if (
            debouncedSearch === prev.search
            && debouncedDateFrom === prev.dateFrom
            && debouncedDateTo === prev.dateTo
        ) {
            return;
        }
        hydratedDebouncedRef.current = {
            search: debouncedSearch,
            dateFrom: debouncedDateFrom,
            dateTo: debouncedDateTo
        };
        setPage(1);
    }, [debouncedSearch, debouncedDateFrom, debouncedDateTo, setPage]);

    // Data fetch ----------------------------------------------------------
    const loadRequestRef = useRef(0);
    const load = useCallback(async (opts = {}) => {
        const silent = !!opts.silent;
        const requestId = ++loadRequestRef.current;
        const attemptLoad = async (attempt) => {
            const filters = {};
            if (debouncedSearch)     filters.search = debouncedSearch;
            if (techstackFilter !== 'all') filters.techstack = techstackFilter;
            if (platformFilter !== 'all') filters.platform = platformFilter;
            if (availableFilter !== 'all') filters.available = availableFilter;
            if (debouncedDateFrom)   filters.date_from = debouncedDateFrom;
            if (debouncedDateTo)     filters.date_to = debouncedDateTo;
            if (hasGeneratedResumeFilter) filters.has_generated_resume = 1;
            if (bidStateFilter && bidStateFilter !== 'all') filters.bid_state = bidStateFilter;

            try {
                const [listRes, cronRes] = await Promise.all([
                    adminAPI.listJobLinks(page, limit, filters),
                    adminAPI.getJobLinkCronStatus().catch(() => null)
                ]);
                return { listRes, cronRes };
            } catch (err) {
                // Brief API restarts (file watch / Vite proxy) — retry before showing empty.
                // Vite often surfaces a dead backend as HTTP 500, not ERR_NETWORK.
                const status = err?.response?.status;
                const retriable = !err?.response
                    || err?.code === 'ERR_NETWORK'
                    || (status >= 500 && status <= 599)
                    || /ECONNREFUSED|Network Error|Failed to fetch/i.test(String(err?.message || ''));
                if (retriable && attempt < 3) {
                    await new Promise((r) => setTimeout(r, 700 * attempt));
                    return attemptLoad(attempt + 1);
                }
                throw err;
            }
        };
        try {
            if (!silent) {
                setTableLoading(true);
                setError(null);
            }
            const { listRes, cronRes } = await attemptLoad(1);
            if (requestId !== loadRequestRef.current) return;
            setRows(Array.isArray(listRes.data?.data) ? listRes.data.data : []);
            setTotal(listRes.data?.pagination?.total || 0);
            if (cronRes?.data) setCronStatus(cronRes.data);
        } catch (err) {
            if (requestId !== loadRequestRef.current) return;
            if (!silent) {
                console.error('Load job-links error:', err);
                setError(err.response?.data?.error || 'Failed to load job links — refresh if the API was restarting');
                setRows([]);
                setTotal(0);
            }
        } finally {
            if (requestId === loadRequestRef.current) {
                setLoading(false);
                if (!silent) setTableLoading(false);
            }
        }
    }, [page, limit, debouncedSearch, techstackFilter, platformFilter, availableFilter, bidStateFilter, hasGeneratedResumeFilter, debouncedDateFrom, debouncedDateTo]);

    useEffect(() => {
        load();
    }, [load]);

    // Poll while any CV is generating / pending so chips stay accurate after refresh.
    useEffect(() => {
        const busy = (rows || []).some((r) =>
            (r.available_profiles || []).some((p) =>
                /^(generating|pending)$/i.test(String(p.generation_status || ''))
            )
        );
        const scraping = (rows || []).some((r) =>
            /^(pending|fetching)$/i.test(String(r.fetch_status || ''))
        );
        if (!busy && !scraping) return undefined;
        const t = setInterval(() => {
            load({ silent: true });
        }, 5000);
        return () => clearInterval(t);
    }, [rows, load]);

    // Poll scrape cron status while backlog exists.
    useEffect(() => {
        const inflight = (cronStatus?.fetchQueue?.processingCount || 0) > 0
            || (cronStatus?.fetchQueue?.queueDepth || 0) > 0;
        if (!inflight) return undefined;
        const t = setInterval(() => {
            adminAPI.getJobLinkCronStatus()
                .then((res) => setCronStatus(res.data))
                .catch(() => { /* soft-fail — keep last snapshot */ });
        }, 5000);
        return () => clearInterval(t);
    }, [cronStatus?.fetchQueue?.processingCount, cronStatus?.fetchQueue?.queueDepth]);

    // Detect active Auto Bidder after refresh (Lumi queue).
    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const { sendBidderExtensionCommand } = await import('@/lib/bidderExtensionBridge');
                const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
                if (!alive) return;
                const st = res?.result || res?.data || null;
                const active = !!(
                    st?.running
                    || /^(?:running|awaiting_captcha|awaiting_email_otp|awaiting_next)$/i.test(String(st?.status || ''))
                );
                if (!active) {
                    setBiddingBanner('');
                    return;
                }
                if (/awaiting_email_otp/i.test(String(st?.status || ''))) {
                    setBiddingBanner('Lumi paused — email security code (Instruct Lumi)');
                } else if (/awaiting_captcha/i.test(String(st?.status || ''))) {
                    setBiddingBanner('Lumi paused — CAPTCHA / login (Live monitor bottom-right)');
                } else {
                    const idx = st?.index;
                    const totalQ = st?.total;
                    setBiddingBanner(
                        totalQ
                            ? `Lumi running — Job ${idx || '?'} of ${totalQ} (Live monitor bottom-right)`
                            : 'Lumi running (Live monitor bottom-right)'
                    );
                }
            } catch {
                if (alive) setBiddingBanner('');
            }
        };
        tick();
        const t = setInterval(tick, 6000);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, []);

    // Actions -------------------------------------------------------------

    // Per-row Refetch (RefreshCw) + RabbitMQ worker / retry scheduler
    // own background scraping. Adding a row still enqueues automatically.

    const handleToggleAvailable = async (row) => {
        try {
            const res = await adminAPI.updateJobLink(row.id, { is_available: row.is_available ? 0 : 1 });
            if (res.data?.data) {
                setRows((prev) => prev.map((r) => (
                    r.id === row.id
                        ? { ...r, ...res.data.data, available_profiles: res.data.data.available_profiles ?? r.available_profiles }
                        : r
                )));
            }
        } catch (err) {
            alert(`Failed to update availability: ${err.response?.data?.error || err.message}`);
        }
    };

    const handleDelete = async (row) => {
        if (!window.confirm(`Delete this job link (${TECHSTACK_LABEL[row.techstack] || row.techstack})?`)) return;
        try {
            await adminAPI.deleteJobLink(row.id);
            // If we just removed the only row on this page, fall back
            // to the previous page so the user doesn't see an empty
            // table.
            if (rows.length === 1 && page > 1) {
                setPage((p) => p - 1);
            } else {
                load();
            }
        } catch (err) {
            alert(`Failed to delete: ${err.response?.data?.error || err.message}`);
        }
    };

    const openJobLink = (rowId) => {
        const snapshot = {
            page,
            search,
            techstack: techstackFilter,
            platform: platformFilter,
            available: availableFilter,
            bidState: bidStateFilter,
            hasGeneratedResume: hasGeneratedResumeFilter,
            dateFrom,
            dateTo,
            today: isTodayActive
        };
        writeSavedJobLinksListState(snapshot);
        navigate(`${detailPrefix}/${rowId}${jobLinksListStateToQuery(snapshot)}`);
    };

    const handleRefetch = async (row) => {
        const jdEmpty = !(row.job_description && String(row.job_description).trim());
        setRefreshingRowIds((prev) => {
            const next = new Set(prev);
            next.add(row.id);
            return next;
        });
        try {
            if (jdEmpty) {
                await adminAPI.refetchJobLink(row.id);
                setRows((prev) => prev.map((r) => (
                    r.id === row.id
                        ? { ...r, fetch_status: 'pending', fetch_error: null }
                        : r
                )));
            }
            const res = await adminAPI.reconcileJobLinkCvs(row.id);
            const n = Number(res.data?.enqueued) || 0;
            if (n > 0 || !jdEmpty) {
                await load({ silent: true });
            }
        } catch (err) {
            const msg = err.response?.data?.error || err.message;
            if (jdEmpty) {
                alert(`Refresh failed: ${msg}`);
            } else {
                alert(`Could not generate missing CVs: ${msg}`);
            }
        } finally {
            setRefreshingRowIds((prev) => {
                const next = new Set(prev);
                next.delete(row.id);
                return next;
            });
        }
    };

    const handleRefreshPage = async () => {
        const ids = (selectedIds.size > 0 ? [...selectedIds] : rows.map((r) => r.id))
            .filter((id) => Number.isFinite(id) && id > 0);
        setSyncingCvs(true);
        try {
            if (ids.length > 0) {
                await adminAPI.reconcileJobLinksCvs(ids);
            }
        } catch (err) {
            alert(`Could not generate missing CVs: ${err.response?.data?.error || err.message}`);
        } finally {
            setSyncingCvs(false);
        }
        await load();
    };

    // Bulk Apply — mark every pending application under this
    const handleEditSaved = (updated) => {
        if (!updated) return;
        setRows((prev) => prev.map((r) => (
            r.id === updated.id
                ? { ...r, ...updated, available_profiles: updated.available_profiles ?? r.available_profiles }
                : r
        )));
    };

    if (loading) return <PageLoader message="Loading job links..." />;

    return (
        <>
            <AppPage
                embedded={embedded}
                icon={Link2}
                title="Job Links"
                description="Queue, filter, and bid selected roles."
                footer={(
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-white/50">
                        <span>
                            {total === 0
                                ? 'No rows'
                                : <>Showing <strong className="text-white">{(page - 1) * limit + 1}–{Math.min(page * limit, total)}</strong> of <strong className="text-white">{total}</strong></>}
                        </span>
                        {totalPages > 1 && (
                            <div className="flex items-center gap-2">
                                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                                    <ChevronLeft className="h-3.5 w-3.5" /> Prev
                                </Button>
                                <span className="font-medium text-white/70">Page {page} of {totalPages}</span>
                                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                                    Next <ChevronRight className="h-3.5 w-3.5" />
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            >
                <div className="space-y-4">
                    <PageCommandBar
                        search={(
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                                <Input
                                    id="jl-search"
                                    className="h-10 border-white/10 bg-black/25 pl-10"
                                    placeholder="Search company, profile, URL…"
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                />
                            </div>
                        )}
                        actions={(
                            <>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10"
                                    onClick={handleRefreshPage}
                                    disabled={tableLoading || syncingCvs}
                                    title={selectedIds.size
                                        ? `Generate missing CVs for ${selectedIds.size} selected job(s)`
                                        : 'Reload the list and generate CVs for matching profiles that do not have one yet'}
                                >
                                    <RefreshCw className={cn('h-4 w-4', (tableLoading || syncingCvs) && 'animate-spin')} />
                                    <span className="hidden sm:inline">Refresh</span>
                                </Button>
                                <Button
                                    size="sm"
                                    className="h-10"
                                    onClick={() => setAutoBidderOpen(true)}
                                    title={selectedIds.size ? `Bid ${selectedIds.size} selected` : 'Select links or use row Bid'}
                                >
                                    <Zap className="h-4 w-4" />
                                    Lumi{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-10"
                                    onClick={() => setBulkCopyOpen(true)}
                                    disabled={selectedIds.size === 0}
                                >
                                    <Copy className="h-4 w-4" />
                                    <span className="hidden sm:inline">Copy{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}</span>
                                </Button>
                                <Button size="sm" className="h-10" onClick={() => setShowAdd(true)}>
                                    <Plus className="h-4 w-4" />
                                    Add
                                </Button>
                            </>
                        )}
                        filters={(
                            <>
                                <Select value={techstackFilter} onValueChange={changeTechstackFilter}>
                                    <SelectTrigger className="h-9 w-[8.5rem] border-white/10 bg-black/20">
                                        <SelectValue placeholder="Stack" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All stacks</SelectItem>
                                        {TECHSTACKS.map((t) => (
                                            <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select value={platformFilter} onValueChange={changePlatformFilter}>
                                    <SelectTrigger className="h-9 w-[10.5rem] border-white/10 bg-black/20">
                                        <SelectValue placeholder="Platform" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All platforms</SelectItem>
                                        {PLATFORMS.map((p) => (
                                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select value={availableFilter} onValueChange={changeAvailableFilter}>
                                    <SelectTrigger className="h-9 w-[8.5rem] border-white/10 bg-black/20">
                                        <SelectValue placeholder="Availability" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All status</SelectItem>
                                        <SelectItem value="1">Available</SelectItem>
                                        <SelectItem value="0">Unavailable</SelectItem>
                                    </SelectContent>
                                </Select>
                                <Select value={bidStateFilter} onValueChange={changeBidStateFilter}>
                                    <SelectTrigger className="h-9 w-[9.5rem] border-white/10 bg-black/20">
                                        <SelectValue placeholder="Bid state" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All bids</SelectItem>
                                        <SelectItem value="success">SUCCESS</SelectItem>
                                        <SelectItem value="filled">FILLED</SelectItem>
                                        <SelectItem value="failed">FAILED</SelectItem>
                                    </SelectContent>
                                </Select>
                                <div className="w-[9rem]">
                                    <DatePicker value={dateFrom} onChange={setDateFrom} placeholder="From" />
                                </div>
                                <div className="w-[9rem]">
                                    <DatePicker value={dateTo} onChange={setDateTo} placeholder="To" />
                                </div>
                                <Button
                                    type="button"
                                    variant={isTodayActive ? 'default' : 'outline'}
                                    size="sm"
                                    className="h-9"
                                    onClick={handleToggleToday}
                                >
                                    Today
                                </Button>
                                <label
                                    htmlFor="has-generated-resume"
                                    className={cn(
                                        'inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-medium transition',
                                        hasGeneratedResumeFilter
                                            ? 'border-primary/40 bg-primary/15 text-primary'
                                            : 'border-white/10 bg-black/20 text-white/55 hover:text-white/80'
                                    )}
                                >
                                    <Checkbox
                                        id="has-generated-resume"
                                        checked={hasGeneratedResumeFilter}
                                        onCheckedChange={changeHasGeneratedResumeFilter}
                                    />
                                    Resume generated
                                </label>
                            </>
                        )}
                        chips={activeChips.length > 0 ? (
                            <>
                                {activeChips.map((c) => (
                                    <FilterChip key={c.key} label={c.label} onClear={c.onClear} />
                                ))}
                                <Button variant="ghost" size="sm" onClick={resetFilters}>Reset all</Button>
                            </>
                        ) : null}
                    />

                    {biddingBanner ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/35 bg-primary/10 px-4 py-2.5 text-sm">
                            <Zap className="h-4 w-4 shrink-0 text-primary" />
                            <span className="min-w-0 flex-1">{biddingBanner}</span>
                            <Button size="sm" variant="outline" className="h-7" onClick={() => setAutoBidderOpen(true)}>
                                Open Lumi
                            </Button>
                        </div>
                    ) : null}
                    {error && (
                        <div className="rounded-xl border border-destructive/50 bg-destructive/15 px-4 py-3 text-sm text-red-200">{error}</div>
                    )}

                    <ListToolbar
                        className="py-1.5"
                        leading={(
                            <Checkbox
                                checked={rows.length > 0 && selectedIds.size === rows.length ? true : selectedIds.size > 0 ? 'indeterminate' : false}
                                onCheckedChange={(checked) => setSelectedIds(checked ? new Set(rows.map((r) => r.id)) : new Set())}
                                aria-label="Select all rows"
                                disabled={rows.length === 0}
                            />
                        )}
                        label={
                            selectedIds.size > 0
                                ? `${selectedIds.size} selected`
                                : rows.length === 0
                                    ? 'No rows'
                                    : `${rows.length} on this page`
                        }
                    />

                    <div className="relative space-y-1.5">
                        {tableLoading && (
                            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/50 backdrop-blur-sm">
                                <Loader size="lg" />
                            </div>
                        )}
                        {rows.length === 0 ? (
                            <div className="rounded-xl border border-dashed border-white/10 bg-black/15 px-4 py-6 text-center text-sm text-white/40">
                                {total === 0 && activeChips.length === 0
                                    ? 'No job links yet. Click Add to create the first one.'
                                    : 'No rows match your filters. Reset to see existing links.'}
                            </div>
                        ) : (
                            rows.map((row, idx) => {
                                const av = jobLinkAvailabilityMeta(row);
                                const fs = FETCH_STATUS_META[row.fetch_status] || FETCH_STATUS_META.pending;
                                const jd = jdStatusMeta(row);
                                const rowNumber = (page - 1) * limit + idx + 1;
                                return (
                                    <JobLinkRowCard
                                        key={row.id}
                                        row={row}
                                        rowNumber={rowNumber}
                                        techLabel={TECHSTACK_LABEL[row.techstack] || row.techstack}
                                        availability={av}
                                        jd={jd}
                                        fetchStatus={fs}
                                        selected={selectedIds.has(row.id)}
                                        onSelect={(checked) => {
                                            setSelectedIds((prev) => {
                                                const next = new Set(prev);
                                                if (checked) next.add(row.id);
                                                else next.delete(row.id);
                                                return next;
                                            });
                                        }}
                                        onOpen={() => openJobLink(row.id)}
                                        onToggleAvailable={() => handleToggleAvailable(row)}
                                        onBid={() => {
                                            setSelectedIds(new Set([row.id]));
                                            setAutoBidderOpen(true);
                                        }}
                                        onRefetch={() => handleRefetch(row)}
                                        refetching={refreshingRowIds.has(row.id)}
                                        onView={() => { setViewRow(row); setViewOpen(true); }}
                                        onEdit={() => { setEditRow(row); setEditOpen(true); }}
                                        onDelete={() => handleDelete(row)}
                                        addedLabel={formatJobLinkTimestamp(row.created_at)}
                                    />
                                );
                            })
                        )}
                    </div>
                </div>
            </AppPage>

            <AddJobLinkModal
                open={showAdd}
                onOpenChange={setShowAdd}
                onCreated={() => {
                    // Reload from page 1 so the user sees their new row
                    // at the top of the list.
                    setPage(1);
                    load();
                }}
            />

            <AutoBidderDialog
                open={autoBidderOpen}
                onOpenChange={setAutoBidderOpen}
                isAdmin={isAdminPath}
                selectedLinks={rows
                    .filter((r) => selectedIds.has(r.id))
                    .map((r) => ({
                        id: r.id,
                        company_name: r.company_name,
                        position_title: r.position_title,
                        job_url: primaryJobUrl(r),
                        job_apply_url: r.job_apply_url,
                        source_url: r.source_url,
                        available_profiles: r.available_profiles || []
                    }))}
            />

            {/*
                View-detail modal. Reads the row out of `viewRow` and
                stays open until the user clicks Close. We update
                `viewRow` in place when the user toggles availability
                inside the modal so the badge reflects the new state
                without a refetch.
            */}
            <JobLinkDetailModal
                row={viewRow}
                open={viewOpen}
                onOpenChange={(o) => { setViewOpen(o); if (!o) setViewRow(null); }}
                onAvailabilityToggled={async (target) => {
                    await handleToggleAvailable(target);
                    // Update the local row in the modal so the
                    // badge flips immediately; the table state
                    // is already updated by handleToggleAvailable.
                    setViewRow((cur) => (cur && cur.id === target.id
                        ? { ...cur, is_available: target.is_available ? 0 : 1 }
                        : cur));
                }}
            />
            <EditJobLinkModal
                row={editRow}
                open={editOpen}
                onOpenChange={(o) => { setEditOpen(o); if (!o) setEditRow(null); }}
                onSaved={(updated) => {
                    handleEditSaved(updated);
                    // Keep the view modal in sync if it's open on the
                    // same row, so opening view after edit shows the
                    // fresh values.
                    setViewRow((cur) => (cur && cur.id === updated.id ? updated : cur));
                }}
            />

            {/* Bulk URL copy dialog. Renders a multi-line
                text area listing every selected row's URL in
                the user-chosen format, plus a "Copy all" button.
                The text area is read-only so the user can grab
                the content with Ctrl+A / Ctrl+C as a fallback if
                the clipboard API is blocked. */}
            <BulkCopyDialog
                open={bulkCopyOpen}
                onOpenChange={setBulkCopyOpen}
                rows={rows.filter((r) => selectedIds.has(r.id))}
                onCopied={() => setBulkCopied(true)}
            />
        </>
    );
}

// ---------------------------------------------------------------------
// Bulk URL copy dialog — one Job URL per selected row.
// ---------------------------------------------------------------------
function BulkCopyDialog({ open, onOpenChange, rows, onCopied }) {
    const [separator, setSeparator] = useState('\n');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (open) setCopied(false);
    }, [open]);

    const compose = useMemo(() => {
        if (!rows || rows.length === 0) return '';
        const lines = [];
        for (const r of rows) {
            const url = primaryJobUrl(r);
            if (url) lines.push(url);
        }
        return lines.join(separator);
    }, [rows, separator]);

    const handleCopy = async () => {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(compose);
            } else {
                const ta = document.createElement('textarea');
                ta.value = compose;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopied(true);
            onCopied?.();
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Bulk copy failed:', err);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Copy job URLs ({rows.length} row{rows.length === 1 ? '' : 's'})</DialogTitle>
                    <DialogDescription>
                        One Job URL per selected row.
                    </DialogDescription>
                </DialogHeader>
                <DialogBody>
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Label className="text-xs">Separator</Label>
                            <Select value={separator} onValueChange={setSeparator}>
                                <SelectTrigger className="h-8 w-32">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={'\n'}>Newline</SelectItem>
                                    <SelectItem value=",">Comma</SelectItem>
                                    <SelectItem value=" ">Space</SelectItem>
                                    <SelectItem value="|">Pipe</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <Textarea
                            readOnly
                            value={compose}
                            className="min-h-[200px] font-mono text-xs"
                            onClick={(e) => e.target.select()}
                        />
                    </div>
                </DialogBody>
                <DialogFooter className="gap-2">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Close
                    </Button>
                    <Button onClick={handleCopy} disabled={!compose}>
                        {copied ? (
                            <>
                                <CheckSquare className="mr-1 h-4 w-4" /> Copied
                            </>
                        ) : (
                            <>
                                <Copy className="mr-1 h-4 w-4" /> Copy
                            </>
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default JobLinks;
