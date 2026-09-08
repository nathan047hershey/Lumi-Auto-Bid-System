import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import {
    FileText,
    FileCheck2,
    FileX,
    Upload,
    Trash2,
    Download,
    Loader2,
    CheckCircle2,
    AlertCircle,
    Sparkles,
    X,
    ChevronDown,
    ChevronRight,
    UserPlus,
    Mail,
    Phone,
    MapPin,
    Briefcase,
    GraduationCap,
    RefreshCw as RefreshIcon,
    Eye
} from 'lucide-react';
import { adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// =============================================================================
// Admin Resume Templates page
// =============================================================================
// Lets an admin upload a DOCX template (the parser on the server figures out
// section ordering, heading sizes, borders, bullet characters, alignment, and
// font), then list / inspect / delete uploaded templates. The built-in default
// template is always present and cannot be deleted.
// =============================================================================

function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`;
}

function AdminResumeTemplates() {
    const [templates, setTemplates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [deletingId, setDeletingId] = useState(null);
    // Per-row UI state: which template has its extracted-data panel
    // expanded, and which template currently has a re-extract or apply
    // operation in flight.
    const [expandedId, setExpandedId] = useState(null);
    const [reExtractingId, setReExtractingId] = useState(null);
    const [applyingId, setApplyingId] = useState(null);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);
    const fileInputRef = useRef(null);

    // Form state for the upload card
    const [pendingFile, setPendingFile] = useState(null);
    const [formName, setFormName] = useState('');
    const [formDescription, setFormDescription] = useState('');
    // Drag-and-drop UI state. `dragActive` flips true while a file is being
    // dragged over the drop zone so we can highlight it; `dragCounter` is a
    // small trick to avoid flicker when the cursor crosses child elements.
    const [dragActive, setDragActive] = useState(false);
    const [fileError, setFileError] = useState(null);
    const dragCounter = useRef(0);

    // ----- Template preview state -----
    // `previewingId` is the template currently open in the modal.
    // `previewHtml` is the rendered source-DOCX HTML (mammoth output
    // plus parser slot-aware CSS) that we feed to the iframe via
    // `srcDoc`. `previewPdfUrl` is a blob URL kept around for the
    // "Download as PDF" link, and `previewUrl` is kept as a backwards
    // compatibility alias for older rendering paths.
    const [previewingId, setPreviewingId] = useState(null);
    const [previewHtml, setPreviewHtml] = useState(null);
    const [previewUrl, setPreviewUrl] = useState(null);
    const [previewPdfUrl, setPreviewPdfUrl] = useState(null);
    const [previewingError, setPreviewingError] = useState(null);
    const [previewing, setPreviewing] = useState(false);

    // Maximum accepted upload size (10 MB). The server stores templates as
    // base64 inside a JSON body, so anything beyond ~10MB starts to push
    // Express's default body limit; we cap it client-side too for nicer UX.
    const MAX_BYTES = 10 * 1024 * 1024;

    // Validate + accept a file from any source (drop, picker, keyboard).
    const acceptFile = useCallback((file) => {
        setFileError(null);
        if (!file) return;
        if (!/\.docx$/i.test(file.name)) {
            setFileError('Only .docx files are supported.');
            return;
        }
        if (file.size > MAX_BYTES) {
            setFileError(`File is too large (${formatBytes(file.size)}). Maximum is ${formatBytes(MAX_BYTES)}.`);
            return;
        }
        setPendingFile(file);
        // Auto-fill the name from the filename when the form is still empty.
        setFormName((cur) => cur || file.name.replace(/\.docx$/i, ''));
    }, []);

    const clearPendingFile = useCallback(() => {
        setPendingFile(null);
        setFileError(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    }, []);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const { data } = await adminAPI.listTemplates();
            setTemplates(Array.isArray(data?.templates) ? data.templates : []);
        } catch (err) {
            console.error('Failed to load templates:', err);
            const status = err.response?.status;
            const serverMsg = err.response?.data?.error;
            // A 404 here used to mean "endpoint missing" (old build), but
            // now that the routes are live the only realistic 404 is for
            // an individual template id — which the GET-list call cannot
            // produce. Anything that fails to reach the list endpoint is a
            // genuine outage and we want to surface that distinctly from the
            // empty-list state.
            setError(
                serverMsg
                    || (status === 401 || status === 403
                        ? 'You are not signed in as an admin.'
                        : 'Failed to load templates. The server may be down or this build may be out of date — try restarting the backend.')
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Drag handlers. The counter trick handles the fact that `dragenter`/
    // `dragleave` fire for every child element you traverse — without it
    // the highlight flickers the moment the cursor crosses a child.
    const onDragEnter = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current += 1;
        if (e.dataTransfer?.types?.includes('Files')) {
            setDragActive(true);
        }
    };
    const onDragLeave = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setDragActive(false);
    };
    const onDragOver = (e) => {
        // Required so the drop event actually fires.
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current = 0;
        setDragActive(false);
        const file = e.dataTransfer?.files?.[0];
        if (file) acceptFile(file);
    };

    const handleFileSelected = (file) => {
        acceptFile(file);
    };

    const handleUpload = async () => {
        if (!pendingFile) {
            setError('Pick a .docx file first');
            return;
        }
        try {
            setUploading(true);
            setError(null);
            setFileError(null);
            setSuccess(null);
            const { data } = await adminAPI.uploadTemplate(pendingFile, {
                name: formName.trim() || pendingFile.name.replace(/\.docx$/i, ''),
                description: formDescription.trim()
            });
            setSuccess(`Template "${data?.template?.name || 'new'}" uploaded. The parser extracted its layout — it's now available in the user picker.`);
            setPendingFile(null);
            setFormName('');
            setFormDescription('');
            if (fileInputRef.current) fileInputRef.current.value = '';
            await load();
            setTimeout(() => setSuccess(null), 5000);
        } catch (err) {
            console.error('Upload failed:', err);
            setError(err.response?.data?.error || err.message || 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (tpl) => {
        if (!window.confirm(`Delete template "${tpl.name}"? This cannot be undone.`)) return;
        try {
            setDeletingId(tpl.id);
            setError(null);
            await adminAPI.deleteTemplate(tpl.id);
            setSuccess(`Template "${tpl.name}" deleted.`);
            await load();
            setTimeout(() => setSuccess(null), 4000);
        } catch (err) {
            console.error('Delete failed:', err);
            setError(err.response?.data?.error || err.message || 'Delete failed');
        } finally {
            setDeletingId(null);
        }
    };

    const handleDownload = async (tpl) => {
        try {
            const res = await adminAPI.downloadTemplate(tpl.id);
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a');
            a.href = url;
            a.download = tpl.filename || `${tpl.name}.docx`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Download failed:', err);
            setError(err.response?.data?.error || err.message || 'Download failed');
        }
    };

    // Re-run the content extractor on the on-disk DOCX. Useful when an
    // admin edited the template's file manually or just wants fresh data.
    const handleReExtract = async (tpl) => {
        try {
            setReExtractingId(tpl.id);
            setError(null);
            setSuccess(null);
            const { data } = await adminAPI.reExtractTemplate(tpl.id);
            setSuccess(`Re-extracted candidate data from "${data?.template?.name || tpl.name}".`);
            await load();
            setTimeout(() => setSuccess(null), 4000);
        } catch (err) {
            console.error('Re-extract failed:', err);
            setError(err.response?.data?.error || err.message || 'Re-extract failed');
        } finally {
            setReExtractingId(null);
        }
    };

    // Apply the extracted candidate data to a new (or existing linked)
    // candidate_profiles row. The server returns the new profile so the
    // admin can verify the result.
    const handleApply = async (tpl) => {
        try {
            setApplyingId(tpl.id);
            setError(null);
            setSuccess(null);
            const { data } = await adminAPI.applyTemplate(tpl.id);
            const created = data?.created;
            const profileName = [data?.profile?.first_name, data?.profile?.last_name].filter(Boolean).join(' ');
            setSuccess(
                created
                    ? `Created candidate profile "${profileName || data?.profile?.id}" from "${tpl.name}".`
                    : `Updated candidate profile "${profileName || data?.profile?.id}" from "${tpl.name}".`
            );
            await load();
            setTimeout(() => setSuccess(null), 5000);
        } catch (err) {
            console.error('Apply failed:', err);
            setError(err.response?.data?.error || err.message || 'Apply failed');
        } finally {
            setApplyingId(null);
        }
    };

    // Render the **source DOCX** of the template as HTML and open the
    // preview modal showing it. The server routes mammoth over the
    // actual file the admin uploaded, so what they see is the
    // genuine rendering of the template (not a reconstruction).
    //
    // We store the rendered HTML string in state and inject it via
    // `srcDoc` on an iframe, which keeps the modal sandboxed and
    // avoids the document interfering with the surrounding admin
    // page's CSS. We also keep `previewTemplate` (the PDF variant)
    // available for the "Download as PDF" link inside the modal.
    const handlePreview = async (tpl) => {
        // Reset state for the new preview.
        setPreviewHtml(null);
        setPreviewUrl(null);
        setPreviewPdfUrl(null);
        setPreviewingError(null);
        setPreviewing(true);
        setPreviewingId(tpl.id);
        try {
            // Ask the server for the rendered HTML. The endpoint returns
            // `text/html`; axios returns the raw string in `data`.
            const { data } = await adminAPI.previewTemplateHtml(tpl.id);
            if (typeof data !== 'string') {
                throw new Error('Preview server returned an unexpected payload (not HTML).');
            }
            setPreviewHtml(data);
        } catch (err) {
            console.error('Preview failed:', err);
            const msg = err.response?.data?.error || err.message || 'Preview failed';
            setPreviewingError(msg);
        } finally {
            setPreviewing(false);
        }

        // Fetch the PDF in parallel for the "Download" link. We don't
        // await; the iframe renders first and the download link
        // materialises a moment later.
        try {
            const { data: pdfBlob } = await adminAPI.previewTemplate(tpl.id);
            const blob = pdfBlob instanceof Blob
                ? pdfBlob
                : new Blob([pdfBlob], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            setPreviewPdfUrl(url);
        } catch (err) {
            // PDF download is optional; ignore failures.
            console.warn('PDF preview not available:', err);
        }
    };

    // Close the preview modal. Revokes any blob URLs and clears all
    // associated state so the next open starts fresh.
    const handleClosePreview = () => {
        if (previewUrl) {
            try { URL.revokeObjectURL(previewUrl); } catch (_) { /* noop */ }
        }
        if (previewPdfUrl) {
            try { URL.revokeObjectURL(previewPdfUrl); } catch (_) { /* noop */ }
        }
        setPreviewUrl(null);
        setPreviewPdfUrl(null);
        setPreviewHtml(null);
        setPreviewingId(null);
        setPreviewingError(null);
    };

    return (
        <AppPage
            icon={FileText}
            title="Resume Templates"
            description="Upload DOCX templates. The system parses layout, headings, fonts, alignment, and bullet style for resume generation."
        >
            <div className="space-y-4">
                <PageCommandBar
                    actions={(
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-10"
                            onClick={load}
                            disabled={loading}
                        >
                            {loading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <RefreshIcon className="h-4 w-4" />
                            )}
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                />

                {error && (
                    <div
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                        role="alert"
                    >
                        <span className="inline-flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            {error}
                        </span>
                        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
                            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Retry'}
                        </Button>
                    </div>
                )}
                {success && (
                    <div
                        className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300"
                        role="status"
                    >
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        {success}
                    </div>
                )}

                <section
                    className={cn(
                        'overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4 sm:p-5',
                        'shadow-[0_16px_48px_-28px_rgba(0,0,0,0.65)]'
                    )}
                >
                    <div className="mb-4">
                        <h2 className="text-base font-semibold tracking-tight">Upload Template</h2>
                        <p className="mt-0.5 text-sm text-white/40">
                            Pick a .docx file. Layout, headings, fonts, alignment, and bullet characters are parsed automatically.
                        </p>
                    </div>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor="tpl-file">DOCX file</Label>
                            <div
                                role="button"
                                tabIndex={0}
                                aria-label="Drop a DOCX file here, or click to browse"
                                onClick={() => fileInputRef.current?.click()}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        fileInputRef.current?.click();
                                    }
                                }}
                                onDragEnter={onDragEnter}
                                onDragLeave={onDragLeave}
                                onDragOver={onDragOver}
                                onDrop={onDrop}
                                data-drag-active={dragActive || undefined}
                                className="template-dropzone"
                            >
                                <input
                                    id="tpl-file"
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                    onChange={(e) => handleFileSelected(e.target.files?.[0])}
                                    disabled={uploading}
                                    className="sr-only"
                                />
                                {pendingFile ? (
                                    <div className="template-dropzone-inner">
                                        <FileCheck2 className="h-8 w-8" style={{ color: 'var(--success)' }} />
                                        <div className="template-dropzone-text">
                                            <strong>{pendingFile.name}</strong>
                                            <span className="template-dropzone-meta">
                                                {formatBytes(pendingFile.size)} • ready to upload
                                            </span>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                clearPendingFile();
                                            }}
                                            disabled={uploading}
                                            className="template-dropzone-clear"
                                            aria-label="Remove selected file"
                                            title="Remove selected file"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    </div>
                                ) : (
                                    <div className="template-dropzone-inner">
                                        <Upload className="h-8 w-8" style={{ color: dragActive ? 'var(--primary)' : 'var(--muted-foreground)' }} />
                                        <div className="template-dropzone-text">
                                            <strong>
                                                {dragActive ? 'Drop the .docx file here' : 'Drag & drop a .docx file here'}
                                            </strong>
                                            <span className="template-dropzone-meta">
                                                or click to browse · max {formatBytes(MAX_BYTES)}
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </div>
                            {fileError && (
                                <p className="template-dropzone-error" role="alert">
                                    <FileX className="h-4 w-4" />
                                    {fileError}
                                </p>
                            )}
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tpl-name">Name</Label>
                            <Input
                                id="tpl-name"
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                placeholder="e.g. Senior Engineer Classic"
                                disabled={uploading}
                                className="border-white/10 bg-black/25"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="tpl-desc">Description (optional)</Label>
                            <Textarea
                                id="tpl-desc"
                                value={formDescription}
                                onChange={(e) => setFormDescription(e.target.value)}
                                placeholder="Short note shown in the user-side picker."
                                rows={2}
                                disabled={uploading}
                                className="border-white/10 bg-black/25"
                            />
                        </div>
                        <Button onClick={handleUpload} disabled={!pendingFile || uploading}>
                            {uploading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Parsing template…
                                </>
                            ) : (
                                <>
                                    <Upload className="h-4 w-4" />
                                    Upload & Parse
                                </>
                            )}
                        </Button>
                    </div>
                </section>

                <ListToolbar
                    label={
                        loading
                            ? 'Loading templates…'
                            : `${templates.length} template${templates.length === 1 ? '' : 's'} · built-in Default always available`
                    }
                />

                {loading ? (
                    <div className="flex items-center gap-2 rounded-2xl border border-white/[0.07] bg-black/20 px-6 py-10 text-sm text-white/40">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading templates…
                    </div>
                ) : templates.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center">
                        <FileText className="mx-auto mb-3 h-10 w-10 text-white/25" />
                        <h3 className="text-base font-semibold text-white/80">No resume templates yet</h3>
                        <p className="mx-auto mt-1 max-w-md text-sm text-white/40">
                            Upload a .docx file above to add your first custom template.
                            The parser will read its layout, headings, fonts, alignment,
                            and bullet style automatically.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {templates.map((t) => (
                            <Fragment key={t.id}>
                                <article
                                    className={cn(
                                        'overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4',
                                        'transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)]'
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                {t.is_default ? (
                                                    <Sparkles className="h-4 w-4 text-primary" />
                                                ) : (
                                                    <FileText className="h-4 w-4 text-white/40" />
                                                )}
                                                <strong className="truncate text-base tracking-tight">{t.name}</strong>
                                                {t.is_default && (
                                                    <span className="rounded-md bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
                                                        Default
                                                    </span>
                                                )}
                                                <span className="text-xs text-white/35">
                                                    {formatBytes(t.file_size)} • {t.filename}
                                                </span>
                                            </div>
                                            {t.description && (
                                                <p className="mt-1 text-sm text-white/45">{t.description}</p>
                                            )}
                                            {t.style_spec && (
                                                <SpecSummary spec={t.style_spec} />
                                            )}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-2">
                                            {!t.is_default && (
                                                <Button
                                                    size="sm"
                                                    variant="secondary"
                                                    onClick={() => handleDownload(t)}
                                                    title="Download the original DOCX"
                                                >
                                                    <Download className="h-4 w-4" />
                                                </Button>
                                            )}
                                            {!t.is_default && (
                                                <Button
                                                    size="sm"
                                                    variant="destructive"
                                                    onClick={() => handleDelete(t)}
                                                    disabled={deletingId === t.id}
                                                    title="Delete this template"
                                                >
                                                    {deletingId === t.id ? (
                                                        <Loader2 className="h-4 w-4 animate-spin" />
                                                    ) : (
                                                        <Trash2 className="h-4 w-4" />
                                                    )}
                                                </Button>
                                            )}
                                        </div>
                                    </div>

                                    {!t.is_default && (
                                        <div className="mt-3 border-t border-white/[0.06] pt-3">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-8 px-0 text-white/45 hover:text-white/80"
                                                onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                                            >
                                                {expandedId === t.id ? (
                                                    <ChevronDown className="h-4 w-4" />
                                                ) : (
                                                    <ChevronRight className="h-4 w-4" />
                                                )}
                                                Extracted candidate data
                                                {t.extracted_data && (
                                                    <span className="ml-1 text-[10px] text-white/35">
                                                        ({summariseExtracted(t.extracted_data)})
                                                    </span>
                                                )}
                                                {t.extracted_data?.extraction_source && (
                                                    <span
                                                        title={
                                                            t.extracted_data.extraction_source.startsWith('ai:')
                                                                ? 'Sections detected with the active AI provider'
                                                                : 'Sections detected by the local regex pass only'
                                                        }
                                                        className={cn(
                                                            'ml-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
                                                            t.extracted_data.extraction_source.startsWith('ai:')
                                                                ? 'border border-sky-500/45 bg-sky-500/15 text-sky-200'
                                                                : 'border border-white/15 bg-white/5 text-white/50'
                                                        )}
                                                    >
                                                        {t.extracted_data.extraction_source.startsWith('ai:')
                                                            ? `AI · ${t.extracted_data.extraction_source.split(':')[1] || ''}`
                                                            : 'regex'}
                                                    </span>
                                                )}
                                            </Button>
                                            {expandedId === t.id && (
                                                <div className="mt-2 rounded-xl border border-white/[0.06] bg-black/20 p-3">
                                                    <ExtractedData data={t.extracted_data} />
                                                    <div className="mt-3 flex flex-wrap gap-2">
                                                        <Button
                                                            size="sm"
                                                            variant="secondary"
                                                            onClick={() => handleReExtract(t)}
                                                            disabled={reExtractingId === t.id}
                                                        >
                                                            {reExtractingId === t.id ? (
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <RefreshIcon className="h-4 w-4" />
                                                            )}
                                                            Re-extract
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="secondary"
                                                            onClick={() => handlePreview(t)}
                                                            disabled={previewing && previewingId === t.id}
                                                            title="Preview this template with mock candidate content"
                                                        >
                                                            {previewing && previewingId === t.id ? (
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <Eye className="h-4 w-4" />
                                                            )}
                                                            Preview
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            onClick={() => handleApply(t)}
                                                            disabled={
                                                                applyingId === t.id
                                                                || !t.extracted_data
                                                                || !hasMinimumForApply(t.extracted_data)
                                                            }
                                                            title={
                                                                !hasMinimumForApply(t.extracted_data)
                                                                    ? 'Need at least a name before you can apply this template'
                                                                    : t.candidate_profile_id
                                                                        ? 'Update the linked candidate profile'
                                                                        : 'Create a candidate profile from this template'
                                                            }
                                                        >
                                                            {applyingId === t.id ? (
                                                                <Loader2 className="h-4 w-4 animate-spin" />
                                                            ) : (
                                                                <UserPlus className="h-4 w-4" />
                                                            )}
                                                            {t.candidate_profile_id ? 'Update Profile' : 'Apply as Profile'}
                                                        </Button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </article>
                            </Fragment>
                        ))}
                    </div>
                )}

                <TemplatePreviewModal
                    previewHtml={previewHtml}
                    previewPdfUrl={previewPdfUrl}
                    loading={previewing && !!previewingId}
                    error={previewingError}
                    templateName={
                        previewingId
                            ? templates.find((x) => x.id === previewingId)?.name || 'Template'
                            : 'Template'
                    }
                    onClose={handleClosePreview}
                />
            </div>
        </AppPage>
    );
}

// Modal dialog showing the rendered source-template HTML. We embed the
// HTML via an iframe `srcDoc` so the modal stays sandboxed and the
// surrounding admin page's CSS doesn't leak into the preview. The
// "Download as PDF" link in the footer lets admins save a Word-faithful
// PDF if they need one.
function TemplatePreviewModal({ previewHtml, previewPdfUrl, loading, error, templateName, onClose }) {
    if (!loading && !previewHtml && !error) return null;
    const stopBackdropClick = (e) => e.stopPropagation();
    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0, 0, 0, 0.55)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 100
            }}
            role="dialog"
            aria-modal="true"
            aria-label={`${templateName} preview`}
        >
            <div
                onClick={stopBackdropClick}
                style={{
                    width: 'min(960px, 92vw)',
                    height: 'min(880px, 90vh)',
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 48px rgba(0,0,0,0.35)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden'
                }}
            >
                <div
                    style={{
                        padding: '0.85rem 1rem',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem'
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                        <Eye className="h-4 w-4 flex-shrink-0" />
                        <strong
                            style={{
                                fontSize: '0.95rem',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                            }}
                            title={templateName}
                        >
                            {templateName}
                        </strong>
                        <span
                            style={{
                                fontSize: '0.7rem',
                                color: 'var(--muted-foreground)',
                                whiteSpace: 'nowrap'
                            }}
                        >
                            · preview with mock content
                        </span>
                    </div>
                    <button
                        onClick={onClose}
                        aria-label="Close preview"
                        style={{
                            background: 'transparent',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            padding: '0.35rem 0.6rem',
                            cursor: 'pointer',
                            color: 'var(--foreground)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.3rem',
                            fontSize: '0.8rem'
                        }}
                    >
                        <X className="h-4 w-4" /> Close
                    </button>
                </div>

                <div style={{ flex: 1, position: 'relative', background: '#525659' }}>
                    {loading && (
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexDirection: 'column',
                                gap: '0.6rem',
                                color: '#fff',
                                zIndex: 2
                            }}
                        >
                            <Loader2 className="h-6 w-6 animate-spin" />
                            <span style={{ fontSize: '0.85rem' }}>Rendering mock resume…</span>
                        </div>
                    )}
                    {error && (
                        <div
                            style={{
                                position: 'absolute',
                                inset: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexDirection: 'column',
                                gap: '0.4rem',
                                color: '#fecaca',
                                padding: '1.5rem',
                                textAlign: 'center',
                                zIndex: 2
                            }}
                        >
                            <AlertCircle className="h-6 w-6" />
                            <strong style={{ fontSize: '0.95rem' }}>Preview failed</strong>
                            <span style={{ fontSize: '0.8rem', maxWidth: 480 }}>{error}</span>
                        </div>
                    )}
                    {previewHtml && (
                        <iframe
                            srcDoc={previewHtml}
                            title="Template preview"
                            sandbox="allow-same-origin"
                            style={{
                                width: '100%',
                                height: '100%',
                                border: 0,
                                background: '#fff'
                            }}
                        />
                    )}
                </div>

                <div
                    style={{
                        padding: '0.6rem 1rem',
                        borderTop: '1px solid var(--border)',
                        fontSize: '0.75rem',
                        color: 'var(--muted-foreground)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '1rem'
                    }}
                >
                    <span>
                        Rendered from the <strong>source DOCX</strong> you uploaded (mammoth + slot-aware CSS).
                    </span>
                    {previewPdfUrl && (
                        <a
                            href={previewPdfUrl}
                            download={`template_preview_${(templateName || 'template').replace(/\W+/g, '_')}.pdf`}
                            style={{ color: 'var(--primary)', textDecoration: 'underline' }}
                        >
                            Download PDF
                        </a>
                    )}
                </div>
            </div>
        </div>
    );
}

