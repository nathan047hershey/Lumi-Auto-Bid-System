// =============================================================================
// DeveloperProfile — the developer manages their own profile
// =============================================================================
// The developer is the only role whose workflow hinges on a personal
// profile: clients pick a developer to assign an interview to, so the
// developer needs to surface their technical skills, availability,
// resume, and contact channels (email + Telegram required; WhatsApp +
// phone optional).
//
// Backend contract:
//   GET    /api/user/developer/profile             → load the row
//   PUT    /api/user/developer/profile             → save fields
//   POST   /api/user/developer/profile/resume      → upload resume text
//
// Email + Telegram are gated server-side too — saving without either
// returns 400. The form mirrors that gate with inline error labels so
// the user gets immediate feedback without a round-trip on invalid
// input.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Briefcase,
    Check,
    Download,
    FileText,
    Mail,
    MessageCircle,
    Phone,
    Save,
    User as UserIcon,
    X
} from 'lucide-react';
import { userAPI } from '@/api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { UserCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

function DeveloperProfile() {
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [savedAt, setSavedAt] = useState(null);

    // Editable fields. Held separately from `profile` so the user
    // can stage changes without the loaded row changing underneath
    // them. Initialised from the loaded row.
    const [draft, setDraft] = useState({
        technical_skills: '',
        availability: '',
        contact_email: '',
        contact_whatsapp: '',
        contact_phone: '',
        contact_telegram: ''
    });

    // Resume upload state — separate from the form because uploading
    // involves a file picker + text payload, not a JSON PATCH.
    const fileInputRef = useRef(null);
    const [resumeBusy, setResumeBusy] = useState(false);
    const [resumeError, setResumeError] = useState(null);

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const res = await userAPI.getDeveloperProfile();
            const row = res?.data || {};
            setProfile(row);
            setDraft({
                technical_skills: row.technical_skills || '',
                availability: row.availability || '',
                contact_email: row.contact_email || '',
                contact_whatsapp: row.contact_whatsapp || '',
                contact_phone: row.contact_phone || '',
                contact_telegram: row.contact_telegram || ''
            });
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to load developer profile');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Inline validation. Mirrors the server's required-field rules
    // so we don't burn a round-trip on obvious misses. The server is
    // still the source of truth — we re-validate there.
    const emailMissing = !String(draft.contact_email || '').trim();
    const telegramMissing = !String(draft.contact_telegram || '').trim();

    const handleSave = async (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (emailMissing) {
            setError('Email is required');
            return;
        }
        if (telegramMissing) {
            setError('Telegram handle is required');
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await userAPI.updateDeveloperProfile(draft);
            setProfile(res?.data || profile);
            setSavedAt(new Date());
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save developer profile');
        } finally {
            setSaving(false);
        }
    };

    const handleResumeUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // Only accept text-y resumes — markdown or plain text. Binary
        // uploads (PDF/DOCX) are out of scope here; the developer can
        // paste converted markdown instead.
        if (!/\.(md|markdown|txt)$/i.test(file.name)) {
            setResumeError('Please choose a .md, .markdown, or .txt file');
            e.target.value = '';
            return;
        }
        setResumeBusy(true);
        setResumeError(null);
        try {
            const content = await file.text();
            const res = await userAPI.uploadDeveloperResume(file.name, content);
            setProfile((p) => ({ ...(p || {}), developer_resume: res?.data?.filename || null }));
        } catch (err) {
            setResumeError(err.response?.data?.error || 'Failed to upload resume');
        } finally {
            setResumeBusy(false);
            // Reset the input so the same file can be re-picked later.
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    if (loading) return <PageLoader message="Loading developer profile..." />;

    return (
        <AppPage
            icon={UserCircle2}
            title="My Developer Profile"
            description="Share your skills, availability, and contact channels so admins can assign the right work to you."
        >
        <div className="space-y-4">
            <PageCommandBar
                search={(
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white/80">Developer profile</p>
                        <p className="truncate text-xs text-white/40">
                            Skills, availability, contacts, and resume
                        </p>
                    </div>
                )}
                actions={(
                    <>
                        {profile?.developer_resume ? (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-10"
                                onClick={() => window.open(`/resumes/${profile.developer_resume}`, '_blank')}
                            >
                                <Download className="h-4 w-4" />
                                <span className="hidden sm:inline">View resume</span>
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-10"
                            onClick={load}
                            disabled={saving}
                        >
                            <X className="h-4 w-4" />
                            <span className="hidden sm:inline">Reset</span>
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            className="h-10"
                            disabled={saving || emailMissing || telegramMissing}
                            onClick={handleSave}
                        >
                            <Save className="h-4 w-4" />
                            {saving ? 'Saving…' : 'Save profile'}
                        </Button>
                    </>
                )}
            />

            {error && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {error}
                </div>
            )}
            {savedAt && !error && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-300">
                    <Check className="inline h-3 w-3 mr-1" />
                    Profile saved.
                </div>
            )}

            <form onSubmit={handleSave} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {/* Skills + availability column */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Briefcase className="h-4 w-4" />
                            Skills & Availability
                        </CardTitle>
                        <CardDescription>
                            Free-form text — describe what you can do and when you're available.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="space-y-1">
                            <Label htmlFor="technical_skills">
                                Technical skills
                            </Label>
                            <Textarea
                                id="technical_skills"
                                rows={5}
                                value={draft.technical_skills}
                                onChange={(e) => setDraft({ ...draft, technical_skills: e.target.value })}
                                placeholder="e.g. React, Node.js, TypeScript, Postgres, AWS, Docker"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label htmlFor="availability">
                                Availability
                            </Label>
                            <Textarea
                                id="availability"
                                rows={3}
                                value={draft.availability}
                                onChange={(e) => setDraft({ ...draft, availability: e.target.value })}
                                placeholder="e.g. Mon-Fri 9am-6pm GMT-4; flexible on weekends"
                            />
                        </div>
                    </CardContent>
                </Card>

                {/* Contact + resume column */}
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <UserIcon className="h-4 w-4" />
                            Contact & Resume
                        </CardTitle>
                        <CardDescription>
                            Email and Telegram are required so admins can reach you.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="space-y-1">
                            <Label htmlFor="contact_email">
                                <Mail className="inline h-3 w-3 mr-1" />
                                Email *
                            </Label>
                            <Input
                                id="contact_email"
                                type="email"
                                value={draft.contact_email}
                                onChange={(e) => setDraft({ ...draft, contact_email: e.target.value })}
                                placeholder="you@example.com"
                                className={emailMissing ? 'border-destructive/50' : ''}
                                required
                            />
                            {emailMissing && (
                                <p className="text-[10px] text-destructive">Email is required.</p>
                            )}
                        </div>

                        <div className="space-y-1">
                            <Label htmlFor="contact_telegram">
                                <MessageCircle className="inline h-3 w-3 mr-1" />
                                Telegram *
                            </Label>
                            <Input
                                id="contact_telegram"
                                value={draft.contact_telegram}
                                onChange={(e) => setDraft({ ...draft, contact_telegram: e.target.value })}
                                placeholder="@yourhandle"
                                className={telegramMissing ? 'border-destructive/50' : ''}
                                required
                            />
                            {telegramMissing && (
                                <p className="text-[10px] text-destructive">Telegram handle is required.</p>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label htmlFor="contact_whatsapp">
                                    <MessageCircle className="inline h-3 w-3 mr-1" />
                                    WhatsApp
                                </Label>
                                <Input
                                    id="contact_whatsapp"
                                    value={draft.contact_whatsapp}
                                    onChange={(e) => setDraft({ ...draft, contact_whatsapp: e.target.value })}
                                    placeholder="+1 555 0123"
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="contact_phone">
                                    <Phone className="inline h-3 w-3 mr-1" />
                                    Phone
                                </Label>
                                <Input
                                    id="contact_phone"
                                    value={draft.contact_phone}
                                    onChange={(e) => setDraft({ ...draft, contact_phone: e.target.value })}
                                    placeholder="+1 555 0123"
                                />
                            </div>
                        </div>

                        <div className="space-y-1">
                            <Label>
                                <FileText className="inline h-3 w-3 mr-1" />
                                Resume (.md / .markdown / .txt)
                            </Label>
                            <div className="flex items-center gap-2">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".md,.markdown,.txt,text/markdown,text/plain"
                                    onChange={handleResumeUpload}
                                    disabled={resumeBusy}
                                    className="block w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-foreground hover:file:bg-primary/90"
                                />
                                {profile?.developer_resume && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => window.open(`/resumes/${profile.developer_resume}`, '_blank')}
                                    >
                                        <Download className="h-3 w-3" />
                                    </Button>
                                )}
                            </div>
                            {resumeError && (
                                <p className="text-[10px] text-destructive">{resumeError}</p>
                            )}
                            {profile?.developer_resume && !resumeError && (
                                <p className="text-[10px] text-muted-foreground">
                                    Current: {profile.developer_resume}
                                </p>
                            )}
                        </div>
                    </CardContent>
                </Card>

                {/* Save row spans both columns */}
                <div className="lg:col-span-2 flex items-center justify-end gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={load}
                        disabled={saving}
                    >
                        <X className="h-4 w-4" />
                        Reset
                    </Button>
                    <Button
                        type="submit"
                        disabled={saving || emailMissing || telegramMissing}
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                        <Save className="h-4 w-4" />
                        {saving ? 'Saving…' : 'Save profile'}
                    </Button>
                </div>
            </form>
        </div>
        </AppPage>
    );
}

export default DeveloperProfile;
