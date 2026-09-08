// =============================================================================
// Developers (admin) — roster + skills search
// =============================================================================
// Admins use this page to see which developers are available, what
// skills / contact info they have on file, and to download each
// developer's resume. Each card has an "Edit" button that opens
// a modal letting the admin override the developer's profile fields
// (technical_skills, availability, contact_email/whatsapp/phone/
// telegram). The resume file is intentionally NOT editable here —
// it's owned by the dedicated upload endpoint so the old file can
// be cleaned up from disk atomically. The developer is still the
// source of truth for their own profile; the admin edit is for
// escalations (typo'd telegram handle, departed dev, etc.).
//
// Search is a single text input that hits the server's `q` query
// parameter, doing case-insensitive LIKE matches across username,
// technical_skills, availability, and every contact channel. Empty
// query returns the full roster.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Briefcase,
    Check,
    Download,
    FileText,
    Mail,
    MessageCircle,
    Pencil,
    Phone,
    RefreshCw,
    Save,
    Search,
    User as UserIcon,
    X
} from 'lucide-react';
import { adminAPI } from '@/api';
import { PageLoader, Loader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import FilterChip from '@/components/FilterChip';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogBody,
    DialogFooter
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

// Pull a comma / newline / bullet separated string into a list of
// trimmed tokens so we can render each skill as its own pill. The
// developer types free-form text on their profile; we don't impose a
// canonical skill schema, so a forgiving parser is the right call.
function parseSkills(raw) {
    if (!raw) return [];
    return String(raw)
        .split(/[,\n;•|·]/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

function ContactCell({ value, Icon, href, label }) {
    if (!value) {
        return <span className="text-xs text-muted-foreground">—</span>;
    }
    const content = (
        <span className="inline-flex items-center gap-1 text-xs">
            <Icon className="h-3 w-3 text-muted-foreground" />
            {href ? (
                <a href={href} className="hover:underline text-foreground/90" target="_blank" rel="noreferrer">
                    {value}
                </a>
            ) : (
                <span className="text-foreground/90">{value}</span>
            )}
        </span>
    );
    return (
        <div title={label || value}>
            {content}
        </div>
    );
}

function Developers() {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const [q, setQ] = useState('');
    // Edit modal — `editing` holds the row currently being edited
    // (null when the modal is closed). The form state lives inside
    // the modal so every open/close starts with a fresh draft.
    const [editing, setEditing] = useState(null);
    const [editSaving, setEditSaving] = useState(false);
    const [editError, setEditError] = useState(null);
    // Resume upload state — kept separate from the form-save state
    // so a 100KB markdown upload doesn't block the Save button.
    const [resumeBusy, setResumeBusy] = useState(false);
    const [resumeError, setResumeError] = useState(null);
    // Debounce the server-side search so we don't fire a request per
    // keystroke — the LIKE query is fine perf-wise but the round-trip
    // latency adds up on slow links.
    const [debouncedQ, setDebouncedQ] = useState('');
    useEffect(() => {
        const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
        return () => clearTimeout(t);
    }, [q]);

    const load = useCallback(async (params = {}) => {
        try {
            if (params.silent) setRefreshing(true); else setLoading(true);
            setError(null);
            const res = await adminAPI.listDeveloperProfiles(params.q ?? debouncedQ);
            setRows(Array.isArray(res.data) ? res.data : []);
        } catch (err) {
            console.error('Load developers error:', err);
            setError(err.response?.data?.error || 'Failed to load developers');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [debouncedQ]);

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedQ]);

    // Client-side breakdown of who's filled out their profile. Useful
    // KPI summary so the admin can see "how complete is my roster?"
    // at a glance.
    const stats = useMemo(() => {
        let withEmail = 0;
        let withTelegram = 0;
        let withSkills = 0;
        let withResume = 0;
        for (const r of rows) {
            if (r.contact_email) withEmail += 1;
            if (r.contact_telegram) withTelegram += 1;
            if (parseSkills(r.technical_skills).length > 0) withSkills += 1;
            if (r.developer_resume) withResume += 1;
        }
        return { total: rows.length, withEmail, withTelegram, withSkills, withResume };
    }, [rows]);

    return (
        <AppPage
            icon={UserIcon}
            title="Developers"
            description="Browse every developer account with skills, availability, and contact channels."
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                            <Input
                                className="h-10 border-white/10 bg-black/25 pl-10"
                                placeholder="Search by username, skill, availability, or contact…"
                                value={q}
                                onChange={(e) => setQ(e.target.value)}
                            />
                        </div>
                    )}
                    actions={(
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-10"
                            onClick={() => load({ silent: true })}
                            disabled={refreshing}
                        >
                            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                    chips={q ? (
                        <FilterChip label={`Search: ${q}`} onClear={() => setQ('')} />
                    ) : null}
                />

                {error && (
                    <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                        {error}
                    </div>
                )}

                {/* Profile-completion KPIs */}
                <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                    <KpiTile label="Total" value={stats.total} Icon={UserIcon} />
                    <KpiTile
                        label="With email"
                        value={`${stats.withEmail}/${stats.total}`}
                        accent={stats.withEmail === stats.total ? 'emerald' : 'amber'}
                    />
                    <KpiTile
                        label="With telegram"
                        value={`${stats.withTelegram}/${stats.total}`}
                        accent={stats.withTelegram === stats.total ? 'emerald' : 'amber'}
                    />
                    <KpiTile
                        label="With skills"
                        value={`${stats.withSkills}/${stats.total}`}
                        accent={stats.withSkills === stats.total ? 'emerald' : 'amber'}
                    />
                    <KpiTile
                        label="With resume"
                        value={`${stats.withResume}/${stats.total}`}
                        accent={stats.withResume === stats.total ? 'emerald' : 'amber'}
                    />
                </div>

                <ListToolbar
                    label={
                        q !== debouncedQ
                            ? 'Updating search…'
                            : `${rows.length} developer${rows.length === 1 ? '' : 's'}`
                    }
                />

                {loading ? (
                    <PageLoader message="Loading developers..." />
                ) : rows.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                        <UserIcon className="mx-auto mb-3 h-10 w-10 text-white/25" />
                        <p className="font-medium text-white/70">
                            {q ? 'No developers match this search.' : 'No developer accounts yet.'}
                        </p>
                        <p className="mt-1 text-xs text-white/40">
                            Developers appear here once an admin assigns them the developer role from User Management.
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {rows.map((r) => (
                            <DeveloperCard
                                key={r.id}
                                row={r}
                                onEdit={() => {
                                    setEditError(null);
                                    setEditing(r);
                                }}
                            />
                        ))}
                    </div>
                )}

                <EditDeveloperModal
                    row={editing}
                    onOpenChange={(open) => {
                        if (!open) {
                            setEditing(null);
                            setResumeError(null);
                        }
                    }}
                    saving={editSaving}
                    error={editError}
                    resumeBusy={resumeBusy}
                    resumeError={resumeError}
                    currentResume={editing ? rows.find((r) => r.id === editing.id)?.developer_resume : null}
                    onSave={async (payload) => {
                        if (!editing) return;
                        setEditSaving(true);
                        setEditError(null);
                        try {
                            const res = await adminAPI.updateDeveloperProfile(editing.id, payload);
                            setRows((prev) =>
                                prev.map((r) => (r.id === editing.id ? { ...r, ...(res.data || {}) } : r))
                            );
                            setEditing(null);
                        } catch (err) {
                            setEditError(err.response?.data?.error || 'Failed to save profile');
                        } finally {
                            setEditSaving(false);
                        }
                    }}
                    onUploadResume={async (filename, content) => {
                        if (!editing) return;
                        setResumeBusy(true);
                        setResumeError(null);
                        try {
                            const res = await adminAPI.uploadDeveloperResume(editing.id, filename, content);
                            const newFilename = res?.data?.filename;
                            if (newFilename) {
                                setRows((prev) =>
                                    prev.map((r) => (r.id === editing.id ? { ...r, developer_resume: newFilename } : r))
                                );
                            }
                        } catch (err) {
                            setResumeError(err.response?.data?.error || 'Failed to upload resume');
                        } finally {
                            setResumeBusy(false);
                        }
                    }}
                />
            </div>
        </AppPage>
    );
}

// Card layout per developer — easier to scan the profile fields than
// cramming them into a row. Skill pills are derived client-side from
// the free-form `technical_skills` text. The Edit button opens the
// admin override modal so the admin can fix typos / departed devs
// without waiting for the developer to log in.
function DeveloperCard({ row, onEdit }) {
    const skills = parseSkills(row.technical_skills);
    return (
        <article
            className={cn(
                'flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4',
                'transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)] hover:shadow-lg hover:shadow-primary/10'
            )}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                        <UserIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                        <p className="truncate text-base font-semibold tracking-tight">{row.username}</p>
                        <p className="text-xs text-white/40">
                            Joined {row.created_at ? new Date(row.created_at).toLocaleDateString() : '—'}
                        </p>
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {row.role === 'developer' && (
                        <Badge variant="secondary" className="text-[10px]">developer</Badge>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={onEdit}
                        aria-label={`Edit ${row.username}'s profile`}
                        title="Edit profile"
                    >
                        <Pencil className="h-3.5 w-3.5" />
                    </Button>
                </div>
            </div>

            <div className="mt-4 space-y-3 text-xs">
                <div>
                    <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-white/45">
                        <Briefcase className="h-3 w-3" />
                        Technical skills
                    </div>
                    {skills.length === 0 ? (
                        <p className="italic text-white/35">No skills listed yet.</p>
                    ) : (
                        <div className="flex flex-wrap gap-1">
                            {skills.map((s, i) => (
                                <Badge key={i} variant="secondary" className="font-normal">
                                    {s}
                                </Badge>
                            ))}
                        </div>
                    )}
                </div>

                <div>
                    <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-white/45">
                        <MessageCircle className="h-3 w-3" />
                        Availability
                    </div>
                    <p className={cn(
                        'whitespace-pre-wrap text-white/80',
                        !row.availability && 'italic text-white/35'
                    )}>
                        {row.availability || 'Not specified.'}
                    </p>
                </div>

                <div>
                    <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium text-white/45">
                        <Mail className="h-3 w-3" />
                        Contact
                    </div>
                    <div className="space-y-1">
                        <ContactCell
                            value={row.contact_email}
                            Icon={Mail}
                            href={row.contact_email ? `mailto:${row.contact_email}` : null}
                            label="Email"
                        />
                        <ContactCell
                            value={row.contact_telegram}
                            Icon={MessageCircle}
                            href={row.contact_telegram ? `https://t.me/${String(row.contact_telegram).replace(/^@/, '')}` : null}
                            label="Telegram"
                        />
                        <ContactCell value={row.contact_whatsapp} Icon={MessageCircle} label="WhatsApp" />
                        <ContactCell value={row.contact_phone} Icon={Phone} label="Phone" />
                    </div>
                </div>

                <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
                    <div className="flex items-center gap-1 text-[11px] font-medium text-white/45">
                        <FileText className="h-3 w-3" />
                        Resume
                    </div>
                    {row.developer_resume ? (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => window.open(`/resumes/${row.developer_resume}`, '_blank')}
                        >
                            <Download className="h-3 w-3" />
                            Open
                        </Button>
                    ) : (
                        <span className="italic text-white/35">Not uploaded</span>
                    )}
                </div>
            </div>
        </article>
    );
}

// Admin override of the developer profile editor. Mirrors the
// developer-self-edit form at /developer/profile but is scoped to
// a single target user (the row passed in via `row`). Email +
// Telegram are required server-side, so the form mirrors the
// validation with inline error labels so the admin gets immediate
// feedback before submitting.
//
// The modal keeps its own draft state so closing + reopening
// always starts from the latest server values, not from a stale
// in-progress edit.
function EditDeveloperModal({
    row,
    onOpenChange,
    onSave,
    onUploadResume,
    saving,
    resumeBusy,
    resumeError,
    currentResume,
    error
}) {
    const [draft, setDraft] = useState(null);
    const fileInputRef = useRef(null);

    // Reset the draft whenever the target row changes. We pull
    // the editable fields from the row and store them verbatim —
    // null means "empty" in the API.
    useEffect(() => {
        if (!row) {
            setDraft(null);
            return;
        }
        setDraft({
            technical_skills: row.technical_skills || '',
            availability: row.availability || '',
            contact_email: row.contact_email || '',
            contact_whatsapp: row.contact_whatsapp || '',
            contact_phone: row.contact_phone || '',
            contact_telegram: row.contact_telegram || ''
        });
    }, [row]);

    const emailMissing = !String(draft?.contact_email || '').trim();
    const telegramMissing = !String(draft?.contact_telegram || '').trim();
    const canSave = Boolean(draft) && !emailMissing && !telegramMissing && !saving;

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!canSave || !draft) return;
        // Mirror the server's `trimOrNull` semantics so empty strings
        // become `null` on the wire (the server enforces this too,
        // but doing it client-side keeps the diff readable).
        const trimOrNull = (v) => {
            const t = String(v || '').trim();
            return t === '' ? null : t;
        };
        onSave({
            technical_skills: trimOrNull(draft.technical_skills),
            availability: trimOrNull(draft.availability),
            contact_email: trimOrNull(draft.contact_email),
            contact_whatsapp: trimOrNull(draft.contact_whatsapp),
            contact_phone: trimOrNull(draft.contact_phone),
            contact_telegram: trimOrNull(draft.contact_telegram)
        });
    };

    // Resume upload — reads the file as text and delegates to the
    // parent's onUploadResume handler. The server renames the file to
    // `dev_${id}_${ts}_${safe}` and unlinks the previous file. The
    // accept list matches the developer-self-edit endpoint so admins
    // can upload the same formats the developer can.
    const handleResumePick = (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!/\.(md|markdown|txt)$/i.test(file.name)) {
            // Reset the input so picking the same file again still fires
            // a change event.
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        file.text().then((content) => {
            onUploadResume?.(file.name, content);
        }).catch(() => {
            if (fileInputRef.current) fileInputRef.current.value = '';
        });
        // Reset the input after the upload completes so the same
        // file can be re-picked if needed.
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    return (
        <Dialog open={!!row} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Pencil className="h-4 w-4" />
                        Edit developer profile
                    </DialogTitle>
                    <DialogDescription>
                        Override the profile fields for{' '}
                        <span className="font-semibold text-foreground">{row?.username}</span>.
                        The developer is still the source of truth for their own profile — use
                        this for escalations (typo'd contact, departed dev, etc.).
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
                    <DialogBody className="space-y-4">
                        {error && (
                            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                                {error}
                            </div>
                        )}

                        {draft && (
                            <>
                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                    <div className="space-y-1.5 md:col-span-2">
                                        <Label htmlFor="technical_skills">Technical skills</Label>
                                        <Textarea
                                            id="technical_skills"
                                            rows={3}
                                            value={draft.technical_skills}
                                            onChange={(e) => setDraft({ ...draft, technical_skills: e.target.value })}
                                            placeholder="e.g. React, Node.js, Python, AWS"
                                        />
                                    </div>

                                    <div className="space-y-1.5 md:col-span-2">
                                        <Label htmlFor="availability">Availability</Label>
                                        <Textarea
                                            id="availability"
                                            rows={2}
                                            value={draft.availability}
                                            onChange={(e) => setDraft({ ...draft, availability: e.target.value })}
                                            placeholder="e.g. Mon-Fri 9-5 EST"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="contact_email">
                                            Email <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            id="contact_email"
                                            type="email"
                                            value={draft.contact_email}
                                            onChange={(e) => setDraft({ ...draft, contact_email: e.target.value })}
                                            placeholder="developer@example.com"
                                            className={emailMissing ? 'border-destructive/60' : ''}
                                        />
                                        {emailMissing && (
                                            <p className="text-[10px] text-destructive">Email is required.</p>
                                        )}
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="contact_telegram">
                                            Telegram <span className="text-destructive">*</span>
                                        </Label>
                                        <Input
                                            id="contact_telegram"
                                            value={draft.contact_telegram}
                                            onChange={(e) => setDraft({ ...draft, contact_telegram: e.target.value })}
                                            placeholder="@handle"
                                            className={telegramMissing ? 'border-destructive/60' : ''}
                                        />
                                        {telegramMissing && (
                                            <p className="text-[10px] text-destructive">Telegram handle is required.</p>
                                        )}
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="contact_whatsapp">WhatsApp</Label>
                                        <Input
                                            id="contact_whatsapp"
                                            value={draft.contact_whatsapp}
                                            onChange={(e) => setDraft({ ...draft, contact_whatsapp: e.target.value })}
                                            placeholder="+1 555-1234"
                                        />
                                    </div>

                                    <div className="space-y-1.5">
                                        <Label htmlFor="contact_phone">Phone</Label>
                                        <Input
                                            id="contact_phone"
                                            value={draft.contact_phone}
                                            onChange={(e) => setDraft({ ...draft, contact_phone: e.target.value })}
                                            placeholder="+1 555-1234"
                                        />
                                    </div>
                                </div>

                                {/* Resume upload — mirrors the
                                    developer-self-edit form. The
                                    server accepts .md / .markdown /
                                    .txt, sanitizes the filename, and
                                    unlinks the previous file. The
                                    `currentResume` prop drives the
                                    "Currently on file" link so the
                                    admin can download the existing
                                    resume before swapping it. */}
                                <div className="space-y-1.5">
                                    <Label>Resume</Label>
                                    <div className="rounded-md border border-dashed border-border bg-muted/30 p-3">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="min-w-0">
                                                <div className="text-xs font-medium text-foreground/90">
                                                    {currentResume ? (
                                                        <span className="inline-flex items-center gap-1">
                                                            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                                            {currentResume}
                                                        </span>
                                                    ) : (
                                                        <span className="italic text-muted-foreground">No resume uploaded yet.</span>
                                                    )}
                                                </div>
                                                {currentResume && (
                                                    <button
                                                        type="button"
                                                        onClick={() => window.open(`/resumes/${currentResume}`, '_blank')}
                                                        className="mt-0.5 text-[11px] text-primary hover:underline"
                                                    >
                                                        Download current resume
                                                    </button>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    accept=".md,.markdown,.txt,text/markdown,text/plain"
                                                    onChange={handleResumePick}
                                                    disabled={resumeBusy}
                                                    className="hidden"
                                                />
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={resumeBusy}
                                                    onClick={() => fileInputRef.current?.click()}
                                                >
                                                    {resumeBusy ? (
                                                        <>
                                                            <Loader size="sm" />
                                                            Uploading…
                                                        </>
                                                    ) : (
                                                        <>
                                                            <FileText className="h-3.5 w-3.5" />
                                                            {currentResume ? 'Replace resume' : 'Upload resume'}
                                                        </>
                                                    )}
                                                </Button>
                                            </div>
                                        </div>
                                        {resumeError && (
                                            <p className="mt-2 text-[10px] text-destructive">{resumeError}</p>
                                        )}
                                        <p className="mt-1 text-[10px] text-muted-foreground">
                                            Accepts .md, .markdown, or .txt files. The previous file is removed from disk when you upload a new one.
                                        </p>
                                    </div>
                                </div>
                            </>
                        )}
                    </DialogBody>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            onClick={() => onOpenChange(false)}
                            disabled={saving}
                        >
                            <X className="h-3.5 w-3.5" />
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!canSave}>
                            {saving ? (
                                <>
                                    <Loader size="sm" />
                                    Saving…
                                </>
                            ) : (
                                <>
                                    <Save className="h-3.5 w-3.5" />
                                    Save changes
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function KpiTile({ label, value, Icon, accent }) {
    const accentMap = {
        emerald: 'border-emerald-500/30 text-emerald-300',
        amber:   'border-amber-500/30 text-amber-300'
    };
    const cls = accent ? accentMap[accent] : 'border-white/[0.07] text-white';
    return (
        <div className={cn('rounded-2xl border bg-[hsl(222_24%_9%/0.75)] p-3 backdrop-blur-sm', cls)}>
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-white/45">{label}</span>
                {Icon && <Icon className="h-4 w-4 opacity-70" />}
            </div>
            <div className="mt-1 text-lg font-semibold">{value}</div>
        </div>
    );
}

export default Developers;