// Compact summary of what the parser extracted. Helps admins verify the
// upload produced the expected layout without needing to download the file.
function SpecSummary({ spec }) {
    if (!spec) return null;
    const h2 = spec.heading?.['2'] || spec.heading?.['2'];
    const font = h2?.font || spec.body?.font || 'Arial';
    const size = h2 ? `${(h2.size_half_pt || 24) / 2}pt` : `${(spec.body?.size_half_pt || 20) / 2}pt`;
    const border = h2?.border_bottom ? 'border' : 'no border';
    const order = Array.isArray(spec.section_order) && spec.section_order.length
        ? spec.section_order.join(' → ')
        : '—';
    return (
        <div
            style={{
                fontSize: '0.75rem',
                color: 'var(--muted-foreground)',
                marginTop: '0.4rem',
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap'
            }}
        >
            <span><strong>Font:</strong> {font}</span>
            <span><strong>Heading size:</strong> {size}</span>
            <span><strong>Heading style:</strong> {border}</span>
            <span><strong>Sections:</strong> {order}</span>
        </div>
    );
}

// Compact summary of how much candidate data the parser pulled out. Used
// in the expand button label so admins can see at a glance whether the
// extraction was rich or empty.
function summariseExtracted(d) {
    if (!d) return 'empty';
    const bits = [];
    if (d.name?.first || d.name?.last) bits.push('name');
    if (d.contact?.email) bits.push('email');
    if (d.contact?.phone) bits.push('phone');
    if (d.contact?.linkedin_url) bits.push('linkedin');
    if (Array.isArray(d.work_experience) && d.work_experience.length) bits.push(`${d.work_experience.length} job${d.work_experience.length === 1 ? '' : 's'}`);
    if (Array.isArray(d.education) && d.education.length) bits.push(`${d.education.length} degree${d.education.length === 1 ? '' : 's'}`);
    return bits.length ? bits.join(', ') : 'nothing detected';
}

