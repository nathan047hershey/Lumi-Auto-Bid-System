import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { adminAPI } from "@/api";
import AppPage from "@/components/AppPage";
import { PageLoader } from "@/components/Loader";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Mail, Search, RefreshCw, User, Trash2, Inbox, Plus, X, CheckCircle2, AlertCircle, ExternalLink } from "lucide-react";

export default function AdminMailboxes() {
    const [loading, setLoading] = useState(true);
    const [mailboxes, setMailboxes] = useState({ outlook: [], gmail: [] });
    const [messages, setMessages] = useState([]);
    const [loadingMessages, setLoadingMessages] = useState(false);
    const [selectedMailbox, setSelectedMailbox] = useState(null);
    const [selectedType, setSelectedType] = useState("outlook");
    const [syncing, setSyncing] = useState(false);
    const [search, setSearch] = useState("");
    const [error, setError] = useState(null);

    // Add Mailbox modal state
    const [addModalOpen, setAddModalOpen] = useState(false);
    const [addProvider, setAddProvider] = useState("outlook"); // outlook | gmail
    const [addEmail, setAddEmail] = useState("");
    const [addBusy, setAddBusy] = useState(false);
    const [addStatus, setAddStatus] = useState(null); // { type: 'success'|'error', message: '' }
    const watchingPopup = useRef({ active: false, popup: null });
    const loadMailboxes = useCallback(async () => {
        try { setLoading(true);
            const res = await adminAPI.getAllMailboxes();
            setMailboxes(res.data || { outlook: [], gmail: [] });
            setError(null);
        } catch (err) { setError(err?.response?.data?.error || "Failed"); }
        finally { setLoading(false); }
    }, []);
    const [selectedFolder, setSelectedFolder] = useState('all');

    const loadMessages = useCallback(async (id, type, folder = selectedFolder) => {
        setLoadingMessages(true);
        try {
            const params = { mailbox_id: id, type, limit: 100 };
            // Outlook supports the folder filter; Gmail doesn't
            // (IMAP doesn't expose well-known Graph folders).
            if (type === 'outlook' && folder && folder !== 'all') {
                params.folder = folder;
            }
            const res = await adminAPI.getAllOutlookMessages(params);
            setMessages(res.data?.messages || []);
        } catch (err) { setMessages([]); }
        finally { setLoadingMessages(false); }
    }, [selectedFolder]);
    useEffect(() => { loadMailboxes(); }, [loadMailboxes]);
    useEffect(() => {
        if (selectedMailbox) loadMessages(selectedMailbox, selectedType, selectedFolder);
        else setMessages([]);
    }, [selectedMailbox, selectedType, selectedFolder, loadMessages]);

    // Listen for postMessage from OAuth popup to refresh mailbox list
    useEffect(() => {
        const handler = (event) => {
            if (event.data && event.data.type === 'outlook-auth-complete') {
                if (event.data.ok) {
                    // The popup HTML may carry a "warning" if Microsoft
                    // signed the user in with a different account than
                    // the one they typed in `login_hint`. Show it as
                    // info rather than success in that case.
                    if (event.data.warning) {
                        // Strip the leading <strong> tags for the
                        // toast-level message. Use 'info' type so
                        // it doesn't look like a hard failure.
                        setAddStatus({
                            type: 'info',
                            message: `Connected ${event.data.email || 'mailbox'}. Note: ${String(event.data.warning).replace(/<[^>]+>/g, '')}`
                        });
                    } else {
                        setAddStatus({ type: 'success', message: `Connected ${event.data.email || 'mailbox'}!` });
                    }
                    loadMailboxes(); // Refresh the list
                } else {
                    setAddStatus({ type: 'error', message: event.data.message || 'Connection failed' });
                }
                setAddBusy(false);
                watchingPopup.current = { active: false, popup: null };
            }
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [loadMailboxes]);

    // Poll for new mailbox while popup is open (fallback if postMessage fails)
    //
    // IMPORTANT: we compare not only counts but a fingerprint of every
    // mailbox (id + email + updated_at / connected_at). Microsoft's OAuth
    // consent is "sticky" — re-authenticating the same account skips the
    // consent screen, redirects the popup back to /callback within ~1s,
    // and updates tokens in-place on the server. The mailbox *count*
    // stays identical in that case, so a naive count-based poll would
    // never resolve — leaving the UI stuck on "Connecting...".
    useEffect(() => {
        if (!watchingPopup.current?.active) return;

        // Build a fingerprint map: id -> `${email}|${updated_at || ''}`
        const fingerprint = (data) => {
            const all = [
                ...(data.outlook || []).map((m) => m),
                ...(data.gmail || []).map((m) => m)
            ];
            const map = {};
            for (const m of all) {
                if (!m || m.id == null) continue;
                map[String(m.id)] = `${m.email || ''}|${m.updated_at || m.connected_at || ''}`;
            }
            return map;
        };

        const startFp = fingerprint(mailboxes);
        let lastSeenNewFp = null;
        let resolved = false;

        const resolveNow = (message) => {
            if (resolved) return;
            resolved = true;
            setMailboxes((cur) => cur); // no-op to keep state shape
            setAddStatus({ type: 'success', message });
            setAddBusy(false);
            watchingPopup.current = { active: false, popup: null };
            clearInterval(interval);
            clearTimeout(ceiling);
            clearInterval(closePoll);
        };

        // Two-phase polling:
        // 1) fingerprint poll: detect new/changed mailboxes
        // 2) popup-close poll: detect when the popup window closes
        //    (e.g., user pressed Cancel, popup auto-closed after 5s,
        //    Microsoft silently completed). Combined, the UI can never
        //    get stuck.
        const interval = setInterval(async () => {
            try {
                const res = await adminAPI.getAllMailboxes();
                const newData = res.data || { outlook: [], gmail: [] };
                const newFp = fingerprint(newData);

                // Detect any mailboxes that didn't exist when we started
                // watching.
                const addedIds = Object.keys(newFp).filter((id) => !(id in startFp));
                // Detect fingerprints that changed (token refresh).
                const updatedIds = Object.keys(newFp).filter(
                    (id) => (id in startFp) && startFp[id] !== newFp[id]
                );

                if (addedIds.length > 0 || updatedIds.length > 0) {
                    lastSeenNewFp = newFp;
                    setMailboxes(newData);
                    resolveNow(
                        addedIds.length > 0
                            ? 'New mailbox connected!'
                            : 'Mailbox tokens refreshed.'
                    );
                }
            } catch (_) {
                /* ignore transient errors */
            }
        }, 2000);

        // If the popup window goes away, treat as completion (Microsoft's
        // makeCallbackHtml auto-closes it 5s after success). The UI gets
        // unstuck regardless of whether the postMessage event fired.
        const closePoll = setInterval(() => {
            if (resolved) return;
            const popup = watchingPopup.current?.popup;
            if (popup && popup.closed) {
                resolveNow('Connection attempt complete. Verify the mailbox appears in the list.');
            }
        }, 1000);

        // Hard ceiling: 5 minutes after popup opens. Authorize ourselves
        // out of any "stuck" state regardless of fingerprint activity.
        const ceiling = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                setAddStatus({
                    type: 'success',
                    message: 'Connection attempt complete (timed out waiting for confirmation). Verify the mailbox appears in the list.'
                });
                setAddBusy(false);
                watchingPopup.current = { active: false, popup: null };
                clearInterval(interval);
                clearInterval(closePoll);
            }
        }, 5 * 60 * 1000);

        return () => {
            clearInterval(interval);
            clearInterval(closePoll);
            clearTimeout(ceiling);
        };
    }, [mailboxes, addBusy]);
    const allMailboxes = useMemo(() => {
        const o = (mailboxes.outlook||[]).map(m => ({...m, type: "outlook"}));
        const g = (mailboxes.gmail||[]).map(m => ({...m, type: "gmail"}));
        return [...o, ...g];
    }, [mailboxes]);
    const filteredMailboxes = useMemo(() => {
        if (!search.trim()) return allMailboxes;
        const q = search.toLowerCase();
        return allMailboxes.filter(m =>
            (m.email||"").includes(q)||(m.display_name||"").includes(q)||(m.user||"").includes(q));
    }, [allMailboxes, search]);
    const filteredMessages = useMemo(() => {
        if (!search.trim()) return messages;
        const q = search.toLowerCase();
        return messages.filter(m =>
            (m.subject||"").includes(q)||(m.from_address||"").includes(q)||(m.body_text||"").includes(q));
    }, [messages, search]);
    const handleSync = async (id, type) => {
        setSyncing(true);
        try {
            await adminAPI.syncMailbox(id, type);
            await loadMailboxes();
            if (selectedMailbox===id) await loadMessages(id, type);
        } catch (err) { setError(err?.response?.data?.error || "Sync failed"); }
        finally { setSyncing(false); }
    };
    const handleDisconnect = async (id, type, email) => {
        if (!window.confirm(`Disconnect ${email||id}?`)) return;
        try {
            await adminAPI.disconnectMailbox(id, type);
            if (selectedMailbox===id) { setSelectedMailbox(null); setMessages([]); }
            await loadMailboxes();
        } catch (err) { setError(err?.response?.data?.error || "Disconnect failed"); }
    };

    // Open the Add Mailbox modal
    const openAddModal = () => {
        setAddModalOpen(true);
        setAddProvider("outlook");
        setAddEmail("");
        setAddStatus(null);
        setAddBusy(false);
    };

    // Close the Add Mailbox modal
    const closeAddModal = () => {
        if (addBusy) return; // Don't close while popup is open
        setAddModalOpen(false);
        setAddStatus(null);
    };

    // Handle adding an Outlook mailbox via OAuth popup
    const handleAddOutlookMailbox = async () => {
        if (!addEmail || !addEmail.includes('@')) {
            setAddStatus({ type: 'error', message: 'Please enter a valid email address' });
            return;
        }
        setAddBusy(true);
        setAddStatus({ type: 'info', message: 'Building auth URL...' });
        try {
            // Call the JSON endpoint which is auth'd (gets the authorize URL)
            const response = await adminAPI.getOutlookAuthUrl({
                login_hint: addEmail.trim(),
                select_account: true
            });
            // Backwards-compatible: old helper unwrapped to r.data; new
            // helper returns the raw axios response. Accept both shapes.
            const urlData = response && typeof response === 'object' && 'data' in response
                ? response.data
                : response;
            if (!urlData || !urlData.authorizeUrl) {
                setAddStatus({
                    type: 'error',
                    message: 'Server did not return an authorize URL. Check that OUTLOOK_CLIENT_ID is set on the backend.'
                });
                setAddBusy(false);
                return;
            }
            setAddStatus({ type: 'info', message: 'Opening Microsoft sign-in popup...' });
            // Open popup with a unique window name so successive clicks
            // don't reuse a closed popup (browsers would otherwise focus
            // an already-closed `outlook-auth` window). The unique name
            // also forces a fresh window, avoiding stale state from a
            // previous Microsoft session pre-fill.
            const popupName = `outlook-auth-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const popup = window.open(urlData.authorizeUrl, popupName, 'width=520,height=720,noopener,noreferrer');
            if (!popup) {
                setAddStatus({ type: 'error', message: 'Popup blocked. Please allow popups for this site.' });
                setAddBusy(false);
                return;
            }
            watchingPopup.current = { active: true, popup };
            // Safety timeout: stop watching after 5 minutes
            setTimeout(() => {
                if (watchingPopup.current?.active) {
                    watchingPopup.current = { active: false, popup: null };
                    setAddBusy(false);
                    setAddStatus({
                        type: 'success',
                        message: 'Connection attempt finished. Verify the mailbox appears in the list.'
                    });
                }
            }, 5 * 60 * 1000);
        } catch (err) {
            setAddStatus({ type: 'error', message: err.response?.data?.error || err.message || 'Failed to start auth' });
            setAddBusy(false);
        }
    };

    // Handle adding a Gmail mailbox (shows IMAP setup instructions)
    const handleAddGmailMailbox = () => {
        setAddStatus({
            type: 'info',
            message: 'Gmail connection requires an App Password. Open Admin → Settings → Mailboxes → Google Gmail tab to set up.'
        });
    };
    const formatDate = (iso) => {
        if (!iso) return "";
        const d = new Date(iso);
        return d.toLocaleDateString()+" "+d.toLocaleTimeString([],[{hour:"2-digit",minute:"2-digit"}]);
    };
    if (loading) return <PageLoader />;
    return (<AppPage title="Mail Management" icon={Mail}><div className="flex h-[calc(100vh-8rem)] gap-4"><div className="w-80 flex-shrink-0 flex flex-col"><div className="mb-3 flex items-center gap-2"><div className="relative flex-1"><Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full rounded border border-border bg-background pl-8 pr-3 py-1.5 text-sm" /></div><Button size="sm" variant="ghost" onClick={loadMailboxes} disabled={loading}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /></Button></div><Button size="sm" variant="default" className="mb-3 w-full" onClick={openAddModal}><Plus className="mr-1 h-4 w-4" />Add Mailbox</Button><div className="flex-1 overflow-y-auto space-y-1">{filteredMailboxes.length===0?(<p className="text-sm text-muted-foreground text-center py-4">No mailboxes</p>):(filteredMailboxes.map((m)=>(<button key={m.type+"-"+m.id} onClick={()=>{setSelectedMailbox(m.id);setSelectedType(m.type);}} className={cn('w-full text-left rounded-lg border p-3',selectedMailbox===m.id?'border-primary bg-primary/10':'border-border/60 bg-background/40 hover:bg-background/60')}><div className="flex items-start justify-between gap-2"><div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{m.email||m.display_name||'Unknown'}</p><p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5"><User className="h-3 w-3"/>{m.user||'Unknown'}</p><span className={cn('text-[10px] px-1.5 py-0.5 rounded mt-1 inline-block',m.type==='outlook'?'bg-blue-500/20 text-blue-400':'bg-red-500/20 text-red-400')}>{m.type.toUpperCase()}</span></div><div className="flex flex-col gap-1"><Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={(e)=>{e.stopPropagation();handleSync(m.id,m.type);}} disabled={syncing} title="Sync"><RefreshCw className="h-3 w-3"/></Button><Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-400" onClick={(e)=>{e.stopPropagation();handleDisconnect(m.id,m.type,m.email);}} title="Remove"><Trash2 className="h-3 w-3"/></Button></div></div></button>)))}</div></div><div className="flex-1 flex flex-col overflow-hidden rounded-lg border border-border/60 bg-background/40"><div className="flex-shrink-0 border-b border-border/60 p-3 flex items-center justify-between"><h3 className="text-sm font-medium flex items-center gap-2"><Inbox className="h-4 w-4"/>{selectedMailbox?'Messages':'Select a mailbox'}</h3>
            <div className="flex items-center gap-2">
                {/* Folder filter — Outlook has multiple Graph folders
                    (inbox / junk / sent / drafts / …). Admins can pick
                    "Junk" to find messages auto-routed there. */}
                {selectedMailbox && selectedType === 'outlook' && (
                    <select
                        value={selectedFolder}
                        onChange={(e) => setSelectedFolder(e.target.value)}
                        title="Filter by Microsoft Graph folder"
                        className="rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                    >
                        <option value="all">All folders</option>
                        <option value="inbox">📥 Inbox</option>
                        <option value="junk">⚠️ Junk</option>
                        <option value="sent">📤 Sent</option>
                        <option value="drafts">📝 Drafts</option>
                        <option value="deleted">🗑 Deleted</option>
                        <option value="archive">📦 Archive</option>
                        <option value="other">📂 Other</option>
                    </select>
                )}
                {selectedMailbox&&<Button size="sm" variant="ghost" onClick={()=>loadMessages(selectedMailbox,selectedType)} disabled={loadingMessages}><RefreshCw className={cn('h-4 w-4',loadingMessages&&'animate-spin')}/></Button>}
            </div></div><div className="flex-1 overflow-y-auto">{!selectedMailbox?(<div className="flex h-full items-center justify-center text-muted-foreground"><div className="text-center"><Mail className="mx-auto mb-2 h-12 w-12 opacity-30"/><p className="text-sm">Select a mailbox</p></div></div>):loadingMessages?(<div className="flex h-full items-center justify-center"><RefreshCw className="h-6 w-6 animate-spin text-muted-foreground"/></div>):filteredMessages.length===0?(<div className="flex h-full items-center justify-center text-muted-foreground"><p className="text-sm">No messages</p></div>):filteredMessages.map((msg,idx)=>(<div key={msg.id||idx} className="p-3 hover:bg-background/60 border-b border-border/30"><div className="flex items-start justify-between gap-2"><div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{msg.subject||'(No subject)'}</p><p className="text-xs text-muted-foreground truncate">from: {msg.from_name||msg.from_address}</p></div><span className="text-[10px] text-muted-foreground whitespace-nowrap">{formatDate(msg.received_at)}</span></div><p className="text-xs text-muted-foreground mt-1 line-clamp-2">{msg.body_preview||msg.body_text||''}</p>{msg.otp_code&&<span className="mt-1 inline-block rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs font-mono text-emerald-400">OTP: {msg.otp_code}</span>}</div>))}</div></div></div>{error&&<div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

        {/* Add Mailbox Modal */}
        {addModalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={closeAddModal}>
                <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
                    <div className="mb-4 flex items-center justify-between">
                        <h2 className="text-lg font-semibold flex items-center gap-2">
                            <Plus className="h-5 w-5" />
                            Add New Mailbox
                        </h2>
                        <Button size="sm" variant="ghost" onClick={closeAddModal} disabled={addBusy}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>

                    {/* Provider tabs */}
                    <div className="mb-4 flex gap-2">
                        <button
                            type="button"
                            onClick={() => { setAddProvider("outlook"); setAddStatus(null); }}
                            disabled={addBusy}
                            className={cn(
                                "flex-1 rounded border px-3 py-2 text-sm transition-colors",
                                addProvider === "outlook"
                                    ? "border-blue-500 bg-blue-500/10 text-blue-400"
                                    : "border-border bg-background hover:bg-background/60"
                            )}
                        >
                            <Mail className="mr-1 inline h-4 w-4" />
                            Microsoft Outlook
                        </button>
                        <button
                            type="button"
                            onClick={() => { setAddProvider("gmail"); setAddStatus(null); }}
                            disabled={addBusy}
                            className={cn(
                                "flex-1 rounded border px-3 py-2 text-sm transition-colors",
                                addProvider === "gmail"
                                    ? "border-red-500 bg-red-500/10 text-red-400"
                                    : "border-border bg-background hover:bg-background/60"
                            )}
                        >
                            <Mail className="mr-1 inline h-4 w-4" />
                            Google Gmail
                        </button>
                    </div>

                    {/* Outlook form */}
                    {addProvider === "outlook" && (
                        <div className="space-y-4">
                            <div>
                                <label className="mb-1 block text-sm font-medium">Email address</label>
                                <input
                                    type="email"
                                    placeholder="user@outlook.com"
                                    value={addEmail}
                                    onChange={(e) => setAddEmail(e.target.value)}
                                    disabled={addBusy}
                                    className="w-full rounded border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
                                />
                                <p className="mt-1 text-[11px] text-muted-foreground">
                                    Pre-fills the Microsoft sign-in email. You'll still get an account picker.
                                </p>
                            </div>

                            <div className="rounded border border-border/60 bg-background/40 p-3 text-[11px] text-muted-foreground">
                                <p className="mb-1 font-semibold">Required permissions:</p>
                                <ul className="ml-4 list-disc space-y-0.5">
                                    <li>User.Read (sign in &amp; read profile)</li>
                                    <li>Mail.Read (read emails)</li>
                                    <li>offline_access (keep tokens refreshed)</li>
                                </ul>
                            </div>

                            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-200">
                                <p className="mb-1 font-semibold">⚠️ Wrong email pre-filled by Microsoft?</p>
                                <p className="text-amber-300/90">
                                    Microsoft may show the currently-signed-in browser account (e.g.
                                    <span className="ml-1 font-mono">brandon@…</span>) instead of the
                                    address you typed above. If that happens, click
                                    <span className="mx-1 font-semibold">Use another account</span>
                                    on the Microsoft page, or open the popup in a private/incognito
                                    window (<span className="font-mono">Ctrl+Shift+N</span>).
                                </p>
                            </div>

                            <Button
                                type="button"
                                className="w-full"
                                onClick={handleAddOutlookMailbox}
                                disabled={addBusy || !addEmail.includes('@')}
                            >
                                <ExternalLink className="mr-2 h-4 w-4" />
                                {addBusy ? 'Connecting...' : 'Open Microsoft Sign-In'}
                            </Button>
                        </div>
                    )}

                    {/* Gmail form */}
                    {addProvider === "gmail" && (
                        <div className="space-y-4">
                            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                                <p className="mb-1 font-semibold">Gmail requires an App Password</p>
                                <p className="text-amber-300/90">
                                    Google no longer supports plain password sign-in for IMAP. You need to create an App Password from your Google Account security settings.
                                </p>
                            </div>

                            <Button
                                type="button"
                                variant="outline"
                                className="w-full"
                                onClick={handleAddGmailMailbox}
                            >
                                <ExternalLink className="mr-2 h-4 w-4" />
                                Open Gmail Setup Instructions
                            </Button>
                        </div>
                    )}

                    {/* Status message */}
                    {addStatus && (
                        <div className={cn(
                            "mt-4 flex items-start gap-2 rounded border p-3 text-xs",
                            addStatus.type === 'success' && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                            addStatus.type === 'error' && "border-red-500/30 bg-red-500/10 text-red-400",
                            addStatus.type === 'info' && "border-blue-500/30 bg-blue-500/10 text-blue-300"
                        )}>
                            {addStatus.type === 'success' && <CheckCircle2 className="h-4 w-4 flex-shrink-0" />}
                            {addStatus.type === 'error' && <AlertCircle className="h-4 w-4 flex-shrink-0" />}
                            {addStatus.type === 'info' && <RefreshCw className="h-4 w-4 flex-shrink-0 animate-spin" />}
                            <span>{addStatus.message}</span>
                        </div>
                    )}
                </div>
            </div>
        )}
    </AppPage>);}