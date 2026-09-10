/**
 * Floating Auto Bidder Control Panel — draggable, bottom-right by default.
 * Process / Stop / CAPTCHA controls, CV view/edit, live screenshot feed, timing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    Camera,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ExternalLink,
    FileText,
    GripVertical,
    Maximize2,
    Minimize2,
    Pencil,
    Play,
    Pause,
    Plus,
    RefreshCw,
    SkipForward,
    Square,
    Trash2,
    X
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import BidProgressBar from '@/components/job-links/BidProgressBar';
import { runStatusBadgeClass, runStatusBannerClass, runStatusHeadline, formatTotalElapsed } from '@/lib/bidCourseFailure';
import { shortenNotifyText, shortenOutcomeLabel } from '@/lib/bidderNotifyCopy';
import TeachAndCheckPanel from '@/components/TeachAndCheckPanel';

const POS_KEY = 'lumi_bid_monitor_pos_v2';
/** Wide enough to read Greenhouse form fields in the live frame. */
const DOCK_W = 560;
const DOCK_H_MIN = 56;

function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

function defaultPos() {
    if (typeof window === 'undefined') return { x: 16, y: 16 };
    // Keep near top-right so the full panel (answers + live frame) fits on screen.
    return {
        x: Math.max(16, window.innerWidth - DOCK_W - 20),
        y: 16
    };
}

function loadPos() {
    try {
        const raw = localStorage.getItem(POS_KEY);
        if (!raw) return defaultPos();
        const p = JSON.parse(raw);
        if (typeof p?.x === 'number' && typeof p?.y === 'number') {
            const maxY = Math.max(8, window.innerHeight - 120);
            return {
                x: clamp(p.x, 8, Math.max(8, window.innerWidth - 120)),
                y: clamp(p.y, 8, maxY)
            };
        }
    } catch (_) { /* ignore */ }
    return defaultPos();
}