// The Apply button needs at least one of first/last name to create a
// candidate_profiles row (the schema makes both NOT NULL).
function hasMinimumForApply(d) {
    if (!d) return false;
    return !!(d.name?.first || d.name?.last);
}

// Render the structured extracted data. Missing fields render as muted
// "—" so admins immediately see what's present and what isn't.
function ExtractedData({ data }) {
    if (!data) {
        return (
            <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', margin: 0 }}>
                No extracted data yet. Click <strong>Re-extract</strong> below to parse the DOCX.
            </p>
        );
    }
    const { name = {}, contact = {}, location = {}, summary, skills = [], work_experience = [], education = [], notes = [] } = data;
    const fullName = [name.first, name.middle, name.last].filter(Boolean).join(' ');
    const place = [location.city, location.state, location.country].filter(Boolean).join(', ');
    return (
        <div style={{ display: 'grid', gap: '0.6rem', fontSize: '0.85rem' }}>
            {/* Name + contact summary */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem 1rem' }}>
                <DataField icon={<UserPlus className="h-3.5 w-3.5" />} label="Name" value={fullName || '—'} />
                <DataField icon={<Mail className="h-3.5 w-3.5" />} label="Email" value={contact.email || '—'} />
                <DataField icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={contact.phone || '—'} />
                <DataField icon={<Briefcase className="h-3.5 w-3.5" />} label="LinkedIn" value={contact.linkedin_url || '—'} />
                <DataField icon={<Briefcase className="h-3.5 w-3.5" />} label="GitHub" value={contact.github_url || '—'} />
                <DataField icon={<MapPin className="h-3.5 w-3.5" />} label="Location" value={place || '—'} />
            </div>

            {summary && (
                <div>
                    <strong>Summary:</strong>
                    <p style={{ margin: '0.2rem 0 0 0', color: 'var(--muted-foreground)' }}>{summary}</p>
                </div>
            )}

            {skills.length > 0 && (
                <div>
                    <strong>Skills ({skills.length}):</strong>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.3rem' }}>
                        {skills.map((s, i) => (
                            <span
                                key={i}
                                style={{
                                    fontSize: '0.7rem',
                                    padding: '0.1rem 0.5rem',
                                    borderRadius: '9999px',
                                    background: 'var(--accent)',
                                    color: 'var(--accent-foreground)'
                                }}
                            >
                                {s}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {work_experience.length > 0 && (
                <div>
                    <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                        <Briefcase className="h-3.5 w-3.5" />
                        Work Experience ({work_experience.length})
                    </strong>
                    <div style={{ marginTop: '0.3rem', display: 'grid', gap: '0.4rem' }}>
                        {work_experience.map((job, i) => (
                            <div
                                key={i}
                                style={{
                                    padding: '0.5rem 0.7rem',
                                    borderLeft: '3px solid var(--primary)',
                                    background: 'var(--accent) / 0.3',
                                    borderRadius: '0 var(--radius-sm) var(--radius-sm) 0'
                                }}
                            >
                                <div style={{ fontWeight: 600 }}>
                                    {job.title || '(no title)'}
                                    {job.company ? <span style={{ fontWeight: 400, color: 'var(--muted-foreground)' }}> @ {job.company}</span> : null}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                                    {[job.location, job.start, job.end || (job.current ? 'Present' : null)].filter(Boolean).join(' · ')}
                                </div>
                                {job.bullets?.length > 0 && (
                                    <ul style={{ margin: '0.3rem 0 0 1rem', padding: 0 }}>
                                        {job.bullets.map((b, j) => <li key={j}>{b}</li>)}
                                    </ul>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {education.length > 0 && (
                <div>
                    <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                        <GraduationCap className="h-3.5 w-3.5" />
                        Education ({education.length})
                    </strong>
                    <div style={{ marginTop: '0.3rem', display: 'grid', gap: '0.3rem' }}>
                        {education.map((ed, i) => (
                            <div key={i} style={{ fontSize: '0.8rem' }}>
                                <strong>{ed.degree || '(degree)'}</strong>
                                {ed.school ? <span style={{ color: 'var(--muted-foreground)' }}> — {ed.school}</span> : null}
                                {(ed.start || ed.end) && (
                                    <span style={{ color: 'var(--muted-foreground)' }}> ({[ed.start, ed.end || (ed.current ? 'Present' : null)].filter(Boolean).join(' – ')})</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* AI-detected section ordering. Only rendered when the AI pass
                actually ran and returned a section_order — useful for admins
                to confirm the model picked up the right heading structure. */}
            {data.section_order?.length > 0 && (
                <div>
                    <strong>Section order (AI-detected):</strong>{' '}
                    <span style={{ color: 'var(--muted-foreground)', fontSize: '0.8rem' }}>
                        {data.section_order.join(' → ')}
                    </span>
                </div>
            )}

            {notes?.length > 0 && (
                <details style={{ marginTop: '0.2rem' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                        Parser notes ({notes.length})
                    </summary>
                    <ul style={{ margin: '0.3rem 0 0 1rem', padding: 0, fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                        {notes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                </details>
            )}
        </div>
    );
}

function DataField({ icon, label, value }) {
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            <span style={{ color: 'var(--muted-foreground)', display: 'inline-flex', alignItems: 'center' }}>{icon}</span>
            <span style={{ color: 'var(--muted-foreground)' }}>{label}:</span>
            <span style={{ wordBreak: 'break-word' }}>{value}</span>
        </span>
    );
}

export default AdminResumeTemplates;