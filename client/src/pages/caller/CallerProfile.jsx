// Caller profile page.
//
// Single-form page where a caller can record their own blurb, YOE, main
// tech stack, availability, contact channels (email / WhatsApp /
// Telegram), and an optional resume upload. All text inputs are free-form
// per the product spec — there's no validation beyond trim.
//
// POST /caller/profile upserts the text fields, while the resume lives on
// its own endpoint (POST/GET/DELETE /caller/profile/resume) so file
// uploads don't clobber a half-saved text form.

import { useEffect, useRef, useState } from 'react';
import {
    UserCircle2,
    Save,
    Loader2,
    CheckCircle2,
    AlertCircle,
    Briefcase,
    Code2,
    MapPin,
    CalendarDays,
    CalendarCheck2,
    Mail,
    Phone,
    Send,
    Upload,
    Download,
    Trash2,
    FileText
} from 'lucide-react';
import { callerAPI } from '@/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';

const EMPTY = {
    profile_info: '',
    years_of_experience: '',
    main_tech_stack: '',
    availability: '',
    availability_this_week: '',
    location: '',
    email: '',
    whatsapp: '',
    telegram: ''
};

const ACCEPTED_RESUME_EXT = '.pdf,.doc,.docx,.rtf,.txt,.md';
const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10 MB