export default function BidMonitorDock({
    open,
    minimized,
    onMinimizedChange,
    onClose,
    onExpandDialog,
    onFullscreen,
    title,
    subtitle,
    statusLine,
    statusComment = '',
    shotStage,
    imgSrc,
    imgErr,
    loading,
    updatedLabel,
    lastRefreshedAt = null,
    frameIndex = 0,
    frameCount = 0,
    onPrevFrame,
    onNextFrame,
    followLive = true,
    onFollowLive,
    progressPct = 0,
    progressLabel = '',
    progressTone = 'sky',
    progressStepIndex = -1,
    /** Manual bid controls (wired from Auto Bidder). */
    controlsBusy = false,
    awaitingCaptcha = false,
    captchaTabMissing = false,
    queueRunning = false,
    queuePaused = false,
    /** Notification feed (newest first) — from Setup mergeNotifFeeds */
    notifFeed = [],
    onClearNotifs = null,
    /** Owned apply tab identity for Focus vs reopen */
    ownedTabId = null,
    ownedTabUrl = '',
    ownedTabMapped = false,
    successConfirming = false,
    hostLessons = [],
    onToggleLesson = null,
    openTabLabel = 'Open',
    onOpenApplyTab,
    onResumeCaptcha,
    onSkipCaptcha,
    onReAutofill,
    onUpdateState = null,
    onSubmitApply = null,
    onInstructLumi = null,
    coachStatus = '',
    onNextJob,
    onPauseQueue = null,
    onResumeQueue = null,
    onStopQueue,
    /** Start / restart queue from the panel (dialog may be closed). */
    onProcess = null,
    canProcess = false,
    processLabel = 'Process',
    /** Current course CV — View opens PDF/download; Edit opens Resume Generator. */
    cvFilename = '',
    cvDownloadUrl = '',
    cvEditHref = '',
    /** Editable bid answers (control panel → fill on apply tab). */
    courseAnswers = [],
    onListFormQuestions = null,
    onApplyAnswers = null,
    /** success | filled | failed | attention | running | unknown */
    outcomeKind = '',
    outcomeShort = '',
    outcomeLabel = '',
    /** ISO / ms — Auto Bidder start (Process / queue_started), not CV generation. */
    jobStartedAt = null,
    /** ISO / ms — when job finished (stops the job clock). */
    jobEndedAt = null,
    /** ISO / ms — answers_generating → bidder_answers_ready. */
    answersStartedAt = null,
    answersEndedAt = null,
    answersQuestionCount = 0,
    answersReadyCount = 0,
    /** ms — queue start from Lumi (live clock across jobs). */
    queueStartedAt = null,
    /** ms — when queue finished. */
    queueEndedAt = null,
    /** 1-based job index in queue */
    queueIndex = 0,
    queueTotal = 0
}) {
    const [mounted, setMounted] = useState(false);
    const [pos, setPos] = useState(() => ({ x: 16, y: 16 }));
    const [, setTick] = useState(0);
    const dragRef = useRef(null);
    const [answerDrafts, setAnswerDrafts] = useState([]);
    const [answersBusy, setAnswersBusy] = useState(false);
    const [answersMsg, setAnswersMsg] = useState('');
    const answersSigRef = useRef('');
    const [dockTab, setDockTab] = useState('live'); // live | manual
    const [instructText, setInstructText] = useState('');
    const [instructBusy, setInstructBusy] = useState(false);
    const [instructMsg, setInstructMsg] = useState('');

    useEffect(() => {
        setMounted(true);
        setPos(loadPos());
    }, []);

    useEffect(() => {
        const list = Array.isArray(courseAnswers) ? courseAnswers : [];
        const sig = list.map((a) => `${a?.id}|${a?.label}|${a?.answer || a?.value || ''}`).join('||');
        if (sig === answersSigRef.current) return;
        answersSigRef.current = sig;
        if (!list.length) return;
        setAnswerDrafts(list.map((a, i) => ({
            key: String(a?.id || a?.label || i),
            id: String(a?.id || a?.label || ''),
            label: String(a?.label || a?.id || `Question ${i + 1}`),
            answer: String(a?.answer ?? a?.value ?? '')
        })));
    }, [courseAnswers]);

    const loadQuestionsFromForm = async () => {
        if (!onListFormQuestions) return;
        setAnswersBusy(true);
        setAnswersMsg('');
        try {
            const qs = await onListFormQuestions();
            const incoming = Array.isArray(qs) ? qs : [];
            setAnswerDrafts((prev) => {
                const byKey = new Map(
                    prev.map((r) => [String(r.id || r.label).toLowerCase(), r])
                );
                const next = incoming.map((q, i) => {
                    const key = String(q.id || q.label || i).toLowerCase();
                    const old = byKey.get(key);
                    return {
                        key: String(q.id || q.label || `q-${i}`),
                        id: String(q.id || q.label || ''),
                        label: String(q.label || q.id || `Question ${i + 1}`),
                        answer: old?.answer || ''
                    };
                });
                if (!next.length) {
                    return prev.length ? prev : [{
                        key: `new-${Date.now()}`,
                        id: '',
                        label: '',
                        answer: ''
                    }];
                }
                return next;
            });
            setAnswersMsg(incoming.length
                ? `Loaded ${incoming.length} question(s) from form`
                : 'No questions detected — add rows manually');
            setDockTab('manual');
        } catch (err) {
            setAnswersMsg(err?.message || 'Could not load questions');
        } finally {
            setAnswersBusy(false);
        }
    };

    const applyManualAnswers = async () => {
        if (!onApplyAnswers) return;
        setAnswersBusy(true);
        setAnswersMsg('');
        try {
            await onApplyAnswers(answerDrafts);
            setAnswersMsg('Filled on apply tab');
        } catch (err) {
            setAnswersMsg(err?.message || 'Apply answers failed');
        } finally {
            setAnswersBusy(false);
        }
    };

    // Local clock so parent Auto Bidder dialog does not re-render every second (scroll jump).
    useEffect(() => {
        if (!open) return undefined;
        const needTick = lastRefreshedAt != null
            || (jobStartedAt && !jobEndedAt)
            || (queueStartedAt && !queueEndedAt)
            || (answersStartedAt && !answersEndedAt);
        if (!needTick) return undefined;
        const t = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [open, lastRefreshedAt, jobStartedAt, jobEndedAt, queueStartedAt, queueEndedAt, answersStartedAt, answersEndedAt]);

    const liveUpdatedLabel = (() => {
        if (updatedLabel) return updatedLabel;
        if (lastRefreshedAt == null) return '';
        const sec = Math.max(0, Math.round((Date.now() - lastRefreshedAt) / 1000));
        return `updated ${sec}s ago`;
    })();

    const jobTotalLabel = jobStartedAt
        ? formatTotalElapsed(jobStartedAt, jobEndedAt)
        : '';
    const answersTotalLabel = answersStartedAt
        ? formatTotalElapsed(answersStartedAt, answersEndedAt)
        : '';
    const answersQLabel = Number(answersQuestionCount) > 0
        ? `Q ${answersQuestionCount}${Number(answersReadyCount) > 0 ? `/${answersReadyCount}` : ''}`
        : '';
    const bidAnswersLabel = [
        jobTotalLabel ? `Bid ${jobTotalLabel}` : '',
        answersTotalLabel ? `Answers ${answersTotalLabel}` : '',
        answersQLabel
    ].filter(Boolean).join(' · ');
    const queueTotalLabel = queueStartedAt
        ? formatTotalElapsed(queueStartedAt, queueEndedAt)
        : '';
    const queuePosLabel = Number(queueTotal) > 0 && Number(queueIndex) > 0
        ? `Job ${queueIndex}/${queueTotal}`
        : '';
    const showTiming = !!(bidAnswersLabel || queueTotalLabel || queuePosLabel);
    useEffect(() => {
        if (!open || minimized) return undefined;
        // Keep the expanded panel fully on-screen (answers + live frame were clipping).
        setPos((p) => {
            const maxY = Math.max(8, window.innerHeight - 160);
            const next = {
                x: clamp(p.x, 8, Math.max(8, window.innerWidth - 120)),
                y: clamp(p.y, 8, maxY)
            };
            if (next.x === p.x && next.y === p.y) return p;
            try { localStorage.setItem(POS_KEY, JSON.stringify(next)); } catch (_) { /* ignore */ }
            return next;
        });
        return undefined;
    }, [open, minimized]);

    useEffect(() => {
        if (!open) return undefined;
        const onResize = () => {
            setPos((p) => ({
                x: clamp(p.x, 8, Math.max(8, window.innerWidth - 120)),
                y: clamp(p.y, 8, Math.max(8, window.innerHeight - 160))
            }));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [open]);

    const onPointerDown = useCallback((e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.('button,a')) return;
        e.preventDefault();
        const startX = e.clientX;
        const startY = e.clientY;
        const orig = { ...pos };
        dragRef.current = { startX, startY, orig };

        const onMove = (ev) => {
            const d = dragRef.current;
            if (!d) return;
            const next = {
                x: clamp(d.orig.x + (ev.clientX - d.startX), 8, Math.max(8, window.innerWidth - 120)),
                y: clamp(d.orig.y + (ev.clientY - d.startY), 8, Math.max(8, window.innerHeight - 80))
            };
            setPos(next);
        };
        const onUp = () => {
            dragRef.current = null;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            setPos((p) => {
                try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch (_) { /* ignore */ }
                return p;
            });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }, [pos]);

    if (!mounted || !open || typeof document === 'undefined') return null;

    const hasFrames = frameCount > 0;
    const canPrev = hasFrames && frameIndex > 0;
    const canNext = hasFrames && frameIndex < frameCount - 1;
    const showManual =
        typeof onOpenApplyTab === 'function'
        || typeof onResumeCaptcha === 'function'
        || typeof onSkipCaptcha === 'function'
        || typeof onReAutofill === 'function'
        || typeof onUpdateState === 'function'
        || typeof onSubmitApply === 'function'
        || typeof onNextJob === 'function'
        || typeof onPauseQueue === 'function'
        || typeof onResumeQueue === 'function'
        || typeof onStopQueue === 'function'
        || typeof onProcess === 'function';
    const canSteer = queueRunning || awaitingCaptcha || progressPct > 0 || queuePaused;
    const hasCv = !!(cvDownloadUrl || cvEditHref || cvFilename);
    const outcomeBadge = outcomeKind
        ? {
            kind: outcomeKind,
            short: outcomeShort || String(outcomeKind).toUpperCase(),
            headline: runStatusHeadline(outcomeKind, outcomeShort),
            hint: outcomeLabel || ''
        }
        : null;
    const showOutcomeBanner = outcomeBadge
        && (outcomeBadge.kind === 'success'
            || outcomeBadge.kind === 'failed'
            || outcomeBadge.kind === 'filled'
            || outcomeBadge.kind === 'attention'
            || outcomeBadge.kind === 'incomplete'
            || (!queueRunning && !awaitingCaptcha && outcomeBadge.kind !== 'running'));

    const hostSnippet = (() => {
        const raw = String(ownedTabUrl || '').trim();
        if (!raw) return '';
        try {
            const u = new URL(raw);
            return u.hostname.replace(/^www\./i, '') + (u.pathname.length > 1 ? u.pathname.slice(0, 28) : '');
        } catch {
            return raw.slice(0, 48);
        }
    })();
    const feedSlice = Array.isArray(notifFeed) ? notifFeed.slice(0, 8) : [];
    const lessonRows = Array.isArray(hostLessons) ? hostLessons.slice(0, 6) : [];
    const showInstruct = typeof onInstructLumi === 'function'
        && (outcomeKind === 'filled'
            || outcomeKind === 'attention'
            || outcomeKind === 'failed'
            || outcomeKind === 'incomplete'
            || outcomeKind === 'running'
            || captchaTabMissing
            || !!awaitingCaptcha
            || !!queueRunning
            || !!coachStatus
            || !!ownedTabId
            || progressPct > 0);

    const runControls = (compact = false) => {
        if (!showManual) return null;
        const btn = compact ? 'h-6 gap-0.5 px-1.5 text-[10px]' : 'h-7 gap-1 px-2 text-[11px]';
    const stuck = outcomeKind === 'filled'
            || outcomeKind === 'attention'
            || outcomeKind === 'failed'
            || outcomeKind === 'incomplete'
            || captchaTabMissing;
        const captcha = !!awaitingCaptcha;
        const focusLabel = ownedTabMapped && !captchaTabMissing
            ? 'Focus'
            : (openTabLabel || 'Open');

        const primary = (
            <>
                {captcha && onOpenApplyTab ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onOpenApplyTab}
                        title={captchaTabMissing
                            ? 'Apply tab was closed — reopen (form may be empty)'
                            : 'Focus the owned apply tab'}
                    >
                        <ExternalLink className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        {focusLabel}
                    </Button>
                ) : null}
                {captcha && onResumeCaptcha ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onResumeCaptcha}
                        title="Continue after CAPTCHA"
                    >
                        <Play className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        Resume
                    </Button>
                ) : null}
                {!captcha && stuck && onOpenApplyTab ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onOpenApplyTab}
                        title={captchaTabMissing
                            ? 'Apply tab missing — reopen empty form?'
                            : 'Focus the owned apply tab'}
                    >
                        <ExternalLink className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        {focusLabel}
                    </Button>
                ) : null}
                {!captcha && stuck && onReAutofill ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onReAutofill}
                        title="Re-run autofill"
                    >
                        <RefreshCw className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        Re-fill
                    </Button>
                ) : null}
                {!captcha && stuck && onSubmitApply ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onSubmitApply}
                        title="Click Submit on the apply tab"
                    >
                        <Play className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        Submit
                    </Button>
                ) : null}
                {!captcha && !stuck && typeof onProcess === 'function' ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="default"
                        className={btn}
                        disabled={controlsBusy || !canProcess}
                        onClick={onProcess}
                        title="Start or restart Process"
                    >
                        <Play className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        {processLabel || 'Process'}
                    </Button>
                ) : null}
                {!captcha && !stuck && onOpenApplyTab ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onOpenApplyTab}
                        title={ownedTabMapped ? 'Focus owned apply tab' : 'Open apply tab'}
                    >
                        <ExternalLink className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                        {focusLabel}
                    </Button>
                ) : null}
            </>
        );

        const secondary = (
            <>
                {!captcha && stuck && typeof onProcess === 'function' ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy || !canProcess} onClick={onProcess}>
                        <Play className="h-3 w-3" />
                        {processLabel || 'Process'}
                    </Button>
                ) : null}
                {!stuck && onResumeCaptcha ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy || (!awaitingCaptcha && !canSteer)} onClick={onResumeCaptcha}>
                        Resume
                    </Button>
                ) : null}
                {!stuck && onReAutofill ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy || (!canSteer && outcomeKind !== 'failed')} onClick={onReAutofill}>
                        Re-fill
                    </Button>
                ) : null}
                {onUpdateState ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy} onClick={onUpdateState} title="Refresh status from apply tab">
                        <Camera className="h-3 w-3" />
                        State
                    </Button>
                ) : null}
                {!stuck && onSubmitApply ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy} onClick={onSubmitApply}>
                        Submit
                    </Button>
                ) : null}
                {onSkipCaptcha ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy || (!awaitingCaptcha && !canSteer)} onClick={onSkipCaptcha}>
                        Skip
                    </Button>
                ) : null}
                {onNextJob ? (
                    <Button type="button" size="sm" variant="outline" className={btn} disabled={controlsBusy || !canSteer} onClick={onNextJob}>
                        <SkipForward className="h-3 w-3" />
                        Next
                    </Button>
                ) : null}
                {queuePaused && onResumeQueue ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="gradient"
                        className={btn}
                        disabled={controlsBusy}
                        onClick={onResumeQueue}
                        title="Resume auto-bidder queue"
                    >
                        <Play className="h-3 w-3" />
                        Resume queue
                    </Button>
                ) : null}
                {!queuePaused && onPauseQueue ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={btn}
                        disabled={controlsBusy || (!queueRunning && !canSteer)}
                        onClick={onPauseQueue}
                        title="Pause queue so you can fix the form"
                    >
                        <Pause className="h-3 w-3" />
                        Pause
                    </Button>
                ) : null}
                {onStopQueue ? (
                    <Button type="button" size="sm" variant="destructive" className={btn} disabled={controlsBusy || (!canSteer && !queueRunning && !queuePaused)} onClick={onStopQueue}>
                        <Square className="h-3 w-3" />
                        Stop
                    </Button>
                ) : null}
            </>
        );

        if (compact) {
            return <div className="flex flex-wrap gap-1">{primary}{secondary}</div>;
        }

        return (
            <div className="space-y-1.5">
                <div className="flex flex-wrap gap-1">{primary}</div>
                <div className="flex flex-wrap gap-1">{secondary}</div>
            </div>
        );
    };

    const cvStrip = (compact = false) => {
        if (!hasCv) return null;
        const label = cvFilename
            ? String(cvFilename).replace(/^.*[\\/]/, '').slice(0, compact ? 18 : 42)
            : 'CV';
        return (
            <div
                className={`flex flex-wrap items-center gap-1 ${
                    compact
                        ? ''
                        : 'rounded-xl border border-white/[0.06] bg-white/[0.03] px-2.5 py-2'
                }`}
            >
                {!compact ? (
                    <>
                        <FileText className="h-3 w-3 shrink-0 text-white/40" />
                        <span className="min-w-0 flex-1 truncate text-[10px] text-white/50" title={cvFilename || ''}>
                            {label}
                        </span>
                    </>
                ) : null}
                {cvDownloadUrl ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={compact ? 'h-6 gap-0.5 px-1.5 text-[10px]' : 'h-7 gap-1 px-2 text-[11px]'}
                        asChild
                    >
                        <a href={cvDownloadUrl} target="_blank" rel="noreferrer" title="View / download CV">
                            <FileText className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                            View
                        </a>
                    </Button>
                ) : null}
                {cvEditHref ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={compact ? 'h-6 gap-0.5 px-1.5 text-[10px]' : 'h-7 gap-1 px-2 text-[11px]'}
                        asChild
                    >
                        <a href={cvEditHref} target="_blank" rel="noreferrer" title="Edit CV in Resume Generator">
                            <Pencil className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
                            Edit
                        </a>
                    </Button>
                ) : null}
            </div>
        );
    };

    const body = (
        <div
            className="lumi-control pointer-events-auto fixed z-[2147483000] flex flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[hsl(240_6%_9%/0.92)] shadow-[0_24px_64px_-20px_rgba(0,0,0,0.75),0_0_0_1px_hsla(187,85%,53%,0.12)] backdrop-blur-xl animate-in fade-in-0 zoom-in-95 duration-200"
            style={{
                left: pos.x,
                top: pos.y,
                width: minimized ? 300 : DOCK_W,
                maxWidth: 'calc(100vw - 16px)',
                minHeight: DOCK_H_MIN,
                maxHeight: minimized
                    ? undefined
                    : `min(calc(100vh - ${Math.max(8, pos.y)}px - 8px), calc(100vh - 16px))`
            }}
            role="dialog"
            aria-label="Lumi control panel"
        >
            <div
                className="relative flex shrink-0 cursor-grab items-center gap-2 border-b border-white/[0.06] px-3 py-2.5 active:cursor-grabbing select-none"
                style={{
                    background: 'linear-gradient(135deg, hsla(187,85%,53%,0.14) 0%, hsla(240,6%,12%,0.9) 42%, hsla(240,5%,10%,0.95) 100%)'
                }}
                onPointerDown={onPointerDown}
                title="Drag to move"
            >
                <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-px"
                    style={{ background: 'linear-gradient(90deg, transparent, hsla(187,85%,53%,0.55), transparent)' }}
                />
                <GripVertical className="h-3.5 w-3.5 shrink-0 text-white/35" />
                <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                    style={{
                        background: 'linear-gradient(145deg, hsl(199 95% 55%), hsl(199 89% 42%))',
                        boxShadow: '0 0 20px hsla(187,85%,53%,0.35)'
                    }}
                    aria-hidden
                >
                    <span
                        className="text-[11px] font-bold tracking-tight text-[hsl(240_6%_10%)]"
                        style={{ fontFamily: 'var(--font-display)' }}
                    >
                        L
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate">
                        <span
                            className="text-[13px] font-semibold tracking-tight text-white"
                            style={{ fontFamily: 'var(--font-display)' }}
                        >
                            Lumi
                        </span>
                        <span className="text-[11px] font-medium text-white/40">Control</span>
                        {outcomeBadge && (outcomeBadge.kind === 'success' || outcomeBadge.kind === 'failed' || outcomeBadge.kind === 'filled' || outcomeBadge.kind === 'attention') ? (
                            <span className={`inline-flex h-5 items-center rounded-md px-1.5 text-[9px] font-semibold uppercase tracking-wide ${runStatusBadgeClass(outcomeBadge.kind)}`}>
                                {outcomeBadge.short}
                            </span>
                        ) : (
                            <span className={`inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[9px] font-semibold uppercase tracking-wide ${
                                followLive
                                    ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30'
                                    : 'bg-white/5 text-white/45 ring-1 ring-white/10'
                            }`}
                            >
                                {followLive ? (
                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                                ) : null}
                                {followLive ? 'Live' : 'Paused'}
                            </span>
                        )}
                        {bidAnswersLabel ? (
                            <span className="font-mono text-[10px] tabular-nums text-white/45" title="Bid time from Process · answers/questions">
                                {bidAnswersLabel}
                            </span>
                        ) : null}
                        {awaitingCaptcha ? (
                            <span className="inline-flex h-5 items-center rounded-md bg-amber-500/15 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-400/30">
                                Captcha
                            </span>
                        ) : null}
                    </div>
                    {!minimized && title ? (
                        <div className="mt-0.5 truncate text-[11px] text-white/45">{title}</div>
                    ) : null}
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-white/50 hover:bg-white/10 hover:text-white"
                    title={minimized ? 'Expand' : 'Minimize'}
                    onClick={() => onMinimizedChange?.(!minimized)}
                >
                    {minimized ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-white/50 hover:bg-white/10 hover:text-white"
                    title="Open Lumi"
                    onClick={onExpandDialog}
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 text-white/50 hover:bg-white/10 hover:text-white"
                    title="Close panel"
                    onClick={onClose}
                >
                    <X className="h-3.5 w-3.5" />
                </Button>
            </div>

            {!minimized && (
                <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain p-3">
                    {(() => {
                        const shortStatus = shortenOutcomeLabel(outcomeBadge?.hint || progressLabel || statusLine || '')
                            || shortenNotifyText(statusComment)
                            || (outcomeBadge ? outcomeBadge.headline : '');
                        const detailLine = (() => {
                            const raw = shortenNotifyText(statusComment);
                            if (!raw) return '';
                            if (shortStatus && raw.toLowerCase() === shortStatus.toLowerCase()) return '';
                            if (/incomplete|missing|country|location|required/i.test(raw) && raw !== shortStatus) {
                                return raw.length > 64 ? `${raw.slice(0, 63)}…` : raw;
                            }
                            return '';
                        })();
                        if (!showOutcomeBanner && !shortStatus && !progressPct) return null;
                        const tone = outcomeBadge?.kind || '';
                        const shell =
                            tone === 'success'
                                ? 'border-emerald-400/25 bg-emerald-500/[0.08]'
                                : tone === 'failed'
                                    ? 'border-rose-400/25 bg-rose-500/[0.08]'
                                    : tone === 'attention' || tone === 'filled'
                                        ? 'border-amber-400/20 bg-amber-500/[0.07]'
                                        : 'border-white/[0.08] bg-white/[0.03]';
                        return (
                            <div className={`rounded-xl border px-3 py-2.5 ${shell}`}>
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p
                                            className="text-[13px] font-semibold leading-snug tracking-tight text-white/95"
                                            style={{ fontFamily: 'var(--font-display)' }}
                                        >
                                            {shortStatus || outcomeBadge?.headline || 'Bidding…'}
                                        </p>
                                        {detailLine ? (
                                            <p className="mt-1 text-[11px] leading-snug text-white/55">{detailLine}</p>
                                        ) : null}
                                    </div>
                                    {showTiming ? (
                                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-cyan-300/80">
                                            {bidAnswersLabel || queueTotalLabel}
                                        </span>
                                    ) : null}
                                </div>
                                {(progressPct > 0) ? (
                                    <BidProgressBar
                                        className="mt-2.5"
                                        pct={progressPct}
                                        label=""
                                        tone={progressTone}
                                        stepIndex={progressStepIndex}
                                        compact
                                    />
                                ) : null}
                            </div>
                        );
                    })()}

                    {(queuePosLabel || hostSnippet || ownedTabId || captchaTabMissing) ? (
                        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-[10px] text-white/55">
                            {queuePosLabel ? (
                                <span className="font-medium text-white/75">{queuePosLabel}</span>
                            ) : null}
                            {ownedTabMapped && !captchaTabMissing ? (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 font-medium text-emerald-300/90">
                                    Owned tab{ownedTabId ? ` #${ownedTabId}` : ''}
                                </span>
                            ) : captchaTabMissing ? (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-200/90">
                                    Will reopen empty
                                </span>
                            ) : ownedTabId ? (
                                <span className="rounded bg-white/10 px-1.5 py-0.5">tab #{ownedTabId}</span>
                            ) : null}
                            {hostSnippet ? (
                                <span className="min-w-0 truncate font-mono text-white/45" title={ownedTabUrl || ''}>
                                    {hostSnippet}
                                </span>
                            ) : null}
                            {successConfirming ? (
                                <span className="text-sky-300/80">confirming…</span>
                            ) : null}
                        </div>
                    ) : null}

                    {showInstruct ? (
                        <div className="rounded-xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/[0.08] to-transparent px-3 py-2.5">
                            <div className="flex items-center justify-between gap-2">
                                <p
                                    className="text-[11px] font-semibold tracking-tight text-cyan-100/90"
                                    style={{ fontFamily: 'var(--font-display)' }}
                                >
                                    Lumi Assistant
                                </p>
                                {coachStatus ? (
                                    <span className="truncate text-[10px] text-cyan-200/70">
                                        {shortenNotifyText(coachStatus) || coachStatus}
                                    </span>
                                ) : (
                                    <span className="truncate text-[10px] text-white/40">
                                        Control bidder · fix answers · remember
                                    </span>
                                )}
                            </div>
                            <p className="mt-1 text-[10px] leading-snug text-white/45">
                                Tell Lumi what to do on the apply tab: fill answers, pause, skip, submit, or re-fill.
                            </p>
                            <div className="mt-2 flex gap-2">
                                <input
                                    type="text"
                                    className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-2.5 text-[12px] text-white placeholder:text-white/35 outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
                                    placeholder="e.g. Disability = No · Pause · Answer why this role briefly"
                                    value={instructText}
                                    disabled={instructBusy || controlsBusy}
                                    onChange={(e) => setInstructText(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && instructText.trim() && !instructBusy) {
                                            e.currentTarget.blur();
                                            document.getElementById('lumi-dock-instruct-apply')?.click();
                                        }
                                    }}
                                />
                                <Button
                                    id="lumi-dock-instruct-apply"
                                    type="button"
                                    size="sm"
                                    className="h-9 shrink-0 rounded-lg px-3 text-[12px] font-semibold"
                                    disabled={instructBusy || controlsBusy || !instructText.trim()}
                                    onClick={async () => {
                                        setInstructBusy(true);
                                        setInstructMsg('');
                                        try {
                                            const res = await onInstructLumi(instructText.trim());
                                            setInstructMsg(shortenNotifyText(res?.summary || res?.coach || 'Applied') || 'Applied');
                                            if (res?.ok !== false) setInstructText('');
                                        } catch (err) {
                                            setInstructMsg(
                                                shortenNotifyText(err?.message || 'Instruct failed')
                                                || 'Lumi offline — Reload extension'
                                            );
                                        } finally {
                                            setInstructBusy(false);
                                        }
                                    }}
                                >
                                    {instructBusy ? '…' : 'Apply'}
                                </Button>
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                                {[
                                    'Pause',
                                    'Resume',
                                    'Disability = No',
                                    'Visa sponsorship = No',
                                    'Type city, state and zip into Location',
                                    'Answer the why / experience questions briefly',
                                    'Re-autofill',
                                    'Submit now',
                                    'Next job',
                                    'Skip captcha'
                                ].map((ex) => (
                                    <button
                                        key={ex}
                                        type="button"
                                        className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] text-white/55 hover:bg-white/10 hover:text-white/80"
                                        disabled={instructBusy || controlsBusy}
                                        onClick={() => setInstructText(ex)}
                                    >
                                        {ex}
                                    </button>
                                ))}
                            </div>
                            {instructMsg ? (
                                <p className={`mt-1.5 text-[11px] ${
                                    /offline|fail|error|reload/i.test(instructMsg) ? 'text-amber-300' : 'text-white/50'
                                }`}
                                >
                                    {instructMsg}
                                </p>
                            ) : null}
                            <div className="mt-2 border-t border-white/10 pt-2">
                                <TeachAndCheckPanel compact />
                            </div>
                            {lessonRows.length ? (
                                <div className="mt-2 space-y-1 border-t border-white/10 pt-2">
                                    <p className="text-[10px] font-medium text-white/45">Lessons for this host</p>
                                    {lessonRows.map((les, i) => {
                                        const key = String(les.id || `${les.host}-${les.field_key || les.fieldKey}-${i}`);
                                        const disabled = !!les.disabled;
                                        return (
                                            <div key={key} className="flex items-center gap-2 text-[10px] text-white/60">
                                                <span className="min-w-0 flex-1 truncate">
                                                    {les.field_key || les.fieldKey || 'form'}
                                                    {les.instruction ? ` — ${String(les.instruction).slice(0, 40)}` : ''}
                                                </span>
                                                {typeof onToggleLesson === 'function' ? (
                                                    <button
                                                        type="button"
                                                        className="shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-cyan-200/80 hover:bg-white/5"
                                                        onClick={() => onToggleLesson(les, !disabled)}
                                                    >
                                                        {disabled ? 'On' : 'Off'}
                                                    </button>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {feedSlice.length ? (
                        <div className="rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-2">
                            <div className="mb-1 flex items-center justify-between gap-2">
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                                    Notifications
                                </p>
                                {typeof onClearNotifs === 'function' ? (
                                    <button
                                        type="button"
                                        className="text-[9px] text-white/40 hover:text-white/70"
                                        onClick={onClearNotifs}
                                    >
                                        Clear
                                    </button>
                                ) : null}
                            </div>
                            <ul className="max-h-[88px] space-y-0.5 overflow-y-auto">
                                {feedSlice.map((n, i) => {
                                    const kind = n.kind || 'info';
                                    const color = kind === 'error'
                                        ? 'text-rose-300/90'
                                        : kind === 'warn'
                                            ? 'text-amber-200/90'
                                            : kind === 'ok'
                                                ? 'text-emerald-300/90'
                                                : kind === 'learn'
                                                    ? 'text-cyan-300/90'
                                                    : 'text-white/55';
                                    return (
                                        <li key={n.id || `${n.at}-${i}`} className={`truncate text-[10px] ${color}`}>
                                            {n.short || n.message || '—'}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ) : null}

                    <div className="flex gap-1 rounded-xl border border-white/[0.06] bg-black/20 p-1">
                        <button
                            type="button"
                            className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition ${
                                dockTab === 'live'
                                    ? 'bg-cyan-500 text-[hsl(240_6%_10%)] shadow-sm shadow-cyan-500/25'
                                    : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                            }`}
                            onClick={() => setDockTab('live')}
                        >
                            Live
                        </button>
                        <button
                            type="button"
                            className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold transition ${
                                dockTab === 'manual'
                                    ? 'bg-cyan-500 text-[hsl(240_6%_10%)] shadow-sm shadow-cyan-500/25'
                                    : 'text-white/50 hover:bg-white/5 hover:text-white/80'
                            }`}
                            onClick={() => setDockTab('manual')}
                        >
                            Manual
                            {answerDrafts.length ? (
                                <span className="ml-1 tabular-nums opacity-80">{answerDrafts.length}</span>
                            ) : null}
                        </button>
                    </div>

                    {dockTab === 'live' ? (
                        <>
                    {showManual ? (
                        <div
                            className={`rounded-xl border px-2.5 py-2 ${
                                awaitingCaptcha
                                    ? 'border-amber-400/25 bg-amber-500/[0.07]'
                                    : 'border-white/[0.06] bg-white/[0.03]'
                            }`}
                        >
                            {awaitingCaptcha ? (
                                <p className="mb-1.5 text-[11px] text-amber-200/90">
                                    {captchaTabMissing ? 'Tab closed — reopen' : 'CAPTCHA — solve, then Resume'}
                                </p>
                            ) : null}
                            {runControls(false)}
                        </div>
                    ) : null}

                    {cvStrip(false)}

                    <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-black/50">
                        {imgSrc && !loading ? (
                            <button
                                type="button"
                                className="block w-full cursor-zoom-in"
                                onClick={onFullscreen}
                                title="Full screen"
                            >
                                <img
                                    key={imgSrc}
                                    src={imgSrc}
                                    alt={shotStage || 'Apply page'}
                                    className="max-h-[min(36vh,20rem)] min-h-[10rem] w-full object-contain object-top"
                                />
                            </button>
                        ) : (
                            <div className="flex h-40 items-center justify-center px-3 text-center text-xs text-white/40">
                                {loading
                                    ? 'Loading…'
                                    : imgErr
                                        ? imgErr
                                        : 'Waiting for live frames…'}
                            </div>
                        )}
                        <div className="absolute bottom-1.5 left-1.5 flex flex-wrap gap-1">
                            {shotStage ? (
                                <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-white/90 backdrop-blur-sm">
                                    {shotStage}
                                </span>
                            ) : null}
                            {liveUpdatedLabel ? (
                                <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] text-emerald-300 backdrop-blur-sm">
                                    {liveUpdatedLabel}
                                </span>
                            ) : null}
                        </div>
                        {imgSrc ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="absolute bottom-1.5 right-1.5 h-7 gap-1 rounded-lg px-2 text-[10px]"
                                onClick={onFullscreen}
                            >
                                <Maximize2 className="h-3 w-3" />
                                Zoom
                            </Button>
                        ) : null}
                    </div>

                    <div className="flex items-center gap-1.5">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 rounded-lg border-white/10 bg-white/[0.03] p-0 text-white/70 hover:bg-white/10"
                            disabled={!canPrev}
                            onClick={onPrevFrame}
                            title="Previous frame"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <span className="min-w-[4.5rem] flex-1 text-center text-[11px] tabular-nums text-white/45">
                            {hasFrames
                                ? `${frameIndex + 1} / ${frameCount}`
                                : '0 / 0'}
                        </span>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 w-8 rounded-lg border-white/10 bg-white/[0.03] p-0 text-white/70 hover:bg-white/10"
                            disabled={!canNext}
                            onClick={onNextFrame}
                            title="Next frame"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                        {!followLive && hasFrames ? (
                            <Button
                                type="button"
                                size="sm"
                                className="h-8 rounded-lg px-2.5 text-xs"
                                onClick={onFollowLive}
                                title="Jump to latest live frame"
                            >
                                Live
                            </Button>
                        ) : null}
                    </div>
                        </>
                    ) : (
                        <div className="space-y-2.5">
                            <p className="text-[11px] leading-snug text-white/45">
                                Edit answers here, then Fill form on the apply tab. Use From form to pull questions from the page.
                            </p>
                            <div className="flex flex-wrap gap-1.5">
                                {onListFormQuestions ? (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-8 gap-1 rounded-lg border-white/10 bg-white/[0.03] px-2.5 text-[11px] text-white/80"
                                        disabled={controlsBusy || answersBusy}
                                        onClick={loadQuestionsFromForm}
                                    >
                                        From form
                                    </Button>
                                ) : null}
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-8 gap-1 rounded-lg border-white/10 bg-white/[0.03] px-2.5 text-[11px] text-white/80"
                                    disabled={controlsBusy || answersBusy}
                                    onClick={() => {
                                        setAnswerDrafts((prev) => [
                                            ...prev,
                                            {
                                                key: `new-${Date.now()}`,
                                                id: '',
                                                label: '',
                                                answer: ''
                                            }
                                        ]);
                                    }}
                                >
                                    <Plus className="h-3 w-3" />
                                    Add
                                </Button>
                                {onApplyAnswers ? (
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="h-8 rounded-lg px-2.5 text-[11px] font-semibold"
                                        disabled={controlsBusy || answersBusy || !answerDrafts.length}
                                        onClick={applyManualAnswers}
                                    >
                                        Fill form
                                    </Button>
                                ) : null}
                                {onReAutofill ? (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        className="h-8 rounded-lg px-2.5 text-[11px]"
                                        disabled={controlsBusy || answersBusy}
                                        onClick={onReAutofill}
                                    >
                                        Re-autofill
                                    </Button>
                                ) : null}
                            </div>
                            <div className="max-h-[min(48vh,22rem)] space-y-2 overflow-y-auto pr-0.5">
                                {answerDrafts.length === 0 ? (
                                    <p className="rounded-xl border border-dashed border-white/15 px-2 py-5 text-center text-[11px] text-white/40">
                                        No answers yet. Click From form, or Add a row and type your answer.
                                    </p>
                                ) : (
                                    answerDrafts.map((row, idx) => (
                                        <div
                                            key={row.key || idx}
                                            className="space-y-1.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-2.5"
                                        >
                                            <div className="flex items-start gap-1.5">
                                                <input
                                                    type="text"
                                                    className="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-2.5 text-[11px] font-medium text-white outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
                                                    placeholder="Question label"
                                                    value={row.label}
                                                    onChange={(e) => {
                                                        const v = e.target.value;
                                                        setAnswerDrafts((prev) => prev.map((r, i) => (
                                                            i === idx
                                                                ? { ...r, label: v, id: r.id || v }
                                                                : r
                                                        )));
                                                    }}
                                                />
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-8 w-8 shrink-0 p-0 text-white/40 hover:bg-white/10 hover:text-rose-300"
                                                    title="Remove row"
                                                    disabled={controlsBusy || answersBusy}
                                                    onClick={() => {
                                                        setAnswerDrafts((prev) => prev.filter((_, i) => i !== idx));
                                                    }}
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </Button>
                                            </div>
                                            <textarea
                                                className="min-h-[2.75rem] w-full resize-y rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5 text-[11px] leading-snug text-white outline-none transition focus:border-cyan-400/40 focus:ring-2 focus:ring-cyan-400/20"
                                                placeholder="Your answer"
                                                rows={2}
                                                value={row.answer}
                                                onChange={(e) => {
                                                    const v = e.target.value;
                                                    setAnswerDrafts((prev) => prev.map((r, i) => (
                                                        i === idx ? { ...r, answer: v } : r
                                                    )));
                                                }}
                                            />
                                        </div>
                                    ))
                                )}
                            </div>
                            {answersMsg ? (
                                <p className="text-[10px] text-white/45">{answersMsg}</p>
                            ) : null}
                        </div>
                    )}
                </div>
            )}

            {minimized && (
                <div className="space-y-1.5 border-t border-white/[0.06] px-3 py-2">
                    {showOutcomeBanner ? (
                        <div className={`rounded-lg border px-2 py-1 text-[10px] font-bold ${runStatusBannerClass(outcomeBadge.kind)}`}>
                            {outcomeBadge.short}
                            {outcomeBadge.kind === 'filled' ? ' · not confirmed' : ''}
                            {outcomeBadge.kind === 'success' ? ' · applied' : ''}
                            {outcomeBadge.kind === 'failed' ? ' · did not complete' : ''}
                            {outcomeBadge.kind === 'attention' && outcomeBadge.short === 'INCOMPLETE' ? ' · finish fields' : ''}
                        </div>
                    ) : null}
                    <div className="flex items-center gap-2">
                        <Minimize2 className="h-3 w-3 shrink-0 text-white/35" />
                        <span className="truncate text-[11px] text-white/55">
                            {progressLabel || statusLine || title || 'Bidding in background…'}
                        </span>
                        {bidAnswersLabel ? (
                            <span className="shrink-0 font-mono text-[10px] tabular-nums text-cyan-300/80" title="Bid time from Process · answers/questions">
                                {bidAnswersLabel}
                            </span>
                        ) : null}
                        {progressPct > 0 ? (
                            <span className={`shrink-0 tabular-nums text-[10px] ${
                                outcomeBadge?.kind === 'success'
                                    ? 'text-emerald-300'
                                    : outcomeBadge?.kind === 'failed'
                                        ? 'text-rose-300'
                                        : 'text-white/45'
                            }`}
                            >
                                {Math.round(progressPct)}%
                            </span>
                        ) : null}
                    </div>
                    {(progressPct > 0 || progressLabel) ? (
                        <BidProgressBar
                            pct={progressPct}
                            label=""
                            tone={progressTone}
                            stepIndex={-1}
                            compact
                            className="!space-y-0"
                        />
                    ) : null}
                    {runControls(true)}
                    {cvStrip(true)}
                </div>
            )}
        </div>
    );

    return createPortal(body, document.body);
}
