import { useEffect, useState, useCallback } from 'react';
import { Settings as SettingsIcon, Bot, Save, Loader2, CheckCircle2, KeyRound, Trash2 } from 'lucide-react';
import { adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/SelectField';
import LumiBidderSettings from '@/components/LumiBidderSettings';

const PROVIDER_OPTIONS = [
    { value: 'minimax', label: 'MiniMax (default)' },
    { value: 'groq', label: 'Groq' }
];

function AdminSettings() {
    const [settings, setSettings] = useState(null);
    const [activeProvider, setActiveProvider] = useState('minimax');
    const [groqDraft, setGroqDraft] = useState('');
    const [localEnabled, setLocalEnabled] = useState(false);
    const [localBaseUrl, setLocalBaseUrl] = useState('http://127.0.0.1:11434/v1');
    const [localModel, setLocalModel] = useState('llama3.2');
    const [localKeyDraft, setLocalKeyDraft] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [success, setSuccess] = useState(null);

    const syncLocalFromPayload = (data) => {
        const ll = data?.local_llm || {};
        setLocalEnabled(!!ll.enabled);
        setLocalBaseUrl(ll.base_url || 'http://127.0.0.1:11434/v1');
        setLocalModel(ll.model || 'llama3.2');
        setLocalKeyDraft('');
    };

    const applySettings = (data) => {
        setSettings(data);
        const p = data.ai_provider === 'groq' ? 'groq' : 'minimax';
        setActiveProvider(p);
        syncLocalFromPayload(data);
    };

    const load = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const { data } = await adminAPI.getSettings();
            applySettings(data);
            setGroqDraft('');
        } catch (err) {
            console.error('Failed to load settings:', err);
            setError(err.response?.data?.error || 'Failed to load settings');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        if (window.location.hash !== '#lumi-bidder-settings') return undefined;
        const t = window.setTimeout(() => {
            document.getElementById('lumi-bidder-settings')?.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }, 120);
        return () => clearTimeout(t);
    }, [loading]);

    const mm = settings?.minimax_keys;
    const gq = settings?.groq_keys;
    const minimaxSlot = Number(settings?.minimax_key_slot) === 2 ? 2 : 1;

    const localDirty = settings && (
        localEnabled !== !!settings.local_llm?.enabled
        || localBaseUrl.trim().replace(/\/+$/, '') !== String(settings.local_llm?.base_url || '').replace(/\/+$/, '')
        || localModel.trim() !== String(settings.local_llm?.model || '')
        || localKeyDraft.trim() !== ''
    );

    const providerDirty = settings && (
        (activeProvider === 'groq' ? 'groq' : 'minimax') !== (settings.ai_provider === 'groq' ? 'groq' : 'minimax')
    );

    const handleSetMinimaxSlot = async (slot) => {
        try {
            setSaving(true);
            setError(null);
            setSuccess(null);
            const { data } = await adminAPI.updateSettings({
                ai_provider: 'minimax',
                minimax_key_slot: slot
            });
            applySettings(data);
            setSuccess(`MiniMax Key ${slot} is now active.`);
            setTimeout(() => setSuccess(null), 4000);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to switch MiniMax key');
        } finally {
            setSaving(false);
        }
    };

    const handleSetActiveProvider = async () => {
        try {
            setSaving(true);
            setError(null);
            setSuccess(null);
            const body = { ai_provider: activeProvider };
            if (activeProvider === 'minimax') {
                body.minimax_key_slot = minimaxSlot;
            }
            const { data } = await adminAPI.updateSettings(body);
            applySettings(data);
            setSuccess(`Active provider: ${data.ai_provider === 'groq' ? 'Groq' : 'MiniMax'}.`);
            setTimeout(() => setSuccess(null), 4000);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to set provider');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveGroqKey = async () => {
        const trimmed = groqDraft.trim();
        if (!trimmed) {
            setError('Paste a Groq API key first.');
            return;
        }
        try {
            setSaving(true);
            setError(null);
            setSuccess(null);
            const { data } = await adminAPI.updateSettings({
                ai_provider: 'groq',
                groq_api_keys: trimmed,
                groq_keys_replace: false
            });
            applySettings(data);
            setGroqDraft('');
            setSuccess(`Groq key saved to local.env (${data.groq_keys?.count || 0} total). Groq is now active.`);
            setTimeout(() => setSuccess(null), 5000);
        } catch (err) {
            console.error('Failed to save Groq key:', err);
            setError(err.response?.data?.error || 'Failed to save Groq key');
        } finally {
            setSaving(false);
        }
    };

    const clearGroqKey = async (slot) => {
        if (!confirm(`Remove Groq Key ${slot}?`)) return;
        try {
            setSaving(true);
            setError(null);
            const { data } = await adminAPI.updateSettings({
                ai_provider: settings?.ai_provider === 'groq' ? 'groq' : undefined,
                groq_remove_slot: slot
            });
            applySettings(data);
            setSuccess(`Removed Groq Key ${slot}.`);
            setTimeout(() => setSuccess(null), 4000);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to remove key');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveLocal = async () => {
        try {
            setSaving(true);
            setError(null);
            setSuccess(null);
            const body = {
                local_llm_enabled: localEnabled,
                local_llm_base_url: localBaseUrl.trim(),
                local_llm_model: localModel.trim()
            };
            if (localKeyDraft.trim()) body.local_llm_api_key = localKeyDraft.trim();
            const { data } = await adminAPI.updateSettings(body);
            applySettings(data);
            setSuccess(
                data.local_llm?.enabled
                    ? `Local LLM on — ${data.local_llm.model}`
                    : 'Local LLM saved (off).'
            );
            setTimeout(() => setSuccess(null), 4000);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save local LLM');
        } finally {
            setSaving(false);
        }
    };

    const minimaxRow = (slot) => {
        const info = slot === 1 ? mm?.key_1 : mm?.key_2;
        const isActiveProvider = settings?.ai_provider === 'minimax';
        const isActiveSlot = isActiveProvider && minimaxSlot === slot;
        return (
            <button
                type="button"
                key={slot}
                disabled={saving || !info?.is_set}
                onClick={() => handleSetMinimaxSlot(slot)}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                    isActiveSlot
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-white/[0.07] bg-black/20 hover:border-primary/30 hover:bg-white/[0.03]'
                } ${!info?.is_set ? 'opacity-60' : ''}`}
            >
                <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">
                        MiniMax Key {slot}
                        {isActiveSlot ? ' · active' : ''}
                        {info?.from_env ? ' · from local.env' : info?.is_set ? ' · saved' : ''}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {info?.is_set
                            ? `${info.masked || '••••'} · ${info.source || 'stored'}`
                            : 'Not set — add MINIMAX_API_KEY' + (slot === 2 ? '_2' : '') + ' in server/local.env'}
                    </div>
                </div>
            </button>
        );
    };

    return (
        <AppPage
            icon={SettingsIcon}
            title="Application Settings"
            description="Configure global behavior for the platform."
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Platform settings</p>
                            <p className="truncate text-xs text-white/40">
                                API keys, providers, local LLM, and Lumi
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" onClick={load} disabled={loading || saving}>
                            {loading ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                                <SettingsIcon className="h-4 w-4" />
                            )}
                            <span className="hidden sm:inline">Reload</span>
                        </Button>
                    )}
                />

                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <KeyRound className="h-5 w-5" />
                            <div>
                                <CardTitle>API keys</CardTitle>
                                <CardDescription>
                                    MiniMax generates CVs and drafts form answers. Groq checks weak drafts,
                                    rescues empty/hard fields, and checkouts the filled application before
                                    auto-submit (blocks submit when critical issues remain).
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-5">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading settings…
                            </div>
                        ) : (
                            <>
                                <div className="space-y-2">
                                    <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                                        MiniMax defaults
                                    </Label>
                                    <div className="grid gap-2 sm:grid-cols-2">
                                        {minimaxRow(1)}
                                        {minimaxRow(2)}
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        Click a key to make it the active MiniMax slot. Values are managed in{' '}
                                        <code>server/local.env</code>
                                        {mm?.prefer_env ? ' (MINIMAX_PREFER_ENV=1).' : '.'}
                                    </p>
                                </div>

                                <div className="grid gap-3 sm:grid-cols-[minmax(0,220px)_1fr_auto] sm:items-end">
                                    <div className="space-y-1.5">
                                        <Label>Active provider</Label>
                                        <SelectField
                                            value={activeProvider}
                                            onChange={setActiveProvider}
                                            options={PROVIDER_OPTIONS}
                                        />
                                    </div>
                                    <div className="text-sm text-muted-foreground self-center pb-2">
                                        {settings?.answers_provider?.provider ? (
                                            <>
                                                Answers engine:{' '}
                                                <code>{settings.answers_provider.provider}</code>
                                                {settings.answers_provider.model ? (
                                                    <> · <code>{settings.answers_provider.model}</code></>
                                                ) : null}
                                                {' · '}
                                            </>
                                        ) : null}
                                        CV:{' '}
                                        {settings?.ai_provider === 'groq'
                                            ? `Groq · ${gq?.count || 0} key${(gq?.count || 0) === 1 ? '' : 's'}`
                                            : `MiniMax Key ${minimaxSlot}`}
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        disabled={saving || !providerDirty}
                                        onClick={handleSetActiveProvider}
                                    >
                                        Set active
                                    </Button>
                                </div>

                                <div className="space-y-3 rounded-lg border border-border p-4">
                                    <div>
                                        <div className="font-medium text-sm">Add Groq key</div>
                                        <p className="text-xs text-muted-foreground mt-0.5">
                                            Saves to <code>server/local.env</code> as{' '}
                                            <code>GROQ_API_KEY_1</code>…. One key per save — use separate
                                            Groq accounts so free daily limits stack.
                                        </p>
                                    </div>
                                    <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                                        <div className="space-y-1.5">
                                            <Label htmlFor="groq_key_paste">Groq API key</Label>
                                            <Input
                                                id="groq_key_paste"
                                                type="password"
                                                autoComplete="off"
                                                value={groqDraft}
                                                onChange={(e) => setGroqDraft(e.target.value)}
                                                placeholder="gsk_…"
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        handleSaveGroqKey();
                                                    }
                                                }}
                                            />
                                        </div>
                                        <Button type="button" disabled={saving} onClick={handleSaveGroqKey}>
                                            {saving ? (
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            ) : (
                                                <Save className="mr-2 h-4 w-4" />
                                            )}
                                            Add Groq key
                                        </Button>
                                    </div>

                                    {gq?.keys?.length > 0 ? (
                                        <ul className="space-y-1">
                                            {gq.keys.map((k) => (
                                                <li
                                                    key={k.slot}
                                                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                                                >
                                                    <span>
                                                        Groq Key {k.slot}
                                                        {k.active ? ' · active' : ''}
                                                        {k.masked ? ` · ${k.masked}` : ''}
                                                        {k.source ? ` · ${k.source}` : ''}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                                                        onClick={() => clearGroqKey(k.slot)}
                                                        disabled={saving}
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                        Remove
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    ) : (
                                        <p className="text-xs text-muted-foreground">No Groq keys saved yet.</p>
                                    )}
                                </div>

                                {error && (
                                    <div className="rounded-xl border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-red-200">
                                        {error}
                                    </div>
                                )}
                                {success && (
                                    <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                                        <CheckCircle2 className="h-4 w-4" />
                                        {success}
                                    </div>
                                )}

                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-xs text-muted-foreground">
                                        {settings?.updated_at && (
                                            <>Last changed: {new Date(settings.updated_at).toLocaleString()}</>
                                        )}
                                    </div>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={async () => {
                                            try {
                                                setError(null);
                                                setSuccess(null);
                                                const { data } = await adminAPI.testSettings();
                                                if (data.ok) {
                                                    setSuccess(
                                                        `Test OK — ${data.provider} (${data.model})` +
                                                        (data.minimax_key_slot ? ` · MiniMax Key ${data.minimax_key_slot}` : '') +
                                                        (data.groq_key_slot ? ` · Groq Key ${data.groq_key_slot}` : '')
                                                    );
                                                } else {
                                                    setError(`Test failed: ${data.error || 'unknown error'}`);
                                                }
                                                setTimeout(() => setSuccess(null), 4000);
                                            } catch (err) {
                                                setError(err.response?.data?.error || err.message || 'Test failed');
                                            }
                                        }}
                                    >
                                        Test connection
                                    </Button>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-3">
                            <Bot className="h-5 w-5" />
                            <div>
                                <CardTitle>Local LLM (autofill / bidder answers)</CardTitle>
                                <CardDescription>
                                    Optional. CV generation stays on the cloud provider above.
                                </CardDescription>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {loading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Loading…
                            </div>
                        ) : (
                            <>
                                <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={localEnabled}
                                        onChange={(e) => setLocalEnabled(e.target.checked)}
                                    />
                                    <div>
                                        <div className="font-medium text-sm">Use local model for answers</div>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            When on, autofill / bidder answers call your local endpoint
                                            instead of the cloud provider.
                                        </p>
                                    </div>
                                </label>

                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="space-y-1.5 sm:col-span-2">
                                        <Label htmlFor="localBaseUrl">Base URL</Label>
                                        <Input
                                            id="localBaseUrl"
                                            value={localBaseUrl}
                                            onChange={(e) => setLocalBaseUrl(e.target.value)}
                                            placeholder="http://127.0.0.1:11434/v1"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="localModel">Model name</Label>
                                        <Input
                                            id="localModel"
                                            value={localModel}
                                            onChange={(e) => setLocalModel(e.target.value)}
                                            placeholder="llama3.2"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="localKey">API key (optional)</Label>
                                        <Input
                                            id="localKey"
                                            type="password"
                                            value={localKeyDraft}
                                            onChange={(e) => setLocalKeyDraft(e.target.value)}
                                            placeholder={
                                                settings?.local_llm?.has_custom_key
                                                    ? '•••• set — leave blank to keep'
                                                    : 'Usually not needed for Ollama'
                                            }
                                            autoComplete="off"
                                        />
                                    </div>
                                </div>

                                {settings?.local_llm?.enabled && (
                                    <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
                                        Local answers active — <code>{settings.local_llm.model}</code>
                                        {' '}via <code>{settings.local_llm.api_url}</code>
                                    </div>
                                )}

                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        type="button"
                                        variant="outline"
                                        disabled={saving}
                                        onClick={async () => {
                                            try {
                                                setError(null);
                                                setSuccess(null);
                                                if (localDirty) await handleSaveLocal();
                                                const { data } = await adminAPI.testSettings({ target: 'local' });
                                                if (data.ok) {
                                                    setSuccess(`Local test OK — ${data.provider} (${data.model})`);
                                                } else {
                                                    setError(`Local test failed: ${data.error || 'unknown'}`);
                                                }
                                                setTimeout(() => setSuccess(null), 5000);
                                            } catch (err) {
                                                setError(err.response?.data?.error || err.message || 'Local test failed');
                                            }
                                        }}
                                    >
                                        Test local model
                                    </Button>
                                    <Button
                                        type="button"
                                        onClick={handleSaveLocal}
                                        disabled={!localDirty || saving}
                                    >
                                        {saving ? (
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        ) : (
                                            <Save className="mr-2 h-4 w-4" />
                                        )}
                                        Save local LLM
                                    </Button>
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Lumi</CardTitle>
                        <CardDescription>
                            AFK, CAPTCHA solver keys, and auto-submit — synced to the Lumi extension
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <LumiBidderSettings showTitle={false} showProfileAutofillHint />
                    </CardContent>
                </Card>
            </div>
        </AppPage>
    );
}

export default AdminSettings;