function CallerProfile() {
    const [form, setForm] = useState(EMPTY);
    const [resumeFilename, setResumeFilename] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState(null);
    const [resumeError, setResumeError] = useState(null);
    const [savedAt, setSavedAt] = useState(null);
    const [uploadedAt, setUploadedAt] = useState(null);
    const fileInputRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await callerAPI.getProfile();
                if (cancelled) return;
                setForm({
                    profile_info:           res.data?.profile_info ?? '',
                    years_of_experience:    res.data?.years_of_experience ?? '',
                    main_tech_stack:        res.data?.main_tech_stack ?? '',
                    availability:           res.data?.availability ?? '',
                    availability_this_week: res.data?.availability_this_week ?? '',
                    location:               res.data?.location ?? '',
                    email:                  res.data?.email ?? '',
                    whatsapp:               res.data?.whatsapp ?? '',
                    telegram:               res.data?.telegram ?? ''
                });
                setResumeFilename(res.data?.resume_filename ?? null);
            } catch (err) {
                if (!cancelled) {
                    setError(err.response?.data?.error || 'Failed to load profile');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

    const onSubmit = async (e) => {
        e?.preventDefault?.();
        setError(null);
        setSaving(true);
        try {
            const payload = {};
            for (const k of Object.keys(EMPTY)) {
                const v = (form[k] ?? '').toString().trim();
                payload[k] = v === '' ? null : v;
            }
            const res = await callerAPI.saveProfile(payload);
            setForm({
                profile_info:           res.data?.profile_info ?? '',
                years_of_experience:    res.data?.years_of_experience ?? '',
                main_tech_stack:        res.data?.main_tech_stack ?? '',
                availability:           res.data?.availability ?? '',
                availability_this_week: res.data?.availability_this_week ?? '',
                location:               res.data?.location ?? '',
                email:                  res.data?.email ?? '',
                whatsapp:               res.data?.whatsapp ?? '',
                telegram:               res.data?.telegram ?? ''
            });
            // resume_filename is owned by the upload route, but we mirror
            // the latest value in case the server reset it.
            setResumeFilename(res.data?.resume_filename ?? null);
            setSavedAt(new Date());
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save profile');
        } finally {
            setSaving(false);
        }
    };

    const onPickFile = () => fileInputRef.current?.click();

    const onFileChosen = async (e) => {
        const file = e.target.files?.[0];
        // Reset the input so re-picking the same file still fires onChange.
        e.target.value = '';
        if (!file) return;

        setResumeError(null);
        if (file.size > MAX_RESUME_BYTES) {
            setResumeError(`File too large (max ${(MAX_RESUME_BYTES / 1024 / 1024).toFixed(0)} MB).`);
            return;
        }

        setUploading(true);
        try {
            const res = await callerAPI.uploadProfileResume(file);
            setResumeFilename(res.data?.resume_filename ?? null);
            setUploadedAt(new Date());
        } catch (err) {
            setResumeError(err.response?.data?.error || 'Failed to upload resume');
        } finally {
            setUploading(false);
        }
    };

    const onDownload = async () => {
        setResumeError(null);
        try {
            await callerAPI.downloadProfileResume();
        } catch (err) {
            setResumeError(err.response?.data?.error || 'Failed to download resume');
        }
    };

    const onDeleteResume = async () => {
        if (!window.confirm('Remove your uploaded resume? This cannot be undone.')) return;
        setResumeError(null);
        setDeleting(true);
        try {
            await callerAPI.deleteProfileResume();
            setResumeFilename(null);
            setUploadedAt(null);
        } catch (err) {
            setResumeError(err.response?.data?.error || 'Failed to delete resume');
        } finally {
            setDeleting(false);
        }
    };

    if (loading) return <PageLoader message="Loading your profile…" />;

    const shortResumeName = resumeFilename
        ? resumeFilename.replace(/^caller_\d+_\d+_/, '')
        : null;

    return (
        <AppPage
            icon={UserCircle2}
            title="My Caller Profile"
            description="Record the blurb, experience, tech stack, availability, contact channels, and an optional resume that follow you on every call."
        >
            <div className="space-y-4">
            <PageCommandBar
                search={(
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white/80">Caller profile</p>
                        <p className="truncate text-xs text-white/40">
                            Blurb, stack, availability, and resume
                        </p>
                    </div>
                )}
                actions={(
                    <Button
                        type="button"
                        size="sm"
                        className="h-10 min-w-[140px]"
                        disabled={saving}
                        onClick={onSubmit}
                    >
                        {saving ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Saving…
                            </>
                        ) : (
                            <>
                                <Save className="h-4 w-4" />
                                Save profile
                            </>
                        )}
                    </Button>
                )}
            />

            {error && (
                <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {savedAt && !error && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>Saved at {savedAt.toLocaleTimeString()}.</span>
                </div>
            )}

            <form onSubmit={onSubmit} className="space-y-4">
                {/* Profile information */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <UserCircle2 className="h-5 w-5 text-primary" />
                            Profile information
                        </CardTitle>
                        <CardDescription>
                            A short blurb — who you are, what kind of roles you
                            cover, and your style on the phone.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Textarea
                            rows={4}
                            value={form.profile_info}
                            onChange={(e) => update('profile_info', e.target.value)}
                            placeholder="e.g. Bilingual caller with 4 years of experience in tech recruitment…"
                        />
                    </CardContent>
                </Card>

                {/* Experience + tech stack + location */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <Briefcase className="h-5 w-5 text-primary" />
                            Experience & focus
                        </CardTitle>
                        <CardDescription>
                            Years of experience, your main tech stack, and where
                            you're based.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="yoe" className="flex items-center gap-2">
                                <Briefcase className="h-3.5 w-3.5 text-muted-foreground" />
                                Years of experience (YOE)
                            </Label>
                            <Input
                                id="yoe"
                                value={form.years_of_experience}
                                onChange={(e) => update('years_of_experience', e.target.value)}
                                placeholder="e.g. 5+"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="location" className="flex items-center gap-2">
                                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                                Location
                            </Label>
                            <Input
                                id="location"
                                value={form.location}
                                onChange={(e) => update('location', e.target.value)}
                                placeholder="e.g. Austin, TX (remote)"
                            />
                        </div>
                        <div className="md:col-span-2 space-y-1.5">
                            <Label htmlFor="stack" className="flex items-center gap-2">
                                <Code2 className="h-3.5 w-3.5 text-muted-foreground" />
                                Main tech stack
                            </Label>
                            <Textarea
                                id="stack"
                                rows={2}
                                value={form.main_tech_stack}
                                onChange={(e) => update('main_tech_stack', e.target.value)}
                                placeholder="e.g. React, Node.js, PostgreSQL, AWS, GraphQL"
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Contact information */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <Mail className="h-5 w-5 text-primary" />
                            Contact information
                        </CardTitle>
                        <CardDescription>
                            Where candidates / recruiters can reach you. Free-form
                            text — use whatever handle your contacts already know.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
                        <div className="space-y-1.5">
                            <Label htmlFor="email" className="flex items-center gap-2">
                                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                                Email
                            </Label>
                            <Input
                                id="email"
                                type="email"
                                value={form.email}
                                onChange={(e) => update('email', e.target.value)}
                                placeholder="you@example.com"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="whatsapp" className="flex items-center gap-2">
                                <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                                WhatsApp
                            </Label>
                            <Input
                                id="whatsapp"
                                value={form.whatsapp}
                                onChange={(e) => update('whatsapp', e.target.value)}
                                placeholder="+1 555 010 0123"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="telegram" className="flex items-center gap-2">
                                <Send className="h-3.5 w-3.5 text-muted-foreground" />
                                Telegram
                            </Label>
                            <Input
                                id="telegram"
                                value={form.telegram}
                                onChange={(e) => update('telegram', e.target.value)}
                                placeholder="@yourhandle"
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Availability */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <CalendarDays className="h-5 w-5 text-primary" />
                            Availability
                        </CardTitle>
                        <CardDescription>
                            Free-form text. Use whatever format suits you — e.g.
                            "M–F 9-6 EST", "Weekends only", or a sentence.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                            <Label htmlFor="avail" className="flex items-center gap-2">
                                <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                                Availability (general)
                            </Label>
                            <Textarea
                                id="avail"
                                rows={3}
                                value={form.availability}
                                onChange={(e) => update('availability', e.target.value)}
                                placeholder="e.g. M–F 9am–6pm EST, occasional weekends"
                            />
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor="avail-week" className="flex items-center gap-2">
                                <CalendarCheck2 className="h-3.5 w-3.5 text-muted-foreground" />
                                Availability this week
                            </Label>
                            <Textarea
                                id="avail-week"
                                rows={3}
                                value={form.availability_this_week}
                                onChange={(e) => update('availability_this_week', e.target.value)}
                                placeholder="e.g. Tue 2-5pm, Thu 10am-12pm, Fri all day"
                            />
                        </div>
                    </CardContent>
                </Card>

                <div className="flex items-center justify-end gap-3">
                    <Button
                        type="submit"
                        disabled={saving}
                        className="min-w-[160px]"
                    >
                        {saving ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Saving…
                            </>
                        ) : (
                            <>
                                <Save className="h-4 w-4" />
                                Save profile
                            </>
                        )}
                    </Button>
                </div>
            </form>

            {/* Resume upload — separate card, separate endpoint */}
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-lg">
                        <FileText className="h-5 w-5 text-primary" />
                        Resume
                    </CardTitle>
                    <CardDescription>
                        Optional. Upload a single resume (PDF, DOC, DOCX, RTF, TXT, MD —
                        max 10 MB). Uploading a new file replaces the previous one.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                    {resumeError && (
                        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                            <span>{resumeError}</span>
                        </div>
                    )}

                    {uploadedAt && !resumeError && (
                        <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                            <CheckCircle2 className="h-4 w-4 shrink-0" />
                            <span>Resume updated at {uploadedAt.toLocaleTimeString()}.</span>
                        </div>
                    )}

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPTED_RESUME_EXT}
                        className="hidden"
                        onChange={onFileChosen}
                    />

                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={onPickFile}
                            disabled={uploading || deleting}
                        >
                            {uploading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Uploading…
                                </>
                            ) : (
                                <>
                                    <Upload className="h-4 w-4" />
                                    {resumeFilename ? 'Replace resume' : 'Upload resume'}
                                </>
                            )}
                        </Button>

                        {resumeFilename && (
                            <>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={onDownload}
                                    disabled={uploading || deleting}
                                >
                                    <Download className="h-4 w-4" />
                                    Download
                                </Button>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={onDeleteResume}
                                    disabled={uploading || deleting}
                                    className="text-destructive hover:text-destructive"
                                >
                                    {deleting ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-4 w-4" />
                                    )}
                                    Remove
                                </Button>
                            </>
                        )}
                    </div>

                    {resumeFilename && (
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                            <FileText className="h-3.5 w-3.5" />
                            Current file: <span className="font-medium text-foreground">{shortResumeName}</span>
                        </p>
                    )}
                </CardContent>
            </Card>
            </div>
        </AppPage>
    );
}

export default CallerProfile;
