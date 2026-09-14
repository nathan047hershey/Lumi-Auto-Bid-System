/**
 * GmailMailSettings
 *
 * Free Gmail receive via IMAP + App Password (no paid Google Cloud /
 * Pub/Sub setup). User enables 2-Step Verification on the Google Account,
 * creates an App Password at https://myaccount.google.com/apppasswords,
 * and pastes the 16-char code here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { userAPI } from '@/api';
import { Trash2, Plus, Mail, ExternalLink, RefreshCw, Eye, EyeOff } from 'lucide-react';

export default function GmailMailSettings({ className = '' }) {
    const [mailboxes, setMailboxes] = useState([]);
    const [busy, setBusy] = useState(false);
    const [syncingId, setSyncingId] = useState(null);
    const [msg, setMsg] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [email, setEmail] = useState('');
    const [appPassword, setAppPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    const refresh = useCallback(async () => {
        const attempt = async () => {
            try {
                const res = await userAPI.getOutlookStatus();
                return { ok: true, data: res.data };
            } catch (err) {
                return { ok: false, err };
            }
        };
        const first = await attempt();
        if (first.ok) {
            const list = first.data?.gmail || [];
            setMailboxes(Array.isArray(list) ? list : []);
            return;
        }
        const code = first.err?.response?.status;
        const hasToken = !!localStorage.getItem('token');
        if (code === 401 && hasToken) {
            await new Promise((r) => setTimeout(r, 400));
            const second = await attempt();
            if (second.ok) {
                const list = second.data?.gmail || [];
                setMailboxes(Array.isArray(list) ? list : []);
                return;
            }
        }
        // Don't wipe existing mailboxes on transient errors — keep showing
        // the last known list (server still owns them for this user).
        // Fall through without calling setMailboxes([]).
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const connect = async (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (!email.trim() || !appPassword.trim()) { setMsg('Email and App Password are required'); return; }
        setBusy(true); setMsg('');
        try {
            await userAPI.connectGmailImap({
                email: email.trim(),
                app_password: appPassword.replace(/\s+/g, '')
            });
            setMsg(`Connected ${email.trim()}`);
            setEmail(''); setAppPassword(''); setShowPassword(false); setShowForm(false);
            await refresh();
        } catch (err) {
            setMsg(err?.response?.data?.error || err?.message || 'Connect failed');
        } finally { setBusy(false); }
    };

    const removeMailbox = async (id, emailAddr) => {
        if (!window.confirm(`Disconnect ${emailAddr || id}?`)) return;
        try { await userAPI.disconnectGmailImapMailbox(id); setMsg(`Removed ${emailAddr}`); await refresh(); }
        catch (err) { setMsg(err?.response?.data?.error || err?.message || 'Remove failed'); }
    };

    const removeAll = async () => {
        if (!window.confirm('Disconnect ALL Gmail mailboxes?')) return;
        try { await userAPI.disconnectGmailImap(); setMsg('All Gmail mailboxes removed'); await refresh(); }
        catch (err) { setMsg(err?.response?.data?.error || err?.message || 'Remove-all failed'); }
    };

    const syncMailbox = async (id) => {
        setSyncingId(id);
        try { await userAPI.syncGmailImap({ mailbox_id: id }); await refresh(); }
        catch (err) { setMsg(err?.response?.data?.error || err?.message || 'Sync failed'); }
        finally { setSyncingId(null); }
    };

    const enabledCount = mailboxes.filter((m) => m.enabled).length;
    const totalCount = mailboxes.length;
    const connectLabel = busy ? 'Connecting...' : (totalCount === 0 ? 'Connect Gmail' : 'Add another Gmail');

return (
        <div className={`space-y-3 rounded-lg border border-border/60 bg-background/40 px-3 py-3 ${className}`}>
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Google Gmail / IMAP (free)
                    {totalCount > 0 && (
                        <span className="ml-2 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                            {enabledCount > 0 ? `${enabledCount} connected` : `${totalCount} disabled`}
                        </span>
                    )}
                </span>
                {totalCount > 0 && (
                    <Button type="button" size="sm" variant="ghost" className="h-6 text-xs" disabled={busy} onClick={removeAll}>
                        Remove all
                    </Button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                Connect Gmail inboxes via a Google App Password (free, no Google Cloud setup).
                All connected mailboxes are searched for OTPs together — same code path as Outlook.
            </p>
            <div className="rounded border border-border/60 bg-background/60 p-2 text-[11px] text-muted-foreground">
                <p className="mb-1 font-semibold text-foreground">One-time setup per Gmail account:</p>
                <ol className="list-decimal space-y-1 pl-4">
                    <li>
                        Enable{' '}
                        <a href="https://myaccount.google.com/security" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-blue-400 underline hover:text-blue-300">
                            2-Step Verification
                            <ExternalLink className="inline h-3 w-3" />
                        </a>{' '}
                        on the Google Account.
                    </li>
                    <li>
                        Create an{' '}
                        <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-blue-400 underline hover:text-blue-300">
                            App Password
                            <ExternalLink className="inline h-3 w-3" />
                        </a>{' '}
                        (select "Mail" or "Other (custom name)" → "Lumi"). Google gives you a{' '}
                        <strong className="text-foreground">16-character code</strong>.
                    </li>
                    <li>Fill the form below and click Connect.</li>
                </ol>
                <p className="mt-1">
                    IMAP: <code className="rounded bg-background px-1 text-foreground">imap.gmail.com:993</code> (SSL).
                </p>
            </div>
            {totalCount > 0 ? (
                <ul className="space-y-1.5">
                    {mailboxes.map((m) => (
                        <li key={m.id || m.email} className="flex items-center justify-between gap-2 rounded border border-border/40 bg-background/30 px-2.5 py-1.5">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                <Mail className="h-3 w-3 text-blue-400" />
                                <span className="truncate text-xs font-medium">{m.email || 'Mailbox'}</span>
                                <span className="text-[10px] text-muted-foreground">{m.enabled ? 'connected' : 'disabled'}</span>
                                {m.last_sync_at && (
                                    <span className="text-[10px] text-muted-foreground">synced {new Date(m.last_sync_at).toLocaleString()}</span>
                                )}
                                {m.last_error && (
                                    <span className="text-[10px] text-amber-300/90" title={m.last_error}>
                                        {m.last_error.length > 60 ? `${m.last_error.slice(0, 60)}…` : m.last_error}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1">
                                <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[10px]" disabled={syncingId === m.id || busy} onClick={() => syncMailbox(m.id)} title="Force a sync right now">
                                    <RefreshCw className={`mr-1 h-3 w-3 ${syncingId === m.id ? 'animate-spin' : ''}`} />
                                    Sync
                                </Button>
                                <Button type="button" size="sm" variant="ghost" className="h-5 w-5 p-0" disabled={busy} onClick={() => removeMailbox(m.id, m.email)} title="Remove">
                                    <Trash2 className="h-3 w-3" />
                                </Button>
                            </div>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-xs text-muted-foreground">No Gmail mailboxes connected yet.</p>
            )}
            <p className="text-[10px] text-muted-foreground">
                Google limits concurrent IMAP connections per account to ~15.
            </p>
            {!showForm ? (
                <Button type="button" size="sm" onClick={() => { setShowForm(true); setMsg(''); }}>
                    <Plus className="mr-1 h-3 w-3" />
                    {connectLabel}
                </Button>
            ) : (
                <form onSubmit={connect} className="space-y-2 rounded border border-border/60 bg-background/60 p-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]">
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Gmail address</label>
                            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" className="rounded border border-border bg-background px-2 py-1 text-xs" autoComplete="username" />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">App Password (16 chars)</label>
                            <div className="flex gap-1">
                                <input type={showPassword ? 'text' : 'password'} value={appPassword} onChange={(e) => setAppPassword(e.target.value)} placeholder="abcd efgh ijkl mnop" className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs" autoComplete="new-password" maxLength={24} />
                                <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setShowPassword((v) => !v)} title={showPassword ? 'Hide' : 'Show'}>
                                    {showPassword ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                                </Button>
                            </div>
                        </div>
                        <div className="flex items-end gap-1">
                            <Button type="submit" size="sm" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => { setShowForm(false); setEmail(''); setAppPassword(''); setMsg(''); }} disabled={busy}>Cancel</Button>
                        </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                        Paste the 16-char Google App Password (spaces are stripped). The password is encrypted with AES-256-GCM at rest. IMAP host: <code className="rounded bg-background px-1 text-foreground">imap.gmail.com:993</code>.
                    </p>
                </form>
            )}
            {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        </div>
    );
}
