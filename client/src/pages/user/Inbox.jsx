'use client';

import { useState, useEffect, useCallback } from 'react';
import { userAPI } from '../../api';
import { RefreshCw, Mail, Search, Trash2, ExternalLink, CheckCircle, AlertCircle } from 'lucide-react';

export default function Inbox() {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState(null);
    const [selectedMsg, setSelectedMsg] = useState(null);
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState(null);
    const [accounts, setAccounts] = useState([]);

    const fetchMessages = useCallback(async () => {
        try {
            const res = await userAPI.listOutlookMessages({ limit: 50 });
            setMessages(res.data?.messages || []);
            setError(null);
        } catch (err) {
            setError(err?.response?.data?.error || 'Failed to load messages');
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchStatus = useCallback(async () => {
        try {
            const res = await userAPI.getOutlookStatus();
            setStatus(res.data);
            setAccounts(res.data?.accounts || []);
        } catch (err) {
            console.error('Failed to fetch status:', err);
        }
    }, []);

    useEffect(() => {
        fetchMessages();
        fetchStatus();
    }, [fetchMessages, fetchStatus]);

    const handleSync = async () => {
        setSyncing(true);
        try {
            await userAPI.syncOutlook();
            await fetchMessages();
            await fetchStatus();
        } catch (err) {
            setError(err?.response?.data?.error || 'Sync failed');
        } finally {
            setSyncing(false);
        }
    };

    const filteredMessages = messages.filter(msg => {
        if (!search) return true;
        const s = search.toLowerCase();
        return (
            (msg.subject || '').toLowerCase().includes(s) ||
            (msg.from_address || '').toLowerCase().includes(s) ||
            (msg.from_name || '').toLowerCase().includes(s) ||
            (msg.body_preview || '').toLowerCase().includes(s)
        );
    });

    const formatDate = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        const now = new Date();
        const diff = now - d;
        if (diff < 86400000 && d.getDate() === now.getDate()) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        if (diff < 604800000) {
            return d.toLocaleDateString([], { weekday: 'short' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const getOtpBadge = (msg) => {
        if (!msg.otp_code) return null;
        return (
            <span className="ml-2 rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs font-mono text-emerald-400">
                OTP: {msg.otp_code}
            </span>
        );
    };

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-muted-foreground">Loading inbox...</div>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3">
                <div className="flex items-center gap-3">
                    <h1 className="text-lg font-semibold">Inbox</h1>
                    {accounts.length > 0 && (
                        <div className="flex gap-1">
                            {accounts.map(acc => (
                                <span key={acc.id} className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-400">
                                    {acc.email || acc.display_name}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSync}
                        disabled={syncing}
                        className="btn btn-secondary btn-sm flex items-center gap-1"
                    >
                        <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                        {syncing ? 'Syncing...' : 'Sync'}
                    </button>
                </div>
            </div>

            {/* Search */}
            <div className="flex-shrink-0 border-b border-border px-4 py-2">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                        type="text"
                        placeholder="Search emails..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="w-full rounded border border-border bg-background py-1.5 pl-9 pr-3 text-sm outline-none focus:border-primary"
                    />
                </div>
            </div>

            {/* Content */}
            <div className="flex flex-1 overflow-hidden">
                {/* Message List */}
                <div className="flex w-80 flex-shrink-0 flex-col border-r border-border overflow-y-auto">
                    {filteredMessages.length === 0 ? (
                        <div className="flex flex-1 flex-col items-center justify-center p-4 text-center text-muted-foreground">
                            <Mail className="mb-2 h-8 w-8 opacity-50" />
                            <p className="text-sm">No messages found</p>
                            {!status?.configured && (
                                <p className="mt-2 text-xs">
                                    Set OUTLOOK_CLIENT_ID in server/.env to connect mailboxes
                                </p>
                            )}
                        </div>
                    ) : (
                        filteredMessages.map(msg => (
                            <button
                                key={msg.id}
                                onClick={() => setSelectedMsg(msg)}
                                className={`flex flex-col border-b border-border p-3 text-left transition-colors hover:bg-accent ${
                                    selectedMsg?.id === msg.id ? 'bg-accent' : ''
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <span className={`truncate text-sm font-medium ${msg.is_read ? 'text-muted-foreground' : 'text-foreground'}`}>
                                        {msg.from_name || msg.from_address || 'Unknown'}
                                    </span>
                                    <span className="flex-shrink-0 text-xs text-muted-foreground">
                                        {formatDate(msg.received_at)}
                                    </span>
                                </div>
                                <div className={`mt-0.5 truncate text-xs ${msg.is_read ? 'text-muted-foreground' : 'text-foreground'}`}>
                                    {msg.subject || '(No subject)'}
                                </div>
                                <div className="mt-0.5 flex items-center gap-2">
                                    <span className="truncate text-xs text-muted-foreground">
                                        {msg.body_preview?.slice(0, 50)}...
                                    </span>
                                    {msg.otp_code && (
                                        <span className="flex-shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs font-mono text-emerald-400">
                                            {msg.otp_code}
                                        </span>
                                    )}
                                </div>
                            </button>
                        ))
                    )}
                </div>

                {/* Message Detail */}
                <div className="flex flex-1 flex-col overflow-hidden">
                    {selectedMsg ? (
                        <>
                            <div className="flex-shrink-0 border-b border-border p-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <h2 className="text-lg font-semibold">{selectedMsg.subject || '(No subject)'}</h2>
                                        <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                                            <span>from: {selectedMsg.from_name || selectedMsg.from_address}</span>
                                            <span>{'<'}{selectedMsg.from_address}{'>'}</span>
                                        </div>
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {selectedMsg.received_at && new Date(selectedMsg.received_at).toLocaleString()}
                                        </div>
                                    </div>
                                    {selectedMsg.otp_code && (
                                        <div className="flex-shrink-0 rounded-lg bg-emerald-500/20 p-3 text-center">
                                            <div className="text-xs text-emerald-400/80">OTP Code</div>
                                            <div className="mt-1 font-mono text-2xl font-bold text-emerald-400">
                                                {selectedMsg.otp_code}
                                            </div>
                                            <button
                                                onClick={() => navigator.clipboard.writeText(selectedMsg.otp_code)}
                                                className="mt-2 text-xs text-emerald-400/80 hover:text-emerald-400"
                                            >
                                                Copy
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="flex-1 overflow-y-auto p-4">
                                <pre className="whitespace-pre-wrap text-sm">{selectedMsg.body_text || selectedMsg.body_preview}</pre>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-1 items-center justify-center text-muted-foreground">
                            <div className="text-center">
                                <Mail className="mx-auto mb-2 h-12 w-12 opacity-30" />
                                <p>Select a message to read</p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
