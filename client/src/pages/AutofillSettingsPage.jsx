/**
 * Dedicated Autofill Settings page:
 * - Lumi runtime prefs (AFK, CapSolver, auto-submit)
 * - Public fixed answers (same for every profile) — gender, visa, logistics
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Loader2, Save, Zap } from 'lucide-react';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import LumiBidderSettings from '@/components/LumiBidderSettings';
import TeachAndCheckPanel from '@/components/TeachAndCheckPanel';
import ProfileAutofillSettings, {
    DEFAULT_AUTOFILL_ANSWERS,
    SHARED_AUTOFILL_KEYS
} from '@/components/ProfileAutofillSettings';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { adminAPI, managerAPI, userAPI } from '@/api';
import { cn } from '@/lib/utils';

function emptyPublicForm() {
    const next = {};
    for (const key of SHARED_AUTOFILL_KEYS) {
        next[key] = DEFAULT_AUTOFILL_ANSWERS[key] ?? '';
    }
    return next;
}

export default function AutofillSettingsPage() {
    const { user, additionalRoles } = useAuth();
    const role = String(user?.role || '').toLowerCase();
    const canEditProfileAutofill = role === 'admin'
        || role === 'manager'
        || additionalRoles.some((r) => ['admin', 'manager'].includes(String(r || '').toLowerCase()));

    const [profileCount, setProfileCount] = useState(0);
    const [formData, setFormData] = useState(emptyPublicForm);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const api = useMemo(() => {
        if (role === 'admin' || additionalRoles.includes('admin')) return adminAPI;
        if (role === 'manager' || additionalRoles.includes('manager')) return managerAPI;
        return userAPI;
    }, [role, additionalRoles]);

    const profilesListPath = role === 'manager' ? '/manager/profiles' : '/admin/profiles';

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const hash = window.location.hash;
        if (hash !== '#lumi-bidder-settings' && hash !== '#bidder-autofill-settings') return undefined;
        const t = window.setTimeout(() => {
            document.getElementById(hash.slice(1))?.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }, 150);
        return () => window.clearTimeout(t);
    }, [loading]);

    const loadPublicDefaults = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const { data } = await api.getProfiles();
            const list = Array.isArray(data) ? data : (data?.profiles || data?.data || []);
            setProfileCount(list.length);
            const next = emptyPublicForm();
            // Seed the form from the first profile that has any shared answer set.
            const seed = list.find((p) => SHARED_AUTOFILL_KEYS.some((k) => p?.[k])) || list[0];
            if (seed) {
                for (const key of SHARED_AUTOFILL_KEYS) {
                    if (seed[key] != null && String(seed[key]).trim() !== '') {
                        next[key] = seed[key];
                    }
                }
            }
            setFormData(next);
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to load autofill defaults');
            setProfileCount(0);
            setFormData(emptyPublicForm());
        } finally {
            setLoading(false);
        }
    }, [api]);

    useEffect(() => {
        loadPublicDefaults();
    }, [loadPublicDefaults]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
        setSuccess('');
    };

    const handleSavePublic = async () => {
        if (!canEditProfileAutofill || !api.applyAutofillDefaultsToAll) return;
        if (!profileCount) {
            setError('No profiles yet — create a profile first');
            return;
        }
        setSaving(true);
        setError('');
        setSuccess('');
        try {
            const shared = {};
            for (const key of SHARED_AUTOFILL_KEYS) {
                shared[key] = formData[key] ?? '';
            }
            const { data } = await api.applyAutofillDefaultsToAll(shared);
            const updated = data?.updated ?? profileCount;
            setSuccess(
                data?.message
                || `Public autofill answers saved to ${updated} profile(s)`
            );
        } catch (err) {
            setError(err.response?.data?.error || err.message || 'Failed to save public autofill answers');
        } finally {
            setSaving(false);
        }
    };

    return (
        <AppPage
            icon={ClipboardList}
            title="Autofill Settings"
            description="Lumi runtime prefs and public fixed answers (same for every profile)"
        >
            <div className="space-y-4">
                <PageCommandBar
                    filters={(
                        <p className="text-sm text-white/45">
                            Public answers apply to all {profileCount || '…'} profile{profileCount === 1 ? '' : 's'}.
                            {canEditProfileAutofill ? (
                                <>
                                    {' '}Education / preferred name:{' '}
                                    <Link className="text-primary underline" to={profilesListPath}>
                                        Profiles
                                    </Link>
                                </>
                            ) : null}
                        </p>
                    )}
                    actions={canEditProfileAutofill ? (
                        <Button
                            type="button"
                            className="h-10"
                            disabled={saving || loading || !profileCount}
                            onClick={handleSavePublic}
                        >
                            {saving ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <Save className="h-4 w-4" />
                            )}
                            Save public answers
                        </Button>
                    ) : null}
                />

                {error ? (
                    <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                        {error}
                    </div>
                ) : null}
                {success ? (
                    <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300">
                        {success}
                    </div>
                ) : null}

                <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
                <section
                    id="lumi-bidder-settings"
                    className={cn(
                        'scroll-mt-6 overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4 sm:p-5',
                        'shadow-[0_16px_48px_-28px_rgba(0,0,0,0.65)]'
                    )}
                >
                    <div className="mb-4 flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                            <Zap className="h-4 w-4" />
                        </span>
                        <div>
                            <h2 className="text-base font-semibold tracking-tight">Lumi</h2>
                            <p className="mt-0.5 text-sm text-white/40">
                                AFK, CAPTCHA solver keys, auto-submit — synced to the Chrome extension
                            </p>
                        </div>
                    </div>
                    <LumiBidderSettings showTitle={false} showProfileAutofillHint={false} />
                </section>

                <section
                    id="bidder-autofill-settings"
                    className={cn(
                        'scroll-mt-6 overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4 sm:p-5',
                        'shadow-[0_16px_48px_-28px_rgba(0,0,0,0.65)]'
                    )}
                >
                    <div className="mb-4">
                        <h2 className="text-base font-semibold tracking-tight">Public autofill answers</h2>
                        <p className="mt-0.5 text-sm text-white/40">
                            Gender, visa, work auth, and logistics — one set for every profile.
                            {canEditProfileAutofill
                                ? ' Save writes to all candidates. Education and preferred name stay on each full profile.'
                                : ' Set by admin/manager — shown read-only here.'}
                        </p>
                    </div>

                    {loading ? (
                        <div className="flex items-center gap-2 text-sm text-white/40">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Loading public answers…
                        </div>
                    ) : !profileCount ? (
                        <p className="text-sm text-white/40">
                            No profiles yet.
                            {canEditProfileAutofill ? (
                                <>
                                    {' '}
                                    <Link className="text-primary underline" to={role === 'manager' ? '/manager/profiles/new' : '/admin/profiles/new'}>
                                        Create a profile
                                    </Link>
                                </>
                            ) : null}
                        </p>
                    ) : (
                        <div className={canEditProfileAutofill ? '' : 'pointer-events-none opacity-80'}>
                            <ProfileAutofillSettings
                                formData={formData}
                                setFormData={setFormData}
                                handleChange={handleChange}
                                showApplyDefaults={canEditProfileAutofill}
                                publicOnly
                            />
                        </div>
                    )}
                    <div className="mt-5 border-t border-white/[0.07] pt-4">
                        <h3 className="mb-2 text-sm font-semibold tracking-tight">Learn from a bidding course</h3>
                        <TeachAndCheckPanel compact />
                    </div>
                </section>
                </div>
            </div>
        </AppPage>
    );
}
