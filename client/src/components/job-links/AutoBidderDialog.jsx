import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    Camera,
    ChevronDown,
    ChevronRight,
    ExternalLink,
    HelpCircle,
    Maximize2,
    Play,
    RefreshCw,
    ShieldAlert,
    SkipForward,
    Square,
    X,
    Trash2,
    ZoomIn,
    ZoomOut
} from 'lucide-react';
import { userAPI, adminAPI } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import {
    ModalTabs,
    ModalTabsContent,
    ModalTabsList,
    ModalTabsTrigger
} from '@/components/ui/modal-tabs';
import { sendBidderExtensionCommand, getLumiBridgeVersion, listenForLumiBridgeReady, reinjectLumiBridge } from '@/lib/bidderExtensionBridge';
import {
    loadLumiBidderPrefs,
    processQueuePrefsPayload
} from '@/lib/lumiBidderPrefs';
import LumiBidderSettings from '@/components/LumiBidderSettings';
import BidMonitorDock from '@/components/job-links/BidMonitorDock';
import BidProgressBar from '@/components/job-links/BidProgressBar';
import {
    detectAtsFromUrl,
    describeEventMeta,
    courseRunStatus,
    bidStageProgress,
    failureSummary,
    isFailureEvent,
    lastStatusEvent,
    formatElapsedSince,
    formatTotalElapsed,
    resolveApplyOpenUrl,
    pickApplyOpenUrl,
    isBrokenApplyLandingUrl,
    orderMonitorScreenshotFrames,
    preferredProofFrameIndex,
    sortScreenshotsForReview,
    isProofScreenshotStage,
    screenshotStageLabel,
    liveStatusComment,
    isSuccessEvent,
    runStatusBadgeClass,
    runStatusRowClass,
    runStatusBannerClass,
    runStatusHeadline
} from '@/lib/bidCourseFailure';
import {
    shortenNotifyText,
    shortenOutcomeLabel,
    shortEventNotify,
    inferNotifKind,
    mergeNotifFeeds
} from '@/lib/bidderNotifyCopy';

const PROFILE_STORAGE_KEY = 'job_apply_bidder_profile_id';
const MONITOR_STORAGE_KEY = 'lumi_bid_monitor_v1';
const MIN_LUMI_VERSION = '1.9.40';
const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;

function readMonitorStorage() {
    try {
        const raw = localStorage.getItem(MONITOR_STORAGE_KEY)
            || (sessionStorage.getItem('lumi_bid_monitor_active') === '1' ? '{"active":true}' : '');
        if (!raw) return { active: false, courseId: null, minimized: false };
        const p = JSON.parse(raw);
        return {
            active: !!p.active,
            courseId: p.courseId != null ? Number(p.courseId) : null,
            minimized: !!p.minimized
        };
    } catch {
        return { active: false, courseId: null, minimized: false };
    }
}

function writeMonitorStorage(patch) {
    try {
        const cur = readMonitorStorage();
        const next = { ...cur, ...patch };
        localStorage.setItem(MONITOR_STORAGE_KEY, JSON.stringify(next));
        if (next.active) sessionStorage.setItem('lumi_bid_monitor_active', '1');
        else sessionStorage.removeItem('lumi_bid_monitor_active');
    } catch (_) { /* ignore */ }
}

function useScreenshotSrc(courseId, filename, isAdmin, refreshKey = 0) {
    const [src, setSrc] = useState('');
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(false);
    const prevObjectUrlRef = useRef('');

    useEffect(() => {
        // Always drop the previous frame immediately so a new course cannot keep
        // showing the last job's screenshot while the next blob loads.
        if (prevObjectUrlRef.current) {
            try { URL.revokeObjectURL(prevObjectUrlRef.current); } catch (_) { /* ignore */ }
            prevObjectUrlRef.current = '';
        }
        setSrc('');
        setErr('');

        if (!courseId || !filename) {
            setLoading(false);
            return undefined;
        }
        let alive = true;
        setLoading(true);
        (async () => {
            try {
                const api = isAdmin ? adminAPI : userAPI;
                const bust = `${refreshKey || 0}-${Date.now()}`;
                const { data } = await api.getBidCourseScreenshot(courseId, filename, {
                    t: bust
                });
                if (!(data instanceof Blob) || data.size < 32) {
                    throw new Error('empty image');
                }
                const objectUrl = URL.createObjectURL(data);
                if (!alive) {
                    try { URL.revokeObjectURL(objectUrl); } catch (_) { /* ignore */ }
                    return;
                }
                prevObjectUrlRef.current = objectUrl;
                setSrc(objectUrl);
                setErr('');
            } catch (e) {
                if (alive) {
                    setSrc('');
                    setErr(e?.message || 'load failed');
                }
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => {
            alive = false;
        };
    }, [courseId, filename, isAdmin, refreshKey]);

    useEffect(() => () => {
        if (prevObjectUrlRef.current) {
            try { URL.revokeObjectURL(prevObjectUrlRef.current); } catch (_) { /* ignore */ }
            prevObjectUrlRef.current = '';
        }
    }, []);

    return { src, err, loading };
}

function ZoomControls({ zoom, onZoom, onFit, compact }) {
    return (
        <div className={`flex flex-wrap items-center gap-1 ${compact ? '' : 'gap-2'}`}>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2" onClick={() => onZoom(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}>
                <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <span className="min-w-[3rem] text-center text-xs tabular-nums">{zoom}%</span>
            <Button type="button" size="sm" variant="outline" className="h-7 px-2" onClick={() => onZoom(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}>
                <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onFit}>
                Fit
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onZoom(100 - zoom)}>
                100%
            </Button>
        </div>
    );
}

function ScreenshotZoomViewport({ src, alt, zoom, fullscreen, onWheelZoom }) {
    const viewportRef = useRef(null);

    const onWheel = (e) => {
        if (!onWheelZoom) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        onWheelZoom(delta);
    };

    return (
        <div
            ref={viewportRef}
            className={
                fullscreen
                    ? 'flex-1 min-h-0 overflow-auto rounded bg-black/40 p-2'
                    : 'min-h-[28rem] max-h-[min(72vh,42rem)] overflow-auto rounded border bg-background/80 p-1'
            }
            onWheel={onWheel}
        >
            {src ? (
                <img
                    src={src}
                    alt={alt}
                    draggable={false}
                    className="mx-auto block select-none"
                    style={{ width: `${zoom}%`, maxWidth: 'none' }}
                />
            ) : (
                <div className="flex min-h-[8rem] items-center justify-center text-xs text-muted-foreground">
                    Loading screenshot…
                </div>
            )}
        </div>
    );
}

function ScreenshotLightbox({ open, onClose, courseId, filename, stage, isAdmin, refreshKey }) {
    const [zoom, setZoom] = useState(100);
    const { src, err } = useScreenshotSrc(courseId, filename, isAdmin, refreshKey);

    useEffect(() => {
        if (open) setZoom(100);
    }, [open, filename]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    if (!open) return null;

    const adjustZoom = (delta) => {
        setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)));
    };

    return (
        <div className="fixed inset-0 z-[200] flex flex-col bg-black/95 text-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2">
                <div className="text-sm font-medium">{screenshotStageLabel(stage)}</div>
                <div className="flex flex-wrap items-center gap-2">
                    <ZoomControls
                        zoom={zoom}
                        onZoom={adjustZoom}
                        onFit={() => setZoom(100)}
                        compact
                    />
                    <Button type="button" size="sm" variant="secondary" className="h-7" onClick={onClose}>
                        <X className="h-4 w-4" />
                        Close
                    </Button>
                </div>
            </div>
            <ScreenshotZoomViewport
                src={src}
                alt={stage}
                zoom={zoom}
                fullscreen
                onWheelZoom={adjustZoom}
            />
            {err && <p className="px-4 py-2 text-xs text-red-300">{err}</p>}
            <p className="px-4 py-2 text-[11px] text-white/60">Scroll to pan · mouse wheel to zoom · Esc to close</p>
        </div>
    );
}

function LiveScreenshotPanel({ courseId, shot, isAdmin, refreshKey, lastRefreshedAt, onExpand }) {
    const [zoom, setZoom] = useState(125);
    const [, setTick] = useState(0);
    const { src, err, loading } = useScreenshotSrc(courseId, shot?.filename, isAdmin, refreshKey);

    useEffect(() => {
        setZoom(125);
    }, [shot?.filename]);

    useEffect(() => {
        if (!lastRefreshedAt) return undefined;
        const t = setInterval(() => setTick((n) => n + 1), 1000);
        return () => clearInterval(t);
    }, [lastRefreshedAt]);

    if (!shot) return null;

    const adjustZoom = (delta) => {
        setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + delta)));
    };

    const ago =
        lastRefreshedAt && Date.now() - lastRefreshedAt < 60000
            ? `${Math.max(1, Math.round((Date.now() - lastRefreshedAt) / 1000))}s ago`
            : lastRefreshedAt
                ? new Date(lastRefreshedAt).toLocaleTimeString()
                : '';

    return (
        <div className="rounded-lg border border-primary/40 bg-muted/20 p-2">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Camera className="h-4 w-4" />
                    Live monitor
                    <Badge variant="default" className="text-[10px] animate-pulse bg-green-600 hover:bg-green-600">
                        LIVE
                    </Badge>
                    {loading && (
                        <Badge variant="secondary" className="text-[10px]">
                            refreshing…
                        </Badge>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <ZoomControls zoom={zoom} onZoom={adjustZoom} onFit={() => setZoom(100)} compact />
                    <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={onExpand}>
                        <Maximize2 className="h-3.5 w-3.5" />
                        Full screen
                    </Button>
                </div>
            </div>
            <ScreenshotZoomViewport
                src={src}
                alt={shot.stage}
                zoom={zoom}
                onWheelZoom={adjustZoom}
            />
            <div className="mt-1 flex flex-wrap justify-between gap-1 text-xs text-muted-foreground">
                <span>
                    Latest: <strong>{screenshotStageLabel(shot.stage)}</strong>
                    {ago ? ` · updated ${ago}` : ''}
                </span>
                <span>Scroll to pan · wheel = zoom · Full screen for max size</span>
            </div>
            {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}
        </div>
    );
}

function AuthShot({ courseId, filename, stage, isAdmin, imgClassName, onExpand, refreshKey = 0 }) {
    const { src, err } = useScreenshotSrc(courseId, filename, isAdmin, refreshKey);
    const label = screenshotStageLabel(stage);
    if (!src) {
        return (
            <div className="flex min-h-[18rem] items-center justify-center rounded border border-dashed px-3 py-6 text-sm text-muted-foreground">
                {label}{err ? ` · ${err}` : ''}
            </div>
        );
    }
    const img = (
        <img
            src={src}
            alt={label}
            className={
                imgClassName
                || 'max-h-[min(56vh,32rem)] min-h-[18rem] w-full rounded border object-contain object-top bg-black/20'
            }
        />
    );
    return (
        <figure className="space-y-1">
            {onExpand ? (
                <button
                    type="button"
                    className="group relative block w-full cursor-zoom-in overflow-hidden rounded border bg-background text-left"
                    onClick={onExpand}
                    title="Click to open full-screen zoom"
                >
                    {img}
                    <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white opacity-90 shadow transition group-hover:opacity-100">
                        Click to enlarge
                    </span>
                </button>
            ) : (
                img
            )}
            <figcaption className="text-sm text-muted-foreground">{label} — click image to enlarge</figcaption>
        </figure>
    );
}

function displayCompanyName(course, application, jobLinkById) {
    const bad = (name) => {
        const s = String(name || '').trim();
        return !s || /^(unknown|company|job|n\/?a|none|-|engineering|product|design|marketing|sales|operations|finance|legal|hr|human resources|department|team)$/i.test(s);
    };
    const fromCourse = String(course?.company_name || '').trim();
    if (!bad(fromCourse)) return fromCourse;
    const fromApp = String(application?.company_name || '').trim();
    if (!bad(fromApp)) return fromApp;
    const link = jobLinkById?.get(Number(application?.job_link_id || course?.job_link_id));
    const fromLink = String(link?.company_name || '').trim();
    if (!bad(fromLink)) return fromLink;
    const url = application?.job_url || course?.job_url || link?.job_apply_url || link?.source_url || '';
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        const root = host.split('.')[0];
        if (root && root.length > 2 && !/^(boards|jobs|careers|apply|greenhouse|lever|ashbyhq|myworkdayjobs)$/i.test(root)) {
            return root.charAt(0).toUpperCase() + root.slice(1);
        }
        if (host) return host;
    } catch { /* ignore */ }
    return fromCourse || fromApp || fromLink || 'Company';
}

function primaryJobUrl(row) {
    return row?.job_apply_url || row?.source_url || row?.job_url || '';
}

function isUnsupportedAtsLink(url) {
    return !detectAtsFromUrl(url).supported;
}

function parseVersion(v) {
    return String(v || '0')
        .split('.')
        .map((n) => parseInt(n, 10) || 0);
}

function versionAtLeast(current, min) {
    const a = parseVersion(current);
    const b = parseVersion(min);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return true;
}

function profileLabel(p) {
    if (!p) return 'Profile';
    const name = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    const stacks = Array.isArray(p.techstacks) ? p.techstacks.join(', ') : '';
    const base = name || `Profile #${p.id || p.profile_id}`;
    return stacks ? `${base} (${stacks})` : base;
}

function latestCourseFor(courses, { jobLinkId, profileId } = {}) {
    const rows = (courses || []).filter((c) => {
        if (jobLinkId != null && Number(c.job_link_id) !== Number(jobLinkId)) return false;
        if (profileId != null && Number(c.profile_id) !== Number(profileId)) return false;
        return true;
    });
    if (!rows.length) return null;
    rows.sort((a, b) =>
        String(b.updated_at || b.filled_at || b.created_at || '')
            .localeCompare(String(a.updated_at || a.filled_at || a.created_at || ''))
    );
    return rows[0];
}

function linkOutcomeForProfile(courses, jobLinkId, profileId, ready) {
    const course = latestCourseFor(courses, { jobLinkId, profileId });
    if (course) return courseRunStatus(course);
    if (ready) return { kind: 'unknown', short: 'CV READY', label: 'Ready CV — not bid yet' };
    return { kind: 'unknown', short: 'NO CV', label: 'No ready CV for this profile' };
}

function profileBidOutcome(courses, profileId, jobLinkIds) {
    const counts = { success: 0, failed: 0, filled: 0, attention: 0, running: 0 };
    let any = false;
    for (const id of jobLinkIds || []) {
        const course = latestCourseFor(courses, { jobLinkId: id, profileId });
        if (!course) continue;
        any = true;
        const kind = courseRunStatus(course).kind;
        if (counts[kind] != null) counts[kind] += 1;
    }
    if (!any) return null;
    if (counts.failed) return { kind: 'failed', short: `FAILED×${counts.failed}` };
    if (counts.attention) return { kind: 'attention', short: `CAPTCHA×${counts.attention}` };
    if (counts.running) return { kind: 'running', short: 'RUNNING' };
    if (counts.filled) return { kind: 'filled', short: `FILLED×${counts.filled}` };
    if (counts.success) return { kind: 'success', short: `SUCCESS×${counts.success}` };
    return null;
}

function profileStatusSuffix(p, bidOutcome) {
    const parts = [];
    if (bidOutcome?.short) parts.push(bidOutcome.short);
    if (p?.application_status === 'applied') parts.push('APPLIED');
    else if (p?.application_status === 'rejected') parts.push('REJECTED');
    else if (p?.generation_status === 'ready') parts.push('CV READY');
    else if (p?.generation_status === 'failed') parts.push('CV FAIL');
    else if (p?.generation_status === 'generating') parts.push('CV GEN…');
    else if (p?.generation_status === 'pending') parts.push('CV PENDING');
    if (p?.matched && p?.selectedCount > 1) {
        parts.push(`${p.matchCount || 0}/${p.selectedCount} links`);
    }
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

/**
 * Job Links Auto Bidder — bid selected links only, manage Bid Courses in-popup.
 * @param {object[]} selectedLinks — [{ id, company_name, position_title, job_url, available_profiles? }]
 */
export default function AutoBidderDialog({ open, onOpenChange, isAdmin, selectedLinks = [] }) {
    const coursesApi = isAdmin ? adminAPI : userAPI;
    const [courses, setCourses] = useState([]);
    const [outcomeFilter, setOutcomeFilter] = useState('all'); // all|success|failed|filled|attention|running
    const [selectedId, setSelectedId] = useState(null);
    const [workspaceTab, setWorkspaceTab] = useState('setup');
    const [detail, setDetail] = useState(null);
    const [readyPreview, setReadyPreview] = useState([]);
    const [profiles, setProfiles] = useState([]);
    const [profileId, setProfileId] = useState('');
    const [showAllProfiles, setShowAllProfiles] = useState(false);
    const [showGuide, setShowGuide] = useState(true);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const profileTouchedRef = useRef(false);
    const selectedIdTouchedRef = useRef(false);
    const queueDoneHandledRef = useRef('');
    const coursesSigRef = useRef('');
    const detailSigRef = useRef('');
    /** Keep Control on SUCCESS after Update state / Submit until the server catches up. */
    const successLatchRef = useRef(false);
    const courseListScrollRef = useRef(null);
    const detailScrollRef = useRef(null);
    const savedScrollRef = useRef({ list: 0, detail: 0 });
    const userScrollingRef = useRef(false);
    const scrollIdleTimerRef = useRef(null);
    const [lumiVersion, setLumiVersion] = useState('');
    const [lumiOk, setLumiOk] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [localNotifs, setLocalNotifs] = useState([]);
    const [extNotifs, setExtNotifs] = useState([]);
    const [controlInstruct, setControlInstruct] = useState('');
    const [controlInstructBusy, setControlInstructBusy] = useState(false);
    const [hostLessons, setHostLessons] = useState([]);
    const [disabledLessonKeys, setDisabledLessonKeys] = useState(() => {
        try {
            const raw = localStorage.getItem('lumi_disabled_fill_lessons');
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    });
    const [questionMemoryRows, setQuestionMemoryRows] = useState([]);
    const [memoryBusy, setMemoryBusy] = useState(false);
    const [helperProbe, setHelperProbe] = useState(null);
    const [clearHostInput, setClearHostInput] = useState('');
    const notifFeed = useMemo(
        () => mergeNotifFeeds(extNotifs, localNotifs),
        [extNotifs, localNotifs]
    );
    const status = notifFeed[0]?.short || '';
    const pushNotif = useCallback((raw, kind) => {
        const short = shortenNotifyText(raw);
        if (!short) return;
        const k = kind || inferNotifKind(short);
        setLocalNotifs((prev) => {
            const head = prev[0];
            if (head && head.short === short && Date.now() - head.at < 1500) return prev;
            return [
                {
                    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    at: Date.now(),
                    short,
                    kind: k
                },
                ...prev
            ].slice(0, 50);
        });
    }, []);
    const setStatus = useCallback((raw) => {
        if (raw == null || raw === '') return;
        pushNotif(raw);
    }, [pushNotif]);
    const lastEventNotifRef = useRef('');
    const [busy, setBusy] = useState(false);
    const [dockBusy, setDockBusy] = useState(false);
    const [lumiPrefs, setLumiPrefs] = useState(() => loadLumiBidderPrefs());
    const stayInApp = !!lumiPrefs.stayInApp;
    const unattended = !!lumiPrefs.unattended;
    const captchaHelper = !!lumiPrefs.captchaHelper;
    const uploadCoverLetter = !!lumiPrefs.uploadCoverLetter;
    const [outlookStatus, setOutlookStatus] = useState(null);
    const [outlookBusy, setOutlookBusy] = useState(false);
    const [outlookDevice, setOutlookDevice] = useState(null);
    const [outlookMsg, setOutlookMsg] = useState('');
    const [liveRefreshKey, setLiveRefreshKey] = useState(0);
    const [lastRefreshedAt, setLastRefreshedAt] = useState(null);
    const [lightboxShot, setLightboxShot] = useState(null);
    const [queueState, setQueueState] = useState(null);
    const [dockOpen, setDockOpen] = useState(false);
    const [dockMinimized, setDockMinimized] = useState(() => readMonitorStorage().minimized);
    const [monitorFrameFollowLive, setMonitorFrameFollowLive] = useState(true);
    const [monitorFrameIndex, setMonitorFrameIndex] = useState(0);
    const [monitorActive, setMonitorActive] = useState(() => readMonitorStorage().active);
    const monitorActiveRef = useRef(monitorActive);
    monitorActiveRef.current = monitorActive;

    useEffect(() => {
        if (monitorActive) {
            setDockOpen(true);
            writeMonitorStorage({ active: true, minimized: dockMinimized });
        } else {
            writeMonitorStorage({ active: false });
        }
    }, [monitorActive, dockMinimized]);

    // Restore selected course after refresh so Live monitor can reload screenshots.
    useEffect(() => {
        const saved = readMonitorStorage();
        if (saved.courseId && !selectedId) {
            setSelectedId(saved.courseId);
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (selectedId) writeMonitorStorage({ courseId: Number(selectedId) });
    }, [selectedId]);

    // On page load: if Lumi queue is still running / paused, reopen Live monitor.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 5000);
                if (!alive) return;
                const st = res?.result || res?.data || null;
                setQueueState(st);
                if (Array.isArray(st?.uiMessageLog)) {
                    setExtNotifs(st.uiMessageLog);
                }
                const active = !!(
                    st?.running
                    || /^(?:running|awaiting_captcha|awaiting_email_otp|awaiting_next)$/i.test(String(st?.status || ''))
                );
                if (active) {
                    setMonitorActive(true);
                    setDockOpen(true);
                    writeMonitorStorage({ active: true });
                    setStatus(
                        /awaiting_captcha|awaiting_email_otp/i.test(String(st?.status || ''))
                            ? 'Restored — Lumi paused on CAPTCHA / login'
                            : 'Restored — Lumi still running'
                    );
                }
            } catch (_) {
                // Extension offline — keep localStorage monitor flag if set
                if (readMonitorStorage().active) {
                    setMonitorActive(true);
                    setDockOpen(true);
                }
            }
        })();
        return () => { alive = false; };
    }, []);

    const refreshOutlookStatus = useCallback(async () => {
        try {
            const { data } = await userAPI.getOutlookStatus();
            setOutlookStatus(data || null);
        } catch (_) {
            setOutlookStatus(null);
        }
    }, []);

    useEffect(() => {
        if (!open) return undefined;
        let alive = true;
        (async () => {
            try {
                const { data } = await userAPI.getOutlookStatus();
                if (alive) setOutlookStatus(data || null);
            } catch (_) {
                if (alive) setOutlookStatus(null);
            }
        })();
        return () => { alive = false; };
    }, [open]);

    const enableMailForward = useCallback(async (rotate = false) => {
        setOutlookBusy(true);
        setOutlookMsg('');
        try {
            const { data } = await userAPI.enableOutlookForward({ rotate });
            setOutlookStatus((prev) => ({
                ...(prev || {}),
                forward: data?.forward || null,
                config: { ...(prev?.config || {}), ...(data?.config || {}) }
            }));
            setOutlookMsg(rotate ? 'New forward token created' : 'Forward webhook enabled — no inbox polling');
            await refreshOutlookStatus();
        } catch (err) {
            setOutlookMsg(err?.response?.data?.error || err?.message || 'Enable forward failed');
        } finally {
            setOutlookBusy(false);
        }
    }, [refreshOutlookStatus]);

    const connectOutlookGraph = useCallback(async () => {
        setOutlookBusy(true);
        setOutlookMsg('');
        setOutlookDevice(null);
        try {
            const { data: started } = await userAPI.startOutlookDeviceCode();
            setOutlookDevice(started);
            setOutlookMsg(started?.message || `Open ${started?.verification_uri} and enter ${started?.user_code}`);
            const deviceCode = started?.device_code;
            if (!deviceCode) throw new Error('No device_code from server');
            const deadline = Date.now() + (Number(started?.expires_in) || 900) * 1000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, Math.max(4000, (Number(started?.interval) || 5) * 1000)));
                const { data: poll } = await userAPI.pollOutlookDeviceCode(deviceCode);
                if (poll?.status === 'connected') {
                    setOutlookDevice(null);
                    const email = poll.account?.email || 'Outlook';
                    setOutlookMsg(`Added ${email} — enabling push…`);
                    try {
                        if (poll.account?.id) {
                            await userAPI.subscribeOutlookPush({ mailbox_id: poll.account.id });
                        } else {
                            await userAPI.subscribeOutlookPush();
                        }
                        setOutlookMsg(`Listening on ${email} (and any other connected mailboxes)`);
                    } catch (subErr) {
                        setOutlookMsg(subErr?.response?.data?.error || subErr?.message || 'Connected, but push subscribe failed — check tunnel URL');
                    }
                    await refreshOutlookStatus();
                    return;
                }
                if (poll?.status === 'error') {
                    throw new Error(poll?.error || 'Outlook connect failed');
                }
            }
            throw new Error('Timed out — start Connect again');
        } catch (err) {
            setOutlookMsg(err?.response?.data?.error || err?.message || 'Graph connect failed');
            setOutlookDevice(null);
        } finally {
            setOutlookBusy(false);
        }
    }, [refreshOutlookStatus]);

    const removeOutlookMailbox = useCallback(async (mailboxId) => {
        setOutlookBusy(true);
        setOutlookMsg('');
        try {
            await userAPI.disconnectOutlookMailbox(mailboxId);
            setOutlookMsg('Mailbox removed');
            await refreshOutlookStatus();
        } catch (err) {
            setOutlookMsg(err?.response?.data?.error || err?.message || 'Remove failed');
        } finally {
            setOutlookBusy(false);
        }
    }, [refreshOutlookStatus]);

    const disconnectOutlookGraph = useCallback(async () => {
        setOutlookBusy(true);
        setOutlookMsg('');
        try {
            await userAPI.disconnectOutlook();
            setOutlookMsg('All Graph mailboxes disconnected');
            await refreshOutlookStatus();
        } catch (err) {
            setOutlookMsg(err?.response?.data?.error || err?.message || 'Disconnect failed');
        } finally {
            setOutlookBusy(false);
        }
    }, [refreshOutlookStatus]);

    const disableMailForward = useCallback(async () => {
        setOutlookBusy(true);
        setOutlookMsg('');
        try {
            await userAPI.disableOutlookForward();
            setOutlookStatus((prev) => ({ ...(prev || {}), forward: null }));
            setOutlookMsg('Forward webhook disabled');
            await refreshOutlookStatus();
        } catch (err) {
            setOutlookMsg(err?.response?.data?.error || err?.message || 'Disable failed');
        } finally {
            setOutlookBusy(false);
        }
    }, [refreshOutlookStatus]);

    const copyForwardUrl = useCallback(async () => {
        const url = outlookStatus?.forward?.webhook_url;
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            setOutlookMsg('Webhook URL copied');
        } catch (_) {
            setOutlookMsg(url);
        }
    }, [outlookStatus?.forward?.webhook_url]);

    const jobLinkIdsKey = (selectedLinks || []).map((l) => l.id).filter(Boolean).join(',');
    const jobLinkIds = useMemo(
        () => (jobLinkIdsKey ? jobLinkIdsKey.split(',').map((s) => Number(s)).filter(Boolean) : []),
        [jobLinkIdsKey]
    );

    const unsupportedSelected = useMemo(
        () =>
            (selectedLinks || []).filter((l) => {
                const url = l.job_apply_url || l.job_url || l.source_url || '';
                return url && isUnsupportedAtsLink(url);
            }),
        [selectedLinks]
    );

    const profileOptions = useMemo(() => {
        const byId = new Map();
        const statusRank = (s) => {
            const v = String(s || '').toLowerCase();
            if (v === 'ready') return 4;
            if (v === 'generating' || v === 'pending') return 3;
            if (v === 'failed') return 2;
            if (v) return 1;
            return 0;
        };
        const selectedCount = (selectedLinks || []).length;

        for (const p of profiles || []) {
            const id = Number(p.id || p.profile_id);
            if (!id) continue;
            byId.set(id, {
                id,
                first_name: p.first_name,
                last_name: p.last_name,
                techstacks: p.techstacks || [],
                is_default: !!p.is_default,
                generation_status: null,
                matched: false,
                matchCount: 0,
                selectedCount
            });
        }

        for (const link of selectedLinks || []) {
            for (const p of link.available_profiles || []) {
                const id = Number(p.profile_id || p.id);
                if (!id) continue;
                const prev = byId.get(id) || {
                    id,
                    first_name: p.first_name,
                    last_name: p.last_name,
                    techstacks: [],
                    is_default: false,
                    generation_status: null,
                    matched: true,
                    matchCount: 0,
                    selectedCount
                };
                const nextStatus = p.generation_status || null;
                const keepStatus =
                    statusRank(nextStatus) >= statusRank(prev.generation_status)
                        ? nextStatus
                        : prev.generation_status;
                byId.set(id, {
                    ...prev,
                    id,
                    first_name: prev.first_name || p.first_name,
                    last_name: prev.last_name || p.last_name,
                    techstacks: prev.techstacks?.length
                        ? prev.techstacks
                        : (p.techstacks || (p.techstack ? [p.techstack] : [])),
                    generation_status: keepStatus,
                    is_default: prev.is_default || !!p.is_default,
                    matched: true,
                    matchCount: (prev.matchCount || 0) + 1,
                    selectedCount,
                    application_status: p.status || prev.application_status || null
                });
            }
        }

        const sortProfiles = (a, b) => {
            if (a.matched !== b.matched) return a.matched ? -1 : 1;
            const ra = statusRank(a.generation_status);
            const rb = statusRank(b.generation_status);
            if (ra !== rb) return rb - ra;
            if ((b.matchCount || 0) !== (a.matchCount || 0)) return (b.matchCount || 0) - (a.matchCount || 0);
            if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
            return a.id - b.id;
        };

        return [...byId.values()].sort(sortProfiles);
    }, [profiles, selectedLinks]);

    const matchedProfileOptions = useMemo(
        () => profileOptions.filter((p) => p.matched),
        [profileOptions]
    );
    const otherProfileOptions = useMemo(
        () => profileOptions.filter((p) => !p.matched),
        [profileOptions]
    );
    // Bidding UI: matched profiles first; optionally include the rest.
    const selectableProfiles = useMemo(() => {
        if (!jobLinkIds.length) return profileOptions;
        if (showAllProfiles) return profileOptions;
        return matchedProfileOptions.length ? matchedProfileOptions : profileOptions;
    }, [jobLinkIds.length, showAllProfiles, profileOptions, matchedProfileOptions]);

    const profileStatusSuffix = (p) => {
        const parts = [];
        if (p.generation_status === 'ready') parts.push('ready');
        else if (p.generation_status === 'generating' || p.generation_status === 'pending') {
            parts.push(p.generation_status);
        } else if (p.generation_status === 'failed') parts.push('CV failed');
        else if (p.matched) parts.push('no CV');
        if (p.matched && p.selectedCount > 1 && p.matchCount < p.selectedCount) {
            parts.push(`${p.matchCount}/${p.selectedCount} jobs`);
        }
        if (p.is_default) parts.push('default');
        return parts.length ? ` · ${parts.join(' · ')}` : '';
    };

    const jobLinkById = useMemo(
        () => new Map((selectedLinks || []).map((l) => [Number(l.id), l])),
        [selectedLinks]
    );

    const bidReady = useMemo(
        () =>
            readyPreview.filter((r) => !isUnsupportedAtsLink(r.open_url || r.job_url)),
        [readyPreview]
    );

    const blockedAtsReady = useMemo(
        () =>
            readyPreview.filter((r) => isUnsupportedAtsLink(r.open_url || r.job_url)),
        [readyPreview]
    );

    const loadProfiles = useCallback(async () => {
        try {
            const api = isAdmin ? adminAPI : userAPI;
            const { data } = await api.getProfiles();
            const list = Array.isArray(data) ? data : data?.profiles || data?.data || [];
            setProfiles(list);
            setProfileId((prev) => {
                if (prev && list.some((p) => String(p.id) === String(prev))) return prev;
                let stored = '';
                try {
                    stored = localStorage.getItem(PROFILE_STORAGE_KEY) || '';
                } catch (_) { /* ignore */ }
                if (stored && list.some((p) => String(p.id) === String(stored))) return String(stored);
                const def = list.find((p) => p.is_default) || list[0];
                return def ? String(def.id) : prev || '';
            });
        } catch {
            setProfiles([]);
        }
    }, [isAdmin]);

    const pingLumi = useCallback(async () => {
        try {
            // Reinject first when the bridge looks stale — avoids hard-refresh after Reload Lumi.
            const storedVer = getLumiBridgeVersion();
            if (!storedVer || !versionAtLeast(storedVer, MIN_LUMI_VERSION)) {
                try { await reinjectLumiBridge(6000); } catch (_) { /* try ping anyway */ }
            }
            const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_PING', 8000);
            const ver = res?.version || res?.result?.version || getLumiBridgeVersion() || '';
            setLumiVersion(ver || '');
            setLumiOk(versionAtLeast(ver, MIN_LUMI_VERSION));
            return ver;
        } catch {
            try {
                await reinjectLumiBridge(6000);
                const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_PING', 8000);
                const ver = res?.version || res?.result?.version || getLumiBridgeVersion() || '';
                setLumiVersion(ver || '');
                setLumiOk(versionAtLeast(ver, MIN_LUMI_VERSION));
                return ver;
            } catch {
                const stale = getLumiBridgeVersion() || '';
                setLumiVersion(stale);
                setLumiOk(false);
                return '';
            }
        }
    }, []);

    const refreshStudyingPanel = useCallback(async () => {
        setMemoryBusy(true);
        try {
            const [{ data: mem }, helpersRaw] = await Promise.all([
                userAPI.listQuestionMemory({ limit: 40 }).catch(() => ({ data: { rows: [] } })),
                sendBidderExtensionCommand('JOB_APPLY_BIDDER_PROBE_HELPERS', 5000).catch(() => null)
            ]);
            const rows = Array.isArray(mem?.rows)
                ? mem.rows
                : (Array.isArray(mem?.data?.rows) ? mem.data.rows : []);
            setQuestionMemoryRows(rows);
            const helpers = helpersRaw?.result || helpersRaw;
            if (helpers && helpers.ok !== false) {
                setHelperProbe({
                    nopecha: !!helpers.nopecha,
                    buster: !!helpers.buster,
                    helper_missing: !!helpers.helper_missing,
                    probed: helpers.probed != null ? !!helpers.probed : true
                });
            }
            try {
                await sendBidderExtensionCommand('JOB_APPLY_BIDDER_SAVE_PREFS', 5000, {
                    prefs: { bidderDisabledFillLessons: disabledLessonKeys }
                });
            } catch (_) { /* ignore */ }
        } finally {
            setMemoryBusy(false);
        }
    }, [disabledLessonKeys]);

    useEffect(() => {
        if (!showAdvanced || !open) return undefined;
        refreshStudyingPanel();
        return undefined;
    }, [showAdvanced, open, refreshStudyingPanel]);

    const captureScroll = () => {
        savedScrollRef.current = {
            list: courseListScrollRef.current?.scrollTop || 0,
            detail: detailScrollRef.current?.scrollTop || 0
        };
    };
    const restoreScroll = () => {
        const apply = () => {
            if (courseListScrollRef.current) {
                courseListScrollRef.current.scrollTop = savedScrollRef.current.list;
            }
            if (detailScrollRef.current) {
                detailScrollRef.current.scrollTop = savedScrollRef.current.detail;
            }
        };
        // Double rAF: wait for React commit + browser layout.
        requestAnimationFrame(() => requestAnimationFrame(apply));
    };
    const onUserScroll = (which) => (e) => {
        const top = e.currentTarget.scrollTop;
        if (which === 'list') savedScrollRef.current.list = top;
        else savedScrollRef.current.detail = top;
        userScrollingRef.current = true;
        if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = setTimeout(() => {
            userScrollingRef.current = false;
        }, 900);
    };

    useLayoutEffect(() => {
        if (courseListScrollRef.current) {
            courseListScrollRef.current.scrollTop = savedScrollRef.current.list;
        }
        if (detailScrollRef.current) {
            detailScrollRef.current.scrollTop = savedScrollRef.current.detail;
        }
    }, [courses, detail]);

    const loadList = useCallback(async (opts = {}) => {
        const silent = !!opts.silent;
        if (silent && userScrollingRef.current) return;
        try {
            if (!silent) setLoading(true);
            if (!silent) setError('');
            const params = { limit: 100 };
            if (profileId) params.profile_id = profileId;
            const { data } = await coursesApi.listBidCourses(params);
            let list = data?.courses || [];

            const linkIdSet = new Set(jobLinkIds.map(Number));
            const scoreCourse = (c) => {
                let score = 0;
                if (linkIdSet.size && linkIdSet.has(Number(c.job_link_id))) score += 100;
                if (profileId && String(c.profile_id) === String(profileId)) score += 20;
                if (isFailureEvent(lastStatusEvent(c).event_type)) score += 5;
                const t = new Date(c.updated_at || c.created_at || 0).getTime();
                score += Math.min(10, t / 1e12);
                return score;
            };
            list = [...list].sort((a, b) => scoreCourse(b) - scoreCourse(a));

            if (linkIdSet.size) {
                const matched = list.filter((c) => linkIdSet.has(Number(c.job_link_id)));
                const rest = list.filter((c) => !linkIdSet.has(Number(c.job_link_id)));
                list = matched.length ? [...matched, ...rest] : list;
            }

            const sig = list
                .map((c) => `${c.id}:${c.last_event_type || ''}:${c.outcome || ''}:${c.updated_at || ''}`)
                .join('|');
            if (sig !== coursesSigRef.current) {
                coursesSigRef.current = sig;
                captureScroll();
                setCourses(list);
            }

            setSelectedId((prev) => {
                if (prev && list.some((c) => String(c.id) === String(prev))) return prev;
                // Never auto-jump while user is browsing the list
                if (selectedIdTouchedRef.current && prev) return prev;

                const forLinks = linkIdSet.size
                    ? list.filter((c) => linkIdSet.has(Number(c.job_link_id)))
                    : list;
                const forProfile = profileId
                    ? forLinks.filter((c) => String(c.profile_id) === String(profileId))
                    : forLinks;
                const pool = forProfile.length ? forProfile : forLinks.length ? forLinks : list;
                const active =
                    pool.find((c) => {
                        const t = lastStatusEvent(c).event_type;
                        return !isFailureEvent(t) && !/needs_captcha|captcha_abandoned|login_wall/i.test(t);
                    })
                    || pool[0]
                    || null;
                return active?.id ?? null;
            });
        } catch (err) {
            if (!silent) setError(err.response?.data?.error || err.message || 'Failed to load courses');
        } finally {
            if (!silent) setLoading(false);
        }
    }, [coursesApi, jobLinkIds, profileId]);

    const loadReadyPreview = useCallback(async () => {
        if (!jobLinkIds.length) {
            setReadyPreview([]);
            return;
        }
        try {
            const params = {
                limit: 200,
                job_link_ids: jobLinkIds.join(',')
            };
            if (profileId) params.profile_id = profileId;
            const { data } = await userAPI.listBidderReady(params);
            setReadyPreview(data?.items || []);
        } catch {
            setReadyPreview([]);
        }
    }, [jobLinkIds, profileId]);

    const loadDetail = useCallback(async (courseId, opts = {}) => {
        if (!courseId) {
            setDetail(null);
            return;
        }
        if (opts.silent && userScrollingRef.current) return;
        const bumpLive = opts.bumpLive !== false;
        try {
            const { data } = await coursesApi.getBidCourse(courseId, { lite: !!opts.silent });
            const shots = data?.screenshots || data?.disk_screenshots || [];
            const lastEv = data?.events?.length ? data.events[data.events.length - 1] : null;
            const events = Array.isArray(data?.events) ? data.events : [];
            const hasRevoke = events.some((e) => /success_revoked|false_success_cleared/i.test(e?.event_type || ''));
            const hasSuccessAfterRevoke = (() => {
                let revokeIdx = -1;
                let successIdx = -1;
                for (let i = 0; i < events.length; i += 1) {
                    const t = events[i]?.event_type || '';
                    if (/success_revoked|false_success_cleared/i.test(t)) revokeIdx = i;
                    if (isSuccessEvent(t)) successIdx = i;
                }
                return successIdx > revokeIdx;
            })();
            const serverSuccess = !!(
                !opts.clearFalseSuccess
                && (data?.course?.outcome === 'applied' || data?.course?.applied_at || data?.application?.status === 'applied')
                && (!hasRevoke || hasSuccessAfterRevoke)
            ) || !!(
                !opts.clearFalseSuccess
                && hasSuccessAfterRevoke
            );
            if (serverSuccess) successLatchRef.current = false;
            if (opts.clearFalseSuccess) successLatchRef.current = false;
            const sig = [
                data?.course?.id,
                data?.course?.outcome,
                data?.application?.status,
                lastEv?.event_type,
                lastEv?.id,
                shots.map((s) => `${s.stage}:${s.filename}:${s.updated_ms || s.created_at || ''}`).join(','),
                successLatchRef.current ? 'latch' : '',
                opts.clearFalseSuccess ? 'cleared' : ''
            ].join('|');
            if (sig === detailSigRef.current && opts.silent) {
                // Metadata unchanged — still bust the image blob so an overwritten
                // live.png (same name/mtime bucket) actually appears.
                if (opts.bumpLive !== false) {
                    setLiveRefreshKey((k) => k + 1);
                    setLastRefreshedAt(Date.now());
                }
                return;
            }
            detailSigRef.current = sig;
            captureScroll();
            setDetail((prev) => {
                if (!data) return prev;
                if (opts.clearFalseSuccess) {
                    return {
                        ...data,
                        course: {
                            ...data.course,
                            outcome: data.course?.outcome === 'applied' ? 'unknown' : (data.course?.outcome || 'unknown'),
                            applied_at: null,
                            last_event_type: /success_revoked/i.test(lastEv?.event_type || '')
                                ? lastEv.event_type
                                : (data.course?.last_event_type || 'fill_incomplete')
                        },
                        application: data.application
                            ? {
                                ...data.application,
                                status: data.application.status === 'applied' ? 'pending' : data.application.status
                            }
                            : data.application
                    };
                }
                const keepSuccess = successLatchRef.current
                    || prev?.course?.outcome === 'applied'
                    || !!prev?.course?.applied_at
                    || prev?.application?.status === 'applied';
                if (!keepSuccess || serverSuccess || !data.course) return data;
                // Control detected thank-you before list/detail fully synced — do not wipe SUCCESS.
                const latchEvent = {
                    event_type: 'marked_applied',
                    meta: { via: 'control_success_latch', success: true },
                    at: new Date().toISOString()
                };
                const hasMarked = (data.events || []).some((e) => isSuccessEvent(e?.event_type));
                return {
                    ...data,
                    course: {
                        ...data.course,
                        outcome: 'applied',
                        applied_at: data.course.applied_at
                            || prev?.course?.applied_at
                            || new Date().toISOString(),
                        last_event_type: 'marked_applied',
                        last_event_meta: { via: 'control_success_latch', success: true }
                    },
                    application: data.application
                        ? { ...data.application, status: 'applied' }
                        : data.application,
                    events: hasMarked
                        ? data.events
                        : [...(Array.isArray(data.events) ? data.events : []), latchEvent]
                };
            });
            if (bumpLive) {
                setLiveRefreshKey((k) => k + 1);
                setLastRefreshedAt(Date.now());
            }
        } catch (err) {
            if (!opts.silent) {
                setError(err.response?.data?.error || err.message || 'Failed to load course');
            }
        }
    }, [coursesApi]);

    useEffect(() => {
        if (!open && !monitorActive) return undefined;
        loadProfiles();
        loadList();
        if (open) pingLumi();
        const t = setInterval(() => {
            loadList({ silent: true });
            if (open || monitorActive) loadReadyPreview();
        }, 15000);
        return () => clearInterval(t);
    }, [open, monitorActive, loadProfiles, loadList, loadReadyPreview, pingLumi]);

    // When Lumi reinjects after Reload, pick up the new version without a page refresh.
    useEffect(() => {
        if (!open) return undefined;
        return listenForLumiBridgeReady(({ version }) => {
            if (!version) return;
            setLumiVersion(version);
            setLumiOk(versionAtLeast(version, MIN_LUMI_VERSION));
        });
    }, [open]);

    useEffect(() => {
        if (!open) return;
        loadReadyPreview();
    }, [open, loadReadyPreview, profileId]);

    useEffect(() => {
        if (!selectedId) {
            if (!monitorActive) setDetail(null);
            return;
        }
        if (!open && !monitorActive) {
            setDetail(null);
            return;
        }
        // Drop previous course frames immediately — do not keep last job's screenshot.
        setDetail(null);
        setMonitorFrameIndex(0);
        setMonitorFrameFollowLive(true);
        setLiveRefreshKey((k) => k + 1);
        detailSigRef.current = '';
        loadDetail(selectedId, { silent: false, bumpLive: true });
    }, [open, selectedId, loadDetail, monitorActive]);

    // Live screenshot: refresh only when status / liveShotAt changes (not every 3s).
    // Queue poll is ≤500ms while bidding so the UI can pick up the new frame quickly.
    useEffect(() => {
        const watching = (open && selectedId) || (monitorActive && selectedId);
        if (!watching) return undefined;
        const activeBid = !!(queueState?.running || /awaiting_captcha|awaiting_email_otp/i.test(String(queueState?.status || '')));
        const listTimer = setInterval(() => {
            loadList({ silent: true });
        }, activeBid ? 10000 : 20000);
        return () => {
            clearInterval(listTimer);
        };
    }, [open, selectedId, monitorActive, loadList, queueState?.running, queueState?.status]);

    const liveStatusSigRef = useRef('');
    const prevLiveShotAtRef = useRef('');
    useEffect(() => {
        const watching = (open && selectedId) || (monitorActive && selectedId);
        if (!watching || !selectedId) return undefined;
        const shotAt = String(queueState?.liveShotAt || '');
        const sig = [
            queueState?.status || '',
            queueState?.lastStatusAt || '',
            shotAt,
            queueState?.currentId || '',
            queueState?.lastStatusEvent || ''
        ].join('|');
        if (sig === liveStatusSigRef.current) return undefined;
        liveStatusSigRef.current = sig;
        const shotChanged = !!(shotAt && shotAt !== prevLiveShotAtRef.current);
        if (shotAt) prevLiveShotAtRef.current = shotAt;
        // Shot already uploaded → refresh now. Status-only → short wait for capture.
        const delay = shotChanged ? 0 : 200;
        const t = setTimeout(() => {
            loadDetail(selectedId, { silent: true, bumpLive: true });
        }, delay);
        return () => clearTimeout(t);
    }, [
        open,
        selectedId,
        monitorActive,
        loadDetail,
        queueState?.status,
        queueState?.lastStatusAt,
        queueState?.liveShotAt,
        queueState?.currentId,
        queueState?.lastStatusEvent
    ]);

    // Tick "updated Xs ago" lives inside BidMonitorDock — avoid re-rendering the dialog every second.

    // Follow active bidding course only when user hasn't picked one manually.
    useEffect(() => {
        if (!monitorActive || !courses.length) return;
        if (selectedIdTouchedRef.current) return;
        const appId = queueState?.currentId || queueState?.captchaApplicationId;
        if (appId) {
            const match = courses.find((c) => String(c.application_id) === String(appId));
            if (match && String(selectedId) !== String(match.id)) {
                setSelectedId(match.id);
                setWorkspaceTab('form');
            }
        }
    }, [monitorActive, courses, selectedId, queueState?.currentId, queueState?.captchaApplicationId]);

    // Reset pickers when selection of job links changes.
    useEffect(() => {
        profileTouchedRef.current = false;
        selectedIdTouchedRef.current = false;
        setShowAllProfiles(false);
        queueDoneHandledRef.current = '';
    }, [jobLinkIdsKey]);

    // Auto-pick a matched ready profile only when the user hasn't chosen yet.
    useEffect(() => {
        if (!open || !selectableProfiles.length) return;
        if (profileTouchedRef.current && profileId
            && selectableProfiles.some((p) => String(p.id) === String(profileId))) {
            return;
        }
        if (profileId && selectableProfiles.some((p) => String(p.id) === String(profileId))) return;

        const ready = selectableProfiles.find((p) => p.generation_status === 'ready');
        const next = ready || selectableProfiles[0];
        if (next) setProfileId(String(next.id));
    }, [open, selectableProfiles, profileId]);

    const onProfileChange = (value) => {
        profileTouchedRef.current = true;
        setProfileId(String(value));
        selectedIdTouchedRef.current = false; // allow course list to retarget for new profile
        try {
            localStorage.setItem(PROFILE_STORAGE_KEY, String(value));
        } catch (_) { /* ignore */ }
    };

    const runExt = async (type, label, extra = {}) => {
        setBusy(true);
        setError('');
        setStatus(`${label}…`);
        try {
            const res = await sendBidderExtensionCommand(
                type,
                type === 'JOB_APPLY_BIDDER_PROCESS_QUEUE' ? 20000 : 8000,
                extra
            );
            if (type === 'JOB_APPLY_BIDDER_PROCESS_QUEUE') {
                if (res?.alreadyRunning) {
                    // Soft notice — queue is already active (often paused on CAPTCHA).
                    setError('');
                    setStatus(res.message || 'Queue already in progress — use Live monitor.');
                    setMonitorActive(true);
                    setDockOpen(true);
                    setDockMinimized(false);
                    writeMonitorStorage({ active: true, minimized: false });
                } else if (res?.ok === false || res?.error) {
                    const errMsg = String(res.error || 'Process failed');
                    // Legacy extension copy — treat as soft notice too.
                    if (/queue already running/i.test(errMsg)) {
                        setError('');
                        setStatus(
                            'Queue already in progress (often paused on CAPTCHA). Use Live monitor: Resume / Next / Stop — do not click Process again.'
                        );
                        setMonitorActive(true);
                        setDockOpen(true);
                        setDockMinimized(false);
                    } else {
                        setError(errMsg);
                        setStatus('');
                    }
                } else if (res?.started && Number(res?.queued) > 0) {
                    setStatus(`Queue started — ${res.queued} ready application(s). Watch the Live monitor (bottom-right).`);
                    setMonitorActive(true);
                    setDockOpen(true);
                    setDockMinimized(true);
                    writeMonitorStorage({ active: true, minimized: true });
                    // Close the big dialog so Job Links / other work stays usable.
                    onOpenChange?.(false);
                    if (stayInApp) {
                        setStatus(
                            `Queue started — ${res.queued} job(s). Dialog closed · Live monitor bottom-right · you can use other tabs.`
                        );
                    }
                } else if (res?.started && (res?.queued == null || Number(res.queued) === 0)) {
                    setError(
                        `Lumi did not queue any jobs (extension ${lumiVersion || 'outdated'}). Open chrome://extensions → Reload Lumi (need ${MIN_LUMI_VERSION}+), then Process again.`
                    );
                    setStatus('');
                } else {
                    setStatus(`Bidding via Lumi${res?.queued != null ? ` · queued ${res.queued}` : ''}`);
                }
            } else {
                setStatus(`${label}${res?.ok ? ' OK' : ''}`);
            }
            await loadList();
            await loadReadyPreview();
            if (selectedId) await loadDetail(selectedId);
        } catch (err) {
            setError(err.message || 'Extension command failed');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const runDockControl = async (fn, label) => {
        setDockBusy(true);
        setError('');
        setStatus(`${label}…`);
        try {
            await fn();
        } catch (err) {
            setError(err.message || `${label} failed`);
            setStatus('');
        } finally {
            setDockBusy(false);
        }
    };

    useEffect(() => {
        // Keep queue state alive for Live monitor controls even after Process closes the dialog.
        // While bidding, poll ≤500ms so status + liveShotAt hit the UI within the 0.5s budget.
        const watching = open || monitorActive || dockOpen;
        if (!watching) return undefined;
        let alive = true;
        const activeBid = !!(
            queueState?.running
            || /^(?:running|awaiting_captcha|awaiting_email_otp|awaiting_next)$/i.test(String(queueState?.status || ''))
        );
        const poll = async () => {
            try {
                const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
                if (!alive) return;
                const st = res?.result || res?.data || null;
                setQueueState(st);
                if (Array.isArray(st?.uiMessageLog)) {
                    setExtNotifs(st.uiMessageLog);
                }
            } catch {
                if (alive) setQueueState(null);
            }
        };
        poll();
        const t = setInterval(poll, activeBid ? 250 : 4000);
        return () => {
            alive = false;
            clearInterval(t);
        };
    }, [open, monitorActive, dockOpen, queueState?.running, queueState?.status]);

    // Push a short feed line when the active job's status event changes.
    useEffect(() => {
        const ev = String(queueState?.lastStatusEvent || '');
        const at = String(queueState?.lastStatusAt || '');
        if (!ev) return;
        const sig = `${ev}|${at}|${queueState?.currentId || ''}`;
        if (lastEventNotifRef.current === sig) return;
        lastEventNotifRef.current = sig;
        const line = shortEventNotify({
            eventType: ev,
            meta: queueState?.lastStatusMeta || null,
            queueStatus: queueState?.status || ''
        });
        if (line) pushNotif(line, inferNotifKind(line));
    }, [
        queueState?.lastStatusEvent,
        queueState?.lastStatusAt,
        queueState?.lastStatusMeta,
        queueState?.currentId,
        queueState?.status,
        pushNotif
    ]);

    const awaitingCaptcha = /awaiting_captcha|awaiting_email_otp/i.test(String(queueState?.status || ''));
    const captchaKind = queueState?.captchaKind === 'login' ? 'login' : 'captcha';
    // Prefer the course shown in Live/Control — not whatever the queue last touched.
    const detailAppId = Number(
        detail?.course?.application_id
        || detail?.application?.id
        || 0
    ) || null;
    const queueAppId = Number(
        queueState?.currentId
        || queueState?.captchaApplicationId
        || queueState?.lastApplicationId
        || 0
    ) || null;
    const tabMapAppId = detailAppId || queueAppId;
    const ownedTabId = Number(
        (tabMapAppId && queueState?.tabsByAppId?.[String(tabMapAppId)])
        || queueState?.ownedTabId
        || (awaitingCaptcha ? queueState?.captchaTabId : null)
        || queueState?.currentTabId
        || 0
    ) || null;
    const ownedTabMapped = !!ownedTabId;
    const captchaTabMissing = !!queueState?.captchaTabMissing
        || (awaitingCaptcha && !ownedTabId);
    const viewingActiveQueueJob = !!(detailAppId && queueAppId && detailAppId === queueAppId);
    const captchaApplyUrl = viewingActiveQueueJob
        ? (pickApplyOpenUrl(
            queueState?.currentJobUrl,
            queueState?.ownedTabUrl,
            queueState?.captchaJobUrl,
            detail?.application?.open_url,
            detail?.application?.job_url,
            detail?.course?.job_url,
            primaryJobUrl(
                selectedLinks.find((l) => Number(l.id) === Number(detail?.course?.job_link_id))
            )
        ) || null)
        : (pickApplyOpenUrl(
            detail?.application?.open_url,
            detail?.application?.job_url,
            detail?.course?.job_url,
            primaryJobUrl(
                selectedLinks.find((l) => Number(l.id) === Number(detail?.course?.job_link_id))
            ),
            queueState?.currentJobUrl,
            queueState?.ownedTabUrl,
            queueState?.captchaJobUrl
        ) || null);

    const lessonHost = useMemo(() => {
        const raw = captchaApplyUrl || queueState?.ownedTabUrl || queueState?.currentJobUrl || '';
        try {
            return new URL(String(raw)).hostname.replace(/^www\./i, '');
        } catch {
            return '';
        }
    }, [captchaApplyUrl, queueState?.ownedTabUrl, queueState?.currentJobUrl]);

    useEffect(() => {
        if (!lessonHost || !open) {
            setHostLessons([]);
            return undefined;
        }
        let cancelled = false;
        (async () => {
            try {
                const { data } = await userAPI.listBidderFillLessons({ host: lessonHost });
                if (cancelled) return;
                const list = Array.isArray(data?.lessons) ? data.lessons : [];
                setHostLessons(list.map((les) => {
                    const key = `${les.host || lessonHost}|${les.field_key || les.fieldKey || 'form'}|${les.issue_key || les.issueKey || ''}`;
                    return { ...les, disabled: !!disabledLessonKeys[key] };
                }));
            } catch {
                if (!cancelled) setHostLessons([]);
            }
        })();
        return () => { cancelled = true; };
    }, [lessonHost, open, disabledLessonKeys]);

    const dockHostLessons = useMemo(
        () => hostLessons.slice(0, 6),
        [hostLessons]
    );

    const courseStats = useMemo(() => {
        const stats = { success: 0, filled: 0, failed: 0, attention: 0, running: 0, unknown: 0 };
        for (const c of courses || []) {
            const kind = courseRunStatus(c).kind;
            if (stats[kind] != null) stats[kind] += 1;
            else stats.unknown += 1;
        }
        return stats;
    }, [courses]);

    const filteredCourses = useMemo(() => {
        const list = courses || [];
        if (outcomeFilter === 'all') return list;
        return list.filter((c) => courseRunStatus(c).kind === outcomeFilter);
    }, [courses, outcomeFilter]);

    const queueStatusLabel = (() => {
        const s = String(queueState?.status || '');
        if (/awaiting_email_otp/i.test(s)) return 'Paused — email security code (Instruct Lumi)';
        if (/awaiting_captcha/i.test(s)) return 'Paused — CAPTCHA / login';
        if (/awaiting_next/i.test(s)) return 'Waiting — click Next for the next job';
        if (/running/i.test(s)) return 'Bidding in progress…';
        if (/done/i.test(s)) {
            const n = queueState?.processed;
            const skip = queueState?.skippedAts;
            return `Queue finished${n != null ? ` — ${n} processed` : ''}${skip ? ` · ${skip} skipped` : ''}`;
        }
        if (/stopped/i.test(s)) return 'Queue stopped';
        if (/empty/i.test(s)) return 'Nothing to bid';
        return '';
    })();

    // When queue finishes once, refresh badges — do not loop.
    useEffect(() => {
        const s = String(queueState?.status || '');
        if (!/^(done|stopped)$/i.test(s)) return;
        const key = `${s}:${queueState?.processed ?? ''}:${queueState?.skippedAts ?? ''}`;
        if (queueDoneHandledRef.current === key) return;
        queueDoneHandledRef.current = key;
        loadList({ silent: true });
        if (selectedId) loadDetail(selectedId, { silent: true });
        if (/done/i.test(s)) {
            setStatus(
                `Queue finished — ${queueState?.processed ?? 0} processed`
                + (queueState?.skippedAts ? ` · ${queueState.skippedAts} unsupported skipped` : '')
                + '. Check Bid courses for Success / Failed.'
            );
        }
    }, [queueState?.status, queueState?.processed, queueState?.skippedAts, loadList, loadDetail, selectedId]);

    const resumeCaptcha = async ({ force = true, focusTab = true } = {}) => {
        setBusy(true);
        setError('');
        setStatus(force ? 'Resuming after CAPTCHA…' : 'Checking CAPTCHA…');
        try {
            await sendBidderExtensionCommand('JOB_APPLY_BIDDER_CAPTCHA_RESUME', 8000, {
                force,
                kick: true,
                focusTab,
                url: captchaApplyUrl || undefined
            });
            setStatus('CAPTCHA resume signaled — fill continues when clear');
            await loadList();
            if (selectedId) await loadDetail(selectedId);
        } catch (err) {
            setError(err.message || 'CAPTCHA resume failed');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const openCaptchaTab = async () => {
        setBusy(true);
        setError('');
        try {
            const url = captchaApplyUrl || undefined;
            const applicationId = detailAppId
                || queueAppId
                || undefined;
            // Always prefer the tab mapped to THIS course; never a random apply tab.
            const mappedTab = applicationId
                ? (queueState?.tabsByAppId?.[String(applicationId)]
                    || queueState?.ownedTabId
                    || undefined)
                : undefined;
            const willReopenEmpty = captchaTabMissing || !mappedTab;
            if (willReopenEmpty && url) {
                const ok = window.confirm(
                    'The owned apply tab is closed. Reopen it? The form will be empty and may need Re-fill.'
                );
                if (!ok) {
                    setStatus('Focus cancelled — owned tab still closed');
                    return;
                }
            }
            const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_CAPTCHA_FOCUS_TAB', 12000, {
                url,
                applicationId,
                forceNavigate: false,
                preferExistingTab: true,
                tabId: mappedTab
                    || (viewingActiveQueueJob
                        ? (queueState?.captchaTabId || queueState?.currentTabId || undefined)
                        : undefined)
            });
            const body = res?.result || res?.data || res || {};
            const reopened = !!(res?.reopened || body.reopened);
            const navigated = !!(res?.navigated || body.navigated);
            const focusedExisting = !!(res?.focusedExisting || body.focusedExisting);
            const focusedUrl = body.url || res?.url || '';
            setStatus(
                focusedExisting
                    ? `Focused apply tab for this job${focusedUrl ? ` — ${String(focusedUrl).slice(0, 60)}` : ''}`
                    : reopened
                        ? 'Reopened apply tab (previous tab was closed — form may be empty)'
                        : navigated
                            ? 'Switched apply tab to this job’s URL'
                            : 'Opened apply tab'
            );
            setError('');
        } catch (err) {
            setError(
                err.message
                || 'Could not open apply tab. Try Skip, or Process again after Reload Lumi.'
            );
        } finally {
            setBusy(false);
        }
    };

    const reAutofillCurrentJob = async () => {
        setBusy(true);
        setError('');
        setStatus('Re-autofilling current apply tab…');
        try {
            const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_REAUTOFILL', 180000, {
                url: captchaApplyUrl || queueState?.currentJobUrl || undefined,
                applicationId: queueState?.currentId
                    || queueState?.captchaApplicationId
                    || queueState?.lastApplicationId
                    || undefined
            });
            const body = res?.result || res?.data || res || {};
            const filled = Number(body.filled ?? res?.filled ?? 0);
            const submitClicked = !!(body.submitClicked ?? res?.submitClicked);
            const incomplete = !!(body.incomplete ?? res?.incomplete);
            const reopened = !!(body.reopened ?? res?.reopened);
            setStatus(
                submitClicked
                    ? `Re-autofill done — submit clicked (${filled} fields)${reopened ? ' · tab reopened' : ''}`
                    : incomplete
                        ? `Re-autofill finished — still incomplete (${filled} fields). Check Open tab.`
                        : `Re-autofill filled ${filled} field(s)${reopened ? ' · tab reopened' : ''}`
            );
            setError('');
            setDockOpen(true);
            setMonitorActive(true);
        } catch (err) {
            setError(err.message || 'Re-autofill failed');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const updateApplyState = async () => {
        setBusy(true);
        setError('');
        setStatus('Updating state from apply tab…');
        try {
            const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_UPDATE_STATE', 45000, {
                applicationId: detailAppId
                    || queueState?.currentId
                    || queueState?.captchaApplicationId
                    || queueState?.lastApplicationId
                    || undefined
            });
            const body = res?.result || res?.data || res || {};
            if (body.success) {
                setStatus('Update state — site thank-you detected (SUCCESS)');
                successLatchRef.current = true;
                // Optimistic SUCCESS so Control does not stay on stale FILLED / 90%.
                setDetail((prev) => {
                    if (!prev?.course) return prev;
                    return {
                        ...prev,
                        course: {
                            ...prev.course,
                            outcome: 'applied',
                            applied_at: prev.course.applied_at || new Date().toISOString(),
                            last_event_type: 'marked_applied',
                            last_event_meta: { via: 'control_update_state', success: true }
                        },
                        application: prev.application
                            ? { ...prev.application, status: 'applied' }
                            : prev.application,
                        events: [
                            ...(Array.isArray(prev.events) ? prev.events : []),
                            {
                                event_type: 'marked_applied',
                                meta: { via: 'control_update_state', success: true },
                                at: new Date().toISOString()
                            }
                        ]
                    };
                });
                try {
                    const qs = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
                    setQueueState(qs?.result || qs?.data || null);
                } catch (_) { /* ignore */ }
                await loadList({ silent: true });
            } else if (body.incomplete) {
                // Clear false SUCCESS from prior "customer success" regex / latch.
                successLatchRef.current = false;
                const miss = Array.isArray(body.missing) ? body.missing.filter(Boolean).slice(0, 3).join('; ') : '';
                setStatus(
                    `Update state — form still open / incomplete (cleared false SUCCESS)`
                    + (body.requiredOk != null && body.requiredTotal != null
                        ? ` (${body.requiredOk}/${body.requiredTotal} required)`
                        : '')
                    + (miss ? ` · missing: ${miss}` : '')
                );
                setDetail((prev) => {
                    if (!prev?.course) return prev;
                    const at = new Date().toISOString();
                    return {
                        ...prev,
                        course: {
                            ...prev.course,
                            outcome: 'unknown',
                            applied_at: null,
                            last_event_type: body.statusEvent || 'fill_incomplete',
                            last_event_meta: {
                                via: 'control_update_state',
                                success: false,
                                revoked: true
                            }
                        },
                        application: prev.application
                            ? { ...prev.application, status: 'pending' }
                            : prev.application,
                        events: [
                            ...(Array.isArray(prev.events) ? prev.events : []),
                            {
                                event_type: 'success_revoked',
                                meta: { via: 'control_update_state', reason: body.detectReason || 'form_still_open' },
                                at
                            },
                            {
                                event_type: body.statusEvent || 'fill_incomplete',
                                meta: { via: 'control_update_state', success: false },
                                at
                            }
                        ]
                    };
                });
                try {
                    const qs = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
                    setQueueState(qs?.result || qs?.data || null);
                } catch (_) { /* ignore */ }
                await loadList({ silent: true });
            } else {
                successLatchRef.current = false;
                setStatus('Update state — form open (not SUCCESS) — cleared false SUCCESS if any');
                setDetail((prev) => {
                    if (!prev?.course) return prev;
                    const at = new Date().toISOString();
                    return {
                        ...prev,
                        course: {
                            ...prev.course,
                            outcome: prev.course.outcome === 'applied' ? 'unknown' : prev.course.outcome,
                            applied_at: null,
                            last_event_type: body.statusEvent || 'ready_to_submit',
                            last_event_meta: { via: 'control_update_state', success: false, revoked: true }
                        },
                        application: prev.application?.status === 'applied'
                            ? { ...prev.application, status: 'pending' }
                            : prev.application,
                        events: [
                            ...(Array.isArray(prev.events) ? prev.events : []),
                            {
                                event_type: 'success_revoked',
                                meta: { via: 'control_update_state', reason: body.detectReason || 'not_thank_you' },
                                at
                            }
                        ]
                    };
                });
                try {
                    const qs = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
                    setQueueState(qs?.result || qs?.data || null);
                } catch (_) { /* ignore */ }
            }
            if (selectedId) {
                detailSigRef.current = '';
                await loadDetail(selectedId, {
                    silent: false,
                    bumpLive: true,
                    clearFalseSuccess: !body.success
                });
            }
            setLiveRefreshKey((k) => k + 1);
            setLastRefreshedAt(Date.now());
            setMonitorFrameFollowLive(true);
            setDockOpen(true);
            setMonitorActive(true);
        } catch (err) {
            setError(err.message || 'Update state failed');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const submitApplyFromControl = async () => {
        setBusy(true);
        setError('');
        setStatus('Clicking Submit on apply tab…');
        try {
            const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_SUBMIT', 60000, {
                force: true,
                applicationId: detailAppId
                    || queueState?.currentId
                    || queueState?.captchaApplicationId
                    || queueState?.lastApplicationId
                    || undefined
            });
            const body = res?.result || res?.data || res || {};
            if (body.success || body.alreadySubmitted) {
                setStatus(body.alreadySubmitted
                    ? 'Already submitted — marked SUCCESS'
                    : 'Submit clicked — thank-you detected (SUCCESS)');
                successLatchRef.current = true;
                setDetail((prev) => {
                    if (!prev?.course) return prev;
                    return {
                        ...prev,
                        course: {
                            ...prev.course,
                            outcome: 'applied',
                            applied_at: prev.course.applied_at || new Date().toISOString(),
                            last_event_type: 'marked_applied',
                            last_event_meta: { via: 'control_submit', success: true }
                        },
                        application: prev.application
                            ? { ...prev.application, status: 'applied' }
                            : prev.application,
                        events: [
                            ...(Array.isArray(prev.events) ? prev.events : []),
                            {
                                event_type: 'marked_applied',
                                meta: { via: 'control_submit', success: true },
                                at: new Date().toISOString()
                            }
                        ]
                    };
                });
                try {
                    const qs = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
                    setQueueState(qs?.result || qs?.data || null);
                } catch (_) { /* ignore */ }
                await loadList({ silent: true });
            } else if (body.clicked) {
                setStatus('Submit clicked — waiting for site confirmation (not SUCCESS yet)');
            } else {
                throw new Error(body.error || res?.error || 'Submit did not click');
            }
            if (selectedId) {
                detailSigRef.current = '';
                await loadDetail(selectedId, { silent: false, bumpLive: true });
            }
            setLiveRefreshKey((k) => k + 1);
            setLastRefreshedAt(Date.now());
            setMonitorFrameFollowLive(true);
            setDockOpen(true);
            setMonitorActive(true);
        } catch (err) {
            setError(err.message || 'Submit failed');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const listFormQuestions = async () => {
        const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_LIST_QUESTIONS', 20000, {});
        const body = res?.result || res?.data || res || {};
        const questions = Array.isArray(body.questions) ? body.questions : [];
        return questions;
    };

    const instructLumiFromControl = async (instruction) => {
        const text = String(instruction || '').trim();
        if (!text) throw new Error('Instruction is empty');
        const appId = Number(
            detail?.course?.application_id
            || detail?.application?.id
            || queueState?.currentId
            || queueState?.captchaApplicationId
            || queueState?.lastApplicationId
            || 0
        ) || undefined;
        setStatus(`Instruction: ${text.slice(0, 60)}`);
        const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_INSTRUCT', 90000, {
            instruction: text,
            applicationId: appId
        });
        const body = res?.result || res?.data || res || {};
        if (!body.ok && res?.ok === false) {
            throw new Error(body.error || res?.error || 'Instruct failed');
        }
        if (body.success) {
            successLatchRef.current = true;
            setStatus('SUCCESS — thank-you');
        } else if (body.submitClicked) {
            setStatus('Instruction applied — submit clicked');
        } else {
            setStatus(body.summary || body.coach || 'Instruction applied');
        }
        try {
            const qs = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_QUEUE_STATE', 4000);
            const st = qs?.result || qs?.data || null;
            setQueueState(st);
            if (Array.isArray(st?.uiMessageLog)) setExtNotifs(st.uiMessageLog);
        } catch (_) { /* ignore */ }
        if (selectedId) {
            detailSigRef.current = '';
            await loadDetail(selectedId, { silent: false, bumpLive: true });
        }
        await loadList({ silent: true });
        setLiveRefreshKey((k) => k + 1);
        return body;
    };

    const applyAnswersFromPanel = async (answers) => {
        const appId = Number(
            detail?.course?.application_id
            || detail?.application?.id
            || queueState?.currentId
            || queueState?.captchaApplicationId
            || queueState?.lastApplicationId
            || 0
        ) || undefined;
        const cleaned = (Array.isArray(answers) ? answers : [])
            .map((a) => ({
                id: String(a?.id || a?.label || '').trim(),
                label: String(a?.label || a?.id || '').trim(),
                answer: String(a?.answer ?? a?.value ?? '').trim(),
                type: a?.type || 'text',
                kind: a?.kind || 'written'
            }))
            .filter((a) => (a.label || a.id) && a.answer);
        if (!cleaned.length) {
            throw new Error('Add at least one question with an answer');
        }
        if (appId) {
            try {
                await userAPI.saveBidCoursePackage({
                    application_id: appId,
                    answers: cleaned,
                    meta: { source: 'control_panel' }
                });
            } catch (_) { /* extension savePackage is the source of truth on apply */ }
        }
        const res = await sendBidderExtensionCommand('JOB_APPLY_BIDDER_APPLY_ANSWERS', 60000, {
            answers: cleaned,
            applicationId: appId
        });
        const body = res?.result || res?.data || res || {};
        const filled = Number(body.filled ?? res?.filled ?? 0);
        setStatus(`Applied ${cleaned.length} answer(s) to form (${filled} fields)`);
        if (selectedId) await loadDetail(selectedId);
        return body;
    };

    const skipCaptchaJob = async () => {
        setBusy(true);
        setError('');
        setStatus('Skipping CAPTCHA job…');
        try {
            await sendBidderExtensionCommand('JOB_APPLY_BIDDER_CAPTCHA_SKIP', 8000);
            setStatus('CAPTCHA job skipped — queue continues');
            await loadList();
            if (selectedId) await loadDetail(selectedId);
        } catch (err) {
            setError(err.message || 'Skip CAPTCHA failed');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const openApplyTabsWithoutExtension = async () => {
        if (!bidReady.length) {
            setError('No ready applications to open.');
            return;
        }
        setBusy(true);
        setError('');
        setStatus('Opening apply tabs (no Lumi autofill)…');
        let opened = 0;
        try {
            for (const item of bidReady) {
                const link = jobLinkById.get(Number(item.job_link_id));
                const rawUrl = item.open_url || item.job_url || primaryJobUrl(link);
                const url = resolveApplyOpenUrl(rawUrl);
                if (!url) continue;
                const company =
                    (item.company_name && !/^unknown$/i.test(item.company_name) ? item.company_name : null)
                    || link?.company_name
                    || item.company_name;
                try {
                    await userAPI.logBidCourseEvent({
                        application_id: item.id,
                        event_type: 'manual_tabs_opened',
                        company_name: company,
                        job_role: item.job_role || link?.position_title,
                        job_url: url,
                        meta: {
                            source: 'job-links-ui-no-extension',
                            profile_id: Number(profileId),
                            job_link_id: item.job_link_id || null,
                            opened_application_url: url !== rawUrl
                        }
                    });
                } catch (_) { /* ignore */ }
                const win = window.open(url, '_blank', 'noopener,noreferrer');
                if (win) opened += 1;
                await new Promise((r) => setTimeout(r, 400));
            }
            await loadList();
            setStatus(
                opened
                    ? `Opened ${opened} apply tab(s). Fill manually, or reload Lumi v${MIN_LUMI_VERSION}+ for Auto Bid.`
                    : 'Browser blocked pop-ups — allow pop-ups for this site, then try again.'
            );
            if (!opened) {
                setError('No tabs opened. Allow pop-ups for 127.0.0.1:5173, then click Open for manual fill again.');
            }
        } catch (err) {
            setError(err?.message || 'Failed to open apply tabs');
            setStatus('');
        } finally {
            setBusy(false);
        }
    };

    const processSelected = async () => {
        if (!jobLinkIds.length) {
            setError('Select one or more Job Links in the table first (checkboxes), then open Lumi.');
            return;
        }
        if (!profileId) {
            setError('Choose a bid profile first.');
            return;
        }
        if (!readyPreview.length) {
            setError(
                'This profile has no ready CV for the selected link(s). Generate CV until Ready, or pick another profile.'
            );
            return;
        }
        if (!bidReady.length) {
            const lines = blockedAtsReady.map((item) => {
                const ats = detectAtsFromUrl(item.open_url || item.job_url);
                const link = jobLinkById.get(Number(item.job_link_id));
                const label = link?.company_name || item.company_name || `Job link #${item.job_link_id || item.id}`;
                return `• ${label} — ${ats.label} (not supported)`;
            });
            setError(
                lines.length
                    ? `None of your ready CVs can be auto-filled:\n${lines.join('\n')}\nFix: use a direct employer apply link (not LinkedIn Easy Apply), or apply manually.`
                    : 'This profile has no ready CV for the selected link(s). Generate CV until Ready, or pick another profile.'
            );
            return;
        }

        const ver = await pingLumi();
        if (!versionAtLeast(ver, MIN_LUMI_VERSION)) {
            setError(
                `Lumi not connected (need v${MIN_LUMI_VERSION}+). Reload Lumi in chrome://extensions, then click Check Lumi (no page refresh needed). ` +
                `Or use “Open for manual fill” (allow pop-ups if the browser blocks them).`
            );
            setStatus('');
            return;
        }

        let token = null;
        let user = null;
        try {
            token = localStorage.getItem('token');
            user = JSON.parse(localStorage.getItem('user') || 'null');
        } catch (_) { /* ignore */ }
        if (!token) {
            setError('Not logged in on this page — log in, then Process again.');
            return;
        }

        // Follow the active queue course in Live monitor (clear prior manual pick).
        selectedIdTouchedRef.current = false;
        setWorkspaceTab('courses');

        // Create bid courses immediately so the left list shows this job even if fill fails.
        try {
            await Promise.all(
                bidReady.map((item) => {
                    const link = jobLinkById.get(Number(item.job_link_id));
                    const company =
                        (item.company_name && !/^unknown$/i.test(item.company_name)
                            ? item.company_name
                            : null)
                        || link?.company_name
                        || item.company_name;
                    return userAPI.logBidCourseEvent({
                        application_id: item.id,
                        event_type: 'queue_enqueued',
                        company_name: company,
                        job_role: item.job_role || link?.position_title,
                        job_url: item.open_url || item.job_url,
                        meta: {
                            source: 'job-links-ui',
                            profile_id: Number(profileId),
                            job_link_id: item.job_link_id || null
                        }
                    });
                })
            );
            await loadList();
        } catch (err) {
            console.warn('[auto-bidder] queue_enqueued log failed', err);
        }

        const applicationIds = bidReady.map((r) => r.id).filter(Boolean);
        if (blockedAtsReady.length) {
            setStatus(
                `Processing ${applicationIds.length} job(s). Skipping ${blockedAtsReady.length} unsupported link(s) (e.g. LinkedIn) — see Bid courses for details.`
            );
        }

        // If a prior queue is still paused/running, stop it first so this selection can Process.
        const qs = String(queueState?.status || '');
        const queueBlocked = !!(
            queueState?.running
            || /^(?:running|awaiting_captcha|awaiting_email_otp|awaiting_next)$/i.test(qs)
        );
        if (queueBlocked) {
            setError('');
            setStatus('Stopping current queue, then starting selected bids…');
            try {
                await sendBidderExtensionCommand('JOB_APPLY_BIDDER_STOP', 8000);
            } catch (err) {
                console.warn('[auto-bidder] stop before process', err);
            }
            await new Promise((r) => setTimeout(r, 500));
        }

        // Dialog closes + monitor opens only after Lumi confirms the queue started (see runExt).
        return runExt('JOB_APPLY_BIDDER_PROCESS_QUEUE', 'Starting selected bids', {
            jobLinkIds,
            applicationIds,
            token,
            user,
            selectedProfileId: Number(profileId),
            ...processQueuePrefsPayload(lumiPrefs)
        });
    };

    const shots = useMemo(() => {
        // Never show another course's frames while selectedId has moved on.
        if (!detail?.course?.id || String(detail.course.id) !== String(selectedId)) {
            return [];
        }
        const list = (detail.screenshots?.length ? detail.screenshots : detail.disk_screenshots || []);
        return list.map((s) => ({
            ...s,
            filename: s.filename || (s.url ? decodeURIComponent(s.url.split('/').pop()) : `${s.stage}.png`)
        }));
    }, [detail, selectedId]);

    // Chronological unique frames — success / thank-you proof last so follow-live defaults there.
    const monitorFrames = useMemo(
        () => orderMonitorScreenshotFrames(shots),
        [shots]
    );

    const reviewShots = useMemo(() => sortScreenshotsForReview(shots), [shots]);

    // Sync index to latest while following live; when a success proof exists and this
    // course is no longer the active bid, pin to the site success message by default.
    useEffect(() => {
        if (!monitorFrames.length) {
            setMonitorFrameIndex(0);
            return;
        }
        const proofIdx = preferredProofFrameIndex(monitorFrames);
        const hasProof = isProofScreenshotStage(monitorFrames[proofIdx]?.stage);
        const appId = detail?.course?.application_id || detail?.application?.id;
        const thisCourseActive = !!(
            queueState?.running
            && appId
            && (
                String(queueState?.currentId) === String(appId)
                || String(queueState?.captchaApplicationId) === String(appId)
            )
        );

        // Prefer site success / thank-you whenever present (incl. manual submit + Update state).
        if (hasProof) {
            setMonitorFrameFollowLive(proofIdx >= monitorFrames.length - 1);
            setMonitorFrameIndex(proofIdx);
            return;
        }
        if (monitorFrameFollowLive) {
            // Prefer the updating `live` frame while this course is the active bid.
            if (thisCourseActive || awaitingCaptcha) {
                const liveIdx = monitorFrames.findIndex((s) => /^live$/i.test(String(s?.stage || '')));
                if (liveIdx >= 0) {
                    setMonitorFrameIndex(liveIdx);
                    return;
                }
            }
            setMonitorFrameIndex(monitorFrames.length - 1);
            return;
        }
        setMonitorFrameIndex((i) => Math.min(i, monitorFrames.length - 1));
    }, [
        monitorFrames,
        monitorFrameFollowLive,
        queueState?.running,
        queueState?.currentId,
        queueState?.captchaApplicationId,
        detail?.course?.application_id,
        detail?.application?.id,
        awaitingCaptcha
    ]);

    // Reset to follow-live when switching courses (proof pin runs after frames load).
    useEffect(() => {
        setMonitorFrameFollowLive(true);
        setMonitorFrameIndex(0);
    }, [selectedId]);

    const activeMonitorShot = monitorFrames.length
        ? monitorFrames[Math.min(monitorFrameIndex, monitorFrames.length - 1)]
        : null;

    // Prefer site success / thank-you frame for the in-dialog Live panel when present.
    const latestShot = useMemo(() => {
        if (!monitorFrames.length) return null;
        const idx = preferredProofFrameIndex(monitorFrames);
        return monitorFrames[idx] || monitorFrames[monitorFrames.length - 1];
    }, [monitorFrames]);
    const courseIdForShots = (
        detail?.course?.id && String(detail.course.id) === String(selectedId)
    ) ? detail.course.id : null;
    const shotBustKey = [
        courseIdForShots || '',
        activeMonitorShot?.filename || '',
        activeMonitorShot?.updated_ms || '',
        activeMonitorShot?.created_at || '',
        liveRefreshKey
    ].join('|');
    const dockShot = useScreenshotSrc(
        courseIdForShots,
        activeMonitorShot?.filename,
        isAdmin,
        // Always include course + mtime so switching jobs / overwritten live.png refreshes.
        monitorFrameFollowLive ? shotBustKey : `${courseIdForShots}|${activeMonitorShot?.filename}|${activeMonitorShot?.created_at || ''}`
    );

    const openLightbox = (shot) => {
        if (!shot) return;
        setLightboxShot({ filename: shot.filename, stage: shot.stage });
    };

    const clearBidHistory = async () => {
        if (!courses.length) {
            setStatus('No Lumi history to clear.');
            return;
        }
        if (!window.confirm(`Clear all ${courses.length} Lumi course(s)? This cannot be undone.`)) {
            return;
        }
        setBusy(true);
        setError('');
        try {
            const { data } = await coursesApi.clearBidCourses(isAdmin ? undefined : {});
            const n = data?.summary?.courses ?? courses.length;
            setCourses([]);
            setSelectedId(null);
            setDetail(null);
            setOutcomeFilter('all');
            setStatus(`Cleared ${n} bid course(s).`);
            try {
                await sendBidderExtensionCommand('JOB_APPLY_BIDDER_STOP', 4000);
            } catch (_) { /* ignore */ }
        } catch (err) {
            setError(err?.response?.data?.error || err?.message || 'Failed to clear history');
        } finally {
            setBusy(false);
        }
    };

    const lastEvent = detail
        ? (() => {
            const fromEvents = lastStatusEvent(detail.events || []);
            if (fromEvents.event_type) return { event_type: fromEvents.event_type, meta: fromEvents.meta };
            const fromCourse = lastStatusEvent(detail.course);
            return { event_type: fromCourse.event_type, meta: fromCourse.meta };
        })()
        : null;
    const monitorStatusCommentRaw = liveStatusComment({
        eventType: queueState?.lastStatusEvent
            || lastEvent?.event_type
            || detail?.course?.last_event_type
            || '',
        meta: queueState?.lastStatusMeta
            || lastEvent?.meta
            || detail?.course?.last_event_meta
            || null,
        queueStatus: queueState?.status || '',
        captchaKind
    });
    const monitorStatusComment = shortenNotifyText(monitorStatusCommentRaw) || monitorStatusCommentRaw;
    const progressFromEvent = (() => {
        const t = String(lastEvent?.event_type || '');
        const m = lastEvent?.meta || null;
        if (
            detail?.course?.outcome === 'applied'
            || detail?.course?.applied_at
            || /marked_applied|submitted_ok|mark_applied|submit_success_detected/i.test(t)
            || isSuccessEvent(queueState?.lastStatusEvent)
        ) {
            return 'SUCCESS — Applied on site';
        }
        if (/awaiting_manual_submit|after_fill|fill_done|ready_to_submit|package_saved|reautofill_done/i.test(t)) {
            return 'Filled — waiting for thank-you';
        }
        if (/tab_closed/i.test(t) || (t === 'item_aborted' && /Tab closed/i.test(String(m?.error || '')))) {
            return 'TAB CLOSED — Open tab, then Re-autofill';
        }
        if (/bid_budget_exceeded/i.test(t) || /bid_time_budget|budget_exceeded/i.test(String(m?.error || ''))) {
            return 'TIME LIMIT — Bid stopped (queue continues)';
        }
        if (/reautofill_failed/i.test(t)) {
            return `RE-FILL FAIL — ${m?.error || 'Open tab and try again'}`;
        }
        if (/item_aborted/i.test(t)) {
            return m?.error ? `SKIPPED — ${m.error}` : 'SKIPPED — Bid aborted';
        }
        if (/answers_generating/i.test(t)) return 'Generating answers… (form scrolled into view)';
        if (/ai_skipped_budget/i.test(t)) return 'AI skipped (time budget) — filling with profile…';
        if (/form_revealed|form_detected/i.test(t)) return 'Application form ready — starting fill';
        if (/bidder_answers_ready/i.test(t)) return 'Answers ready — still filling (not done)';
        if (/fill_retry/i.test(t) && m?.willRetry === true) return 'Fill disconnected — retrying…';
        if (/autofill|dial_country|mid_fill|fill_retry/i.test(t)) return 'Filling application form…';
        if (/fill_failed|open_failed|blocked_ats/i.test(t)) return `FAILED — ${m?.error || t}`;
        if (/needs_captcha|captcha_abandoned|login_wall/i.test(t)) return 'CAPTCHA / login — not finished';
        if (/queue_started|opened/i.test(t)) return 'Opened apply page — revealing form…';
        return '';
    })();

    const bidProgress = bidStageProgress({
        events: detail?.events,
        lastEventType: lastEvent?.event_type || detail?.course?.last_event_type,
        lastEventMeta: lastEvent?.meta || detail?.course?.last_event_meta,
        queueState,
        courseOutcome: detail?.course?.outcome
            || (detail?.application?.status === 'applied' ? 'applied' : '')
            || (successLatchRef.current ? 'applied' : ''),
        appliedAt: detail?.course?.applied_at || null
    });

    const dockTitle = detail
        ? `${displayCompanyName(detail.course, detail.application, jobLinkById) || 'Job'} — ${detail.application?.job_role || detail.course?.job_role || ''}`
        : status || 'Auto Bidder';
    const detailRun = detail
        ? courseRunStatus({
            ...detail.course,
            last_event_type: lastEvent?.event_type || detail.course?.last_event_type,
            last_event_meta: lastEvent?.meta || detail.course?.last_event_meta,
            // Control Update state may mark applied before list/detail fully syncs.
            outcome: detail.course?.outcome
                || (isSuccessEvent(queueState?.lastStatusEvent) ? 'applied' : detail.course?.outcome)
                || (detail.application?.status === 'applied' ? 'applied' : detail.course?.outcome)
                || (successLatchRef.current ? 'applied' : detail.course?.outcome),
            applied_at: detail.course?.applied_at
                || (isSuccessEvent(queueState?.lastStatusEvent) ? new Date().toISOString() : detail.course?.applied_at)
                || (successLatchRef.current ? new Date().toISOString() : detail.course?.applied_at),
            application_status: detail.application?.status || detail.course?.application_status || ''
        })
        : null;
    const dockStatusRaw =
        (detailRun?.kind === 'success'
            ? (detailRun.label || 'SUCCESS — Applied on site')
            : null)
        || (bidProgress.tone === 'emerald' ? bidProgress.label : null)
        || (detailRun?.kind === 'success' ? detailRun.label : null)
        || bidProgress.label
        || progressFromEvent
        || status
        || (awaitingCaptcha
            ? 'CAPTCHA / login — solve in the background apply tab, then Resume in Lumi'
            : monitorActive
                ? 'Bidding in background — stay on Job Links'
                : '');
    const dockStatus = shortenOutcomeLabel(dockStatusRaw) || dockStatusRaw;
    const dockProgressPct = detailRun?.kind === 'success' || bidProgress.tone === 'emerald'
        ? 100
        : bidProgress.pct;
    const dockProgressLabelRaw = detailRun?.kind === 'success' || bidProgress.tone === 'emerald'
        ? (bidProgress.tone === 'emerald' ? bidProgress.label : (detailRun?.label || 'SUCCESS — Applied on site'))
        : (bidProgress.label || dockStatus);
    const dockProgressLabel = shortenOutcomeLabel(dockProgressLabelRaw) || dockProgressLabelRaw;
    const dockProgressTone = detailRun?.kind === 'success' ? 'emerald' : bidProgress.tone;
    const dockUpdatedLabel = ''; // computed inside BidMonitorDock from lastRefreshedAt

    const selectedProfile = profileOptions.find((p) => String(p.id) === String(profileId));
    // Only surface Failed when the *current* status event is a failure — never bury Success under an old fail.
    const detailIssue =
        detail && detailRun?.kind === 'failed'
            ? failureSummary(lastEvent?.event_type, lastEvent?.meta, {
                jobUrl: detail.application?.job_url
            })
            : '';

    const queueBlocked = !!(
        queueState?.running
        || /^(?:running|awaiting_captcha|awaiting_email_otp|awaiting_next)$/i.test(String(queueState?.status || ''))
    );
    const canDockProcess = !busy && !!profileId && jobLinkIds.length > 0;
    const dockProcessLabel = queueBlocked ? 'Stop & Process' : 'Process';
    const dockCvFilename = detail?.application?.resume_filename || '';
    const dockCvDownloadUrl = detail?.application?.download_url || '';
    const dockCvProfileId = detail?.course?.profile_id
        || detail?.application?.profile_id
        || profileId
        || '';
    const dockCvApplicationId = detail?.application?.id
        || detail?.course?.application_id
        || '';
    const dockCvEditHref = dockCvProfileId
        ? `/user/generate/${dockCvProfileId}${dockCvApplicationId ? `?applicationId=${dockCvApplicationId}` : ''}`
        : '';

    return (
        <>
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="flex h-[min(96vh,60rem)] max-h-[96vh] w-[min(98vw,80rem)] max-w-7xl flex-col gap-0 overflow-hidden border-white/[0.08] bg-[hsl(240_6%_9%)] p-0 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7),0_0_0_1px_hsla(187,85%,53%,0.1)] sm:rounded-2xl">
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-5 sm:p-6">
                <DialogHeader className="shrink-0 space-y-0">
                    <DialogTitle className="font-display flex items-center gap-3 text-xl font-semibold tracking-tight text-white">
                        <span
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold text-[hsl(240_6%_10%)]"
                            style={{
                                background: 'linear-gradient(145deg, hsl(199 95% 55%), hsl(199 89% 42%))',
                                boxShadow: '0 0 24px hsla(187,85%,53%,0.35)'
                            }}
                            aria-hidden
                        >
                            L
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="leading-none">Lumi</span>
                            <span className="text-[11px] font-medium tracking-normal text-white/40">Auto Bidder</span>
                        </span>
                    </DialogTitle>
                    <div
                        className="mt-3 h-px w-16"
                        style={{ background: 'linear-gradient(90deg, hsl(199 95% 55%), transparent)' }}
                        aria-hidden
                    />
                    <DialogDescription className="mt-2 text-xs text-white/50">
                        Pick a profile → Process. <span className="text-emerald-300">SUCCESS</span> = site confirmed ·{' '}
                        <span className="text-cyan-300">FILLED</span> = form filled (not confirmed yet) ·{' '}
                        <span className="text-rose-300">FAILED</span> = did not complete.
                    </DialogDescription>
                </DialogHeader>

                <DialogBody className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                {awaitingCaptcha && (
                    <div className="shrink-0 rounded-lg border border-amber-400/60 bg-amber-500/15 px-3 py-2.5 text-sm text-amber-50">
                        <div className="flex flex-wrap items-center gap-2">
                            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-200" />
                            <p className="min-w-0 flex-1 text-sm font-semibold">
                                {captchaKind === 'login' ? 'Login wall — sign in on apply tab' : 'CAPTCHA — solve, then Resume'}
                            </p>
                            <Button size="sm" className="h-8" disabled={busy} onClick={() => openCaptchaTab()}>
                                Open tab
                            </Button>
                            <Button
                                size="sm"
                                className="h-8"
                                disabled={busy}
                                onClick={() => resumeCaptcha({ force: true, focusTab: true })}
                            >
                                Resume
                            </Button>
                            <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => skipCaptchaJob()}>
                                Skip
                            </Button>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive whitespace-pre-wrap">
                        {error}
                    </div>
                )}

                {(queueStatusLabel || (courseStats.success + courseStats.failed + courseStats.filled + courseStats.attention + courseStats.running) > 0 || bidProgress.pct > 0) && (
                    <div
                        className={`shrink-0 rounded-xl border px-3.5 py-2.5 text-sm ${
                            /finished|done/i.test(queueStatusLabel) || bidProgress.tone === 'emerald'
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                                : /CAPTCHA|Paused|Waiting/i.test(queueStatusLabel) || bidProgress.tone === 'amber'
                                    ? 'border-amber-400/50 bg-amber-500/12 text-amber-50'
                                    : /progress|Bidding/i.test(queueStatusLabel) || bidProgress.tone === 'sky'
                                        ? 'border-primary/35 bg-primary/10 text-foreground'
                                        : bidProgress.tone === 'rose'
                                            ? 'border-destructive/50 bg-destructive/10 text-destructive'
                                            : 'border-border/80 bg-card/80 text-foreground'
                        }`}
                    >
                        {queueStatusLabel ? (
                            <p className="font-medium">{queueStatusLabel}</p>
                        ) : null}
                        {(bidProgress.pct > 0 || bidProgress.label) ? (
                            <BidProgressBar
                                className="mt-2"
                                pct={bidProgress.pct}
                                label={shortenOutcomeLabel(bidProgress.label) || bidProgress.label || queueStatusLabel}
                                tone={bidProgress.tone}
                                stepIndex={bidProgress.stepIndex}
                            />
                        ) : null}
                        {(queueState?.queueStartedAt || detail?.course?.started_at) ? (
                            <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
                                {detail?.course?.started_at || queueState?.jobStartedAt ? (
                                    <>
                                        Job{' '}
                                        <span className="font-mono text-cyan-300">
                                            {formatTotalElapsed(
                                                detail?.course?.started_at || queueState?.jobStartedAt,
                                                detail?.course?.applied_at || detail?.course?.filled_at || null
                                            )}
                                        </span>
                                    </>
                                ) : null}
                                {(detail?.course?.started_at || queueState?.jobStartedAt) && queueState?.queueStartedAt
                                    ? ' · '
                                    : null}
                                {queueState?.queueStartedAt ? (
                                    <>
                                        Queue{' '}
                                        <span className="font-mono text-cyan-300">
                                            {formatTotalElapsed(
                                                queueState.queueStartedAt,
                                                queueState.queueEndedAt
                                                    || (/^(?:done|stopped|empty)$/i.test(String(queueState?.status || ''))
                                                        ? queueState.updatedAt
                                                        : null)
                                            )}
                                        </span>
                                    </>
                                ) : null}
                                {Number(queueState?.total) > 0 && Number(queueState?.index) > 0
                                    ? ` · Job ${queueState.index}/${queueState.total}`
                                    : null}
                            </p>
                        ) : null}
                        <div className="mt-1.5 flex flex-wrap gap-2 text-[11px]">
                            <Badge className="border border-emerald-500/50 bg-emerald-600/90 hover:bg-emerald-600 text-[10px] font-semibold">
                                {courseStats.success} SUCCESS
                            </Badge>
                            <Badge className="border border-red-500/50 bg-red-600/90 hover:bg-red-600 text-[10px] font-semibold text-white">
                                {courseStats.failed} FAILED
                            </Badge>
                            {courseStats.filled > 0 && (
                                <Badge className="border border-cyan-500/50 bg-cyan-600/80 hover:bg-cyan-600 text-[10px] font-semibold">
                                    {courseStats.filled} FILLED
                                </Badge>
                            )}
                            {courseStats.attention > 0 && (
                                <Badge className="border border-amber-500/50 bg-amber-600 hover:bg-amber-600 text-[10px] font-semibold">
                                    {courseStats.attention} CAPTCHA
                                </Badge>
                            )}
                            {courseStats.running > 0 && (
                                <Badge variant="secondary" className="text-[10px] font-semibold">
                                    {courseStats.running} RUNNING
                                </Badge>
                            )}
                        </div>
                    </div>
                )}

                    <ModalTabs
                        value={workspaceTab}
                        onValueChange={setWorkspaceTab}
                    >
                        <ModalTabsList>
                            <ModalTabsTrigger value="setup">Setup</ModalTabsTrigger>
                            <ModalTabsTrigger value="courses">
                                Courses
                                {courses.length ? (
                                    <span className="ml-1.5 tabular-nums text-[10px] opacity-70">
                                        ({courses.length})
                                    </span>
                                ) : null}
                            </ModalTabsTrigger>
                            <ModalTabsTrigger value="form" disabled={!selectedId}>
                                Form
                            </ModalTabsTrigger>
                            <ModalTabsTrigger value="log" disabled={!selectedId}>
                                Log
                            </ModalTabsTrigger>
                        </ModalTabsList>

                        <ModalTabsContent value="setup">
                            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
                                {/* Compact guide */}
                                <div className="rounded-xl border border-border/70 bg-card/50">
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm font-medium"
                                        onClick={() => setShowGuide((v) => !v)}
                                    >
                                        <HelpCircle className="h-4 w-4 text-primary" />
                                        How to use
                                        {showGuide
                                            ? <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
                                            : <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />}
                                    </button>
                                    {showGuide ? (
                                        <div className="space-y-2.5 border-t border-border/50 px-3.5 py-2.5 text-xs text-muted-foreground">
                                            <div className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2">
                                                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-foreground">
                                                    Result meanings
                                                </div>
                                                <ul className="space-y-1">
                                                    <li>
                                                        <span className="font-bold text-emerald-300">SUCCESS</span>
                                                        {' '}— site thank-you / applied confirmed
                                                    </li>
                                                    <li>
                                                        <span className="font-bold text-sky-300">FILLED</span>
                                                        {' '}— form filled; <em className="not-italic text-foreground">not</em> SUCCESS until the site confirms
                                                    </li>
                                                    <li>
                                                        <span className="font-bold text-red-300">FAILED</span>
                                                        {' '}— bid did not complete
                                                    </li>
                                                    <li>
                                                        <span className="font-bold text-amber-200">CAPTCHA</span>
                                                        {' '}— needs you (Resume) or was skipped in AFK
                                                    </li>
                                                </ul>
                                            </div>
                                            <ol className="space-y-1.5">
                                                <li><span className="font-semibold text-foreground">1.</span> Choose a <strong className="text-foreground">bid profile</strong> with a ready CV.</li>
                                                <li><span className="font-semibold text-foreground">2.</span> Check each link badge before Process.</li>
                                                <li><span className="font-semibold text-foreground">3.</span> Click <strong className="text-foreground">Process</strong>. Watch the Live monitor (bottom-right) for SUCCESS / FILLED / FAILED.</li>
                                                <li><span className="font-semibold text-foreground">4.</span> If CAPTCHA → <strong className="text-foreground">Resume</strong>. If FILLED but incomplete → <strong className="text-foreground">Re-autofill</strong>. Or <strong className="text-foreground">Stop & Process</strong> to restart.</li>
                                                <li><span className="font-semibold text-foreground">5.</span> Use <strong className="text-foreground">Courses</strong> filters to list SUCCESS, FILLED, or FAILED.</li>
                                            </ol>
                                        </div>
                                    ) : null}
                                </div>

                                {/* Lumi status — one line */}
                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                    {lumiOk === true ? (
                                        <span className="text-emerald-300/90">Lumi v{lumiVersion} connected</span>
                                    ) : lumiOk === false ? (
                                        <span className="text-amber-300">Lumi not connected — Reload Lumi, then Check Lumi</span>
                                    ) : (
                                        <span className="text-muted-foreground">Checking Lumi…</span>
                                    )}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 px-2"
                                        disabled={busy}
                                        onClick={async () => {
                                            setError('');
                                            setStatus('Reconnecting Lumi…');
                                            try { await reinjectLumiBridge(8000); } catch (_) { /* ping still tries */ }
                                            const ver = await pingLumi();
                                            if (versionAtLeast(ver, MIN_LUMI_VERSION)) {
                                                setStatus(`Lumi v${ver} connected`);
                                                setError('');
                                            } else {
                                                setStatus('');
                                                setError(
                                                    `Lumi not connected (need v${MIN_LUMI_VERSION}+). Open chrome://extensions → Reload Lumi, then click Check Lumi (no page refresh needed).`
                                                );
                                            }
                                        }}
                                    >
                                        Check Lumi
                                    </Button>
                                </div>

                                {lumiOk === false && (
                                    <div className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-50">
                                        Open chrome://extensions → <strong>Reload Lumi</strong> → click <strong>Check Lumi</strong> (no hard refresh).
                                        Or use <strong>Open for manual fill</strong>.
                                    </div>
                                )}

                                {/* Step 1 — Profile */}
                                <div className="space-y-2 rounded-xl border border-border/80 bg-card/60 px-3.5 py-3">
                                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                        1 · Bid profile
                                    </div>
                                    <Select value={profileId || undefined} onValueChange={onProfileChange}>
                                        <SelectTrigger id="bidder-profile" className="h-9">
                                            <SelectValue placeholder="Select profile…">
                                                {selectedProfile
                                                    ? `${profileLabel(selectedProfile)}${profileStatusSuffix(
                                                        selectedProfile,
                                                        profileBidOutcome(courses, selectedProfile.id, jobLinkIds)
                                                    )}`
                                                    : null}
                                            </SelectValue>
                                        </SelectTrigger>
                                        <SelectContent className="max-h-72">
                                            {!selectableProfiles.length && (
                                                <SelectItem value="__none" disabled>
                                                    No profiles available
                                                </SelectItem>
                                            )}
                                            {jobLinkIds.length > 0 && matchedProfileOptions.length > 0 && (
                                                <SelectGroup>
                                                    <SelectLabel>Matched to selected links</SelectLabel>
                                                    {matchedProfileOptions.map((p) => (
                                                        <SelectItem key={p.id} value={String(p.id)}>
                                                            {profileLabel(p)}
                                                            {profileStatusSuffix(p, profileBidOutcome(courses, p.id, jobLinkIds))}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            )}
                                            {(showAllProfiles || !matchedProfileOptions.length) && otherProfileOptions.length > 0 && (
                                                <SelectGroup>
                                                    <SelectLabel>
                                                        {matchedProfileOptions.length ? 'Other profiles' : 'All profiles'}
                                                    </SelectLabel>
                                                    {otherProfileOptions.map((p) => (
                                                        <SelectItem key={p.id} value={String(p.id)}>
                                                            {profileLabel(p)}
                                                            {profileStatusSuffix(p, profileBidOutcome(courses, p.id, jobLinkIds))}
                                                        </SelectItem>
                                                    ))}
                                                </SelectGroup>
                                            )}
                                        </SelectContent>
                                    </Select>
                                    <div className="flex flex-wrap items-center gap-2">
                                        {selectedProfile && (
                                            <Badge variant={readyPreview.length ? 'default' : 'outline'} className="text-[10px]">
                                                {readyPreview.length
                                                    ? `${readyPreview.length} CV ready`
                                                    : 'No ready CV'}
                                            </Badge>
                                        )}
                                        {selectedProfile && (() => {
                                            const bid = profileBidOutcome(courses, selectedProfile.id, jobLinkIds);
                                            if (!bid) return null;
                                            return (
                                                <span
                                                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${runStatusBadgeClass(bid.kind)}`}
                                                >
                                                    {bid.short}
                                                </span>
                                            );
                                        })()}
                                        {jobLinkIds.length > 0 && otherProfileOptions.length > 0 && (
                                            <button
                                                type="button"
                                                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                                                onClick={() => setShowAllProfiles((v) => !v)}
                                            >
                                                {showAllProfiles ? 'Matched only' : `All profiles (+${otherProfileOptions.length})`}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {/* Step 2 — Links */}
                                <div className="space-y-2 rounded-xl border border-border/80 bg-card/50 px-3.5 py-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                            2 · Selected links
                                        </div>
                                        <Badge variant="secondary" className="text-[10px]">
                                            {jobLinkIds.length} selected
                                        </Badge>
                                        {readyPreview.length > 0 && (
                                            <Badge className="text-[10px]">{readyPreview.length} ready</Badge>
                                        )}
                                    </div>
                                    {!jobLinkIds.length && (
                                        <p className="text-xs text-muted-foreground">
                                            Check Job Links rows (or Zap on a row), then reopen Lumi.
                                        </p>
                                    )}
                                    {!!jobLinkIds.length && (
                                        <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                                            {selectedLinks.map((l) => {
                                                const ready = readyPreview.some((r) => Number(r.job_link_id) === Number(l.id));
                                                const ats = detectAtsFromUrl(primaryJobUrl(l));
                                                const outcome = linkOutcomeForProfile(courses, l.id, profileId, ready);
                                                return (
                                                    <li
                                                        key={l.id}
                                                        className={`flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2.5 py-2 text-xs ${runStatusRowClass(outcome.kind)}`}
                                                    >
                                                        <span className="min-w-0 flex-1 font-medium text-foreground">
                                                            #{l.id} {l.company_name || '—'}
                                                            {l.position_title ? (
                                                                <span className="font-normal text-muted-foreground">
                                                                    {' '}· {l.position_title}
                                                                </span>
                                                            ) : null}
                                                        </span>
                                                        <Badge variant="outline" className="text-[10px]">{ats.label}</Badge>
                                                        <span
                                                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${runStatusBadgeClass(outcome.kind)}`}
                                                            title={outcome.label}
                                                        >
                                                            {outcome.short}
                                                        </span>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                    {!!unsupportedSelected.length && (
                                        <p className="text-[11px] text-amber-300">
                                            {unsupportedSelected.length} unsupported (e.g. LinkedIn) — skipped on Process.
                                        </p>
                                    )}
                                </div>

                                {/* Step 3 — Options (collapsed) */}
                                <div className="rounded-xl border border-border/70 bg-card/40">
                                    <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm"
                                        onClick={() => setShowAdvanced((v) => !v)}
                                    >
                                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                            3 · Options
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {unattended ? 'Hands-free AFK' : 'Attended'}
                                            {lumiPrefs.autoNext ? ' · auto-next' : ''}
                                            {captchaHelper ? ' · CAPTCHA helper' : ''}
                                            {uploadCoverLetter ? ' · cover letter' : ''}
                                        </span>
                                        {showAdvanced
                                            ? <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
                                            : <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />}
                                    </button>
                                    {showAdvanced ? (
                                        <div className="space-y-3 border-t border-border/50 px-3.5 py-3 text-sm">
                                            <LumiBidderSettings
                                                compact
                                                onChange={setLumiPrefs}
                                                showProfileAutofillHint={false}
                                            />
                                            {captchaHelper ? (
                                                <p className="text-[11px] text-muted-foreground">
                                                    CAPTCHA: free helpers — install{' '}
                                                    <a className="underline" href="https://chromewebstore.google.com/detail/nopecha-captcha-solver/dknlfmjaanfblgfdfebhijalfmhmjjjo" target="_blank" rel="noopener noreferrer">NopeCHA</a>
                                                    {' + '}
                                                    <a className="underline" href="https://chromewebstore.google.com/detail/buster-captcha-solver-for/mpbjkejclgfgadiemmefgebjfooflfhl" target="_blank" rel="noopener noreferrer">Buster</a>
                                                    {' '}in the same Chrome profile as Lumi (no CapSolver/2Captcha API).
                                                </p>
                                            ) : null}

                                            <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                                        Studying / Learning
                                                    </div>
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="ghost"
                                                        className="h-6 px-2 text-[10px]"
                                                        disabled={memoryBusy}
                                                        onClick={() => refreshStudyingPanel()}
                                                    >
                                                        {memoryBusy ? '…' : 'Refresh'}
                                                    </Button>
                                                </div>
                                                <p className="text-[11px] text-muted-foreground">
                                                    Policy memory studies fixed answers (disability No, sponsorship No, …). Unique essays stay fresh per job.
                                                </p>
                                                {helperProbe?.probed ? (
                                                    <p className={`text-[11px] ${helperProbe.helper_missing ? 'text-amber-300' : 'text-emerald-300/90'}`}>
                                                        Helpers:{' '}
                                                        {helperProbe.nopecha ? 'NopeCHA ✓' : 'NopeCHA ✗'}
                                                        {' · '}
                                                        {helperProbe.buster ? 'Buster ✓' : 'Buster ✗'}
                                                        {helperProbe.helper_missing ? ' — install both in this Chrome profile' : ''}
                                                    </p>
                                                ) : (
                                                    <p className="text-[11px] text-muted-foreground">
                                                        Helper status unknown — Check Lumi, then Refresh.
                                                    </p>
                                                )}
                                                <div className="max-h-36 space-y-1 overflow-y-auto">
                                                    {questionMemoryRows.length === 0 ? (
                                                        <p className="text-[11px] text-muted-foreground">
                                                            No studied questions yet (seeds load on first Process / Refresh).
                                                        </p>
                                                    ) : questionMemoryRows.slice(0, 12).map((row) => (
                                                        <div
                                                            key={row.id}
                                                            className="flex items-start justify-between gap-2 rounded border border-border/50 px-2 py-1 text-[11px]"
                                                        >
                                                            <div className="min-w-0">
                                                                <div className="truncate font-medium text-foreground/90">
                                                                    {row.kind}
                                                                    {row.source ? ` · ${row.source}` : ''}
                                                                    {row.disabled ? ' · off' : ''}
                                                                </div>
                                                                <div className="truncate text-muted-foreground">
                                                                    {row.question_text}
                                                                </div>
                                                            </div>
                                                            <Button
                                                                type="button"
                                                                size="sm"
                                                                variant="ghost"
                                                                className="h-6 shrink-0 px-1.5 text-[10px]"
                                                                disabled={memoryBusy}
                                                                onClick={async () => {
                                                                    setMemoryBusy(true);
                                                                    try {
                                                                        await userAPI.disableQuestionMemory({
                                                                            id: row.id,
                                                                            disabled: !row.disabled
                                                                        });
                                                                        await refreshStudyingPanel();
                                                                    } catch (err) {
                                                                        setError(err?.response?.data?.error || err.message || 'Disable failed');
                                                                    } finally {
                                                                        setMemoryBusy(false);
                                                                    }
                                                                }}
                                                            >
                                                                {row.disabled ? 'Enable' : 'Disable'}
                                                            </Button>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-7 text-[11px]"
                                                        disabled={memoryBusy}
                                                        onClick={async () => {
                                                            if (!window.confirm('Clear your studied Policy rows? Seeds stay.')) return;
                                                            setMemoryBusy(true);
                                                            try {
                                                                await userAPI.clearQuestionMemory();
                                                                await refreshStudyingPanel();
                                                            } catch (err) {
                                                                setError(err?.response?.data?.error || err.message || 'Clear failed');
                                                            } finally {
                                                                setMemoryBusy(false);
                                                            }
                                                        }}
                                                    >
                                                        Clear my memory
                                                    </Button>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-2">
                                                    <input
                                                        className="h-7 min-w-[8rem] flex-1 rounded-md border border-border/60 bg-background/80 px-2 text-[11px]"
                                                        placeholder="host to clear lessons (e.g. boards.greenhouse.io)"
                                                        value={clearHostInput}
                                                        onChange={(e) => setClearHostInput(e.target.value)}
                                                    />
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-7 text-[11px]"
                                                        disabled={memoryBusy || !clearHostInput.trim()}
                                                        onClick={async () => {
                                                            const host = clearHostInput.trim().replace(/^www\./i, '');
                                                            setMemoryBusy(true);
                                                            try {
                                                                await userAPI.clearBidderFillLessons({ host });
                                                                setClearHostInput('');
                                                                pushNotif(`Cleared fill lessons for ${host}`, 'ok');
                                                            } catch (err) {
                                                                setError(err?.response?.data?.error || err.message || 'Clear host failed');
                                                            } finally {
                                                                setMemoryBusy(false);
                                                            }
                                                        }}
                                                    >
                                                        Clear host lessons
                                                    </Button>
                                                </div>
                                            </div>

                                            <div className="space-y-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
                                                <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                                    Microsoft Graph — multiple mailboxes
                                                </div>
                                                <p className="text-[11px] text-muted-foreground">
                                                    Connect every Hotmail/Outlook inbox that may get Greenhouse codes. OTPs are matched across all of them. Same Azure app — just Add mailbox again for each account.
                                                </p>
                                                {!outlookStatus?.config?.clientIdSet ? (
                                                    <p className="text-[11px] text-amber-200/90">
                                                        Set <code className="text-[10px]">OUTLOOK_CLIENT_ID</code> in{' '}
                                                        <code className="text-[10px]">server/.env</code>, restart API, then add mailboxes here.
                                                    </p>
                                                ) : null}
                                                {(outlookStatus?.accounts || []).length ? (
                                                    <ul className="space-y-1.5">
                                                        {(outlookStatus.accounts || []).map((a) => (
                                                            <li key={a.id || a.email} className="flex flex-wrap items-center gap-2 text-[11px]">
                                                                <span className="text-foreground">{a.email || a.display_name || `Mailbox #${a.id}`}</span>
                                                                <span className="text-muted-foreground">
                                                                    {a.push_enabled ? '· push ON' : '· push off'}
                                                                </span>
                                                                {!a.push_enabled ? (
                                                                    <Button
                                                                        type="button"
                                                                        size="sm"
                                                                        variant="outline"
                                                                        disabled={outlookBusy}
                                                                        onClick={async () => {
                                                                            setOutlookBusy(true);
                                                                            try {
                                                                                await userAPI.subscribeOutlookPush({ mailbox_id: a.id });
                                                                                await refreshOutlookStatus();
                                                                            } catch (err) {
                                                                                setOutlookMsg(err?.response?.data?.error || err?.message || 'Subscribe failed');
                                                                            } finally {
                                                                                setOutlookBusy(false);
                                                                            }
                                                                        }}
                                                                    >
                                                                        Enable push
                                                                    </Button>
                                                                ) : null}
                                                                <Button
                                                                    type="button"
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    disabled={outlookBusy}
                                                                    onClick={() => removeOutlookMailbox(a.id)}
                                                                >
                                                                    Remove
                                                                </Button>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                ) : (
                                                    <p className="text-[11px] text-muted-foreground">No mailboxes connected yet.</p>
                                                )}
                                                <div className="flex flex-wrap gap-2">
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        disabled={outlookBusy || !outlookStatus?.config?.clientIdSet}
                                                        onClick={connectOutlookGraph}
                                                    >
                                                        {outlookBusy ? 'Waiting for Microsoft…' : 'Add mailbox'}
                                                    </Button>
                                                    {(outlookStatus?.accounts || []).length > 0 ? (
                                                        <Button type="button" size="sm" variant="ghost" disabled={outlookBusy} onClick={disconnectOutlookGraph}>
                                                            Remove all
                                                        </Button>
                                                    ) : null}
                                                </div>
                                                {outlookDevice?.user_code ? (
                                                    <p className="text-[11px] text-foreground">
                                                        Go to{' '}
                                                        <a className="underline" href={outlookDevice.verification_uri || 'https://www.microsoft.com/devicelogin'} target="_blank" rel="noopener noreferrer">
                                                            {outlookDevice.verification_uri || 'microsoft.com/devicelogin'}
                                                        </a>
                                                        {' '}and enter{' '}
                                                        <span className="font-mono font-semibold tracking-wide">{outlookDevice.user_code}</span>
                                                        {' '}(sign in as the mailbox you want to add)
                                                    </p>
                                                ) : null}
                                                {outlookMsg ? (
                                                    <p className="text-[11px] text-muted-foreground">{outlookMsg}</p>
                                                ) : null}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>

                                {/* Actions */}
                                {(() => {
                                    return (
                                        <div className="space-y-2 rounded-xl border border-border/70 bg-muted/20 px-3.5 py-3">
                                            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                                4 · Run
                                            </div>
                                            {queueBlocked ? (
                                                <p className="text-xs text-amber-200/90">
                                                    A queue is still active. Resume CAPTCHA, or Stop & Process to start this selection.
                                                </p>
                                            ) : null}
                                            <div className="flex flex-wrap items-center gap-2">
                                                {queueBlocked && awaitingCaptcha ? (
                                                    <Button
                                                        size="sm"
                                                        disabled={busy || dockBusy}
                                                        onClick={() => resumeCaptcha({ force: true, focusTab: true })}
                                                    >
                                                        Resume CAPTCHA
                                                    </Button>
                                                ) : null}
                                                {queueBlocked ? (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={busy || dockBusy || lumiOk !== true}
                                                        onClick={() => reAutofillCurrentJob()}
                                                        title="Re-run autofill on the current apply tab"
                                                    >
                                                        <RefreshCw className="h-4 w-4" />
                                                        Re-autofill
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    size="sm"
                                                    variant="gradient"
                                                    disabled={!canDockProcess}
                                                    onClick={processSelected}
                                                >
                                                    <Play className="h-4 w-4" />
                                                    {dockProcessLabel}
                                                </Button>
                                                {queueBlocked ? (
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        disabled={busy || lumiOk !== true}
                                                        onClick={() => runExt('JOB_APPLY_BIDDER_STOP', 'Stop')}
                                                    >
                                                        <Square className="h-4 w-4" />
                                                        Stop
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    disabled={busy || !profileId || !bidReady.length}
                                                    onClick={openApplyTabsWithoutExtension}
                                                >
                                                    <ExternalLink className="h-4 w-4" />
                                                    Manual fill
                                                </Button>
                                                <Button size="sm" variant="ghost" onClick={() => onOpenChange?.(false)}>
                                                    <X className="h-4 w-4" />
                                                    Close
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    disabled={loading}
                                                    onClick={() => {
                                                        loadProfiles();
                                                        loadList();
                                                        loadReadyPreview();
                                                    }}
                                                >
                                                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                                                </Button>
                                                {!queueBlocked ? (
                                                    <>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            disabled={busy || lumiOk !== true}
                                                            onClick={() => runExt('JOB_APPLY_BIDDER_NEXT', 'Next')}
                                                        >
                                                            <SkipForward className="h-4 w-4" />
                                                            Next
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            disabled={busy || lumiOk !== true}
                                                            onClick={() => runExt('JOB_APPLY_BIDDER_STOP', 'Stop')}
                                                        >
                                                            <Square className="h-4 w-4" />
                                                            Stop
                                                        </Button>
                                                    </>
                                                ) : null}
                                            </div>
                                            {(detailRun?.kind === 'filled'
                                                || detailRun?.kind === 'attention'
                                                || detailRun?.kind === 'failed'
                                                || detailRun?.kind === 'incomplete'
                                                || detailRun?.kind === 'running'
                                                || queueBlocked
                                                || queueState?.running
                                                || queueState?.coachStatus) ? (
                                                <div className="mt-2 rounded-lg border border-sky-500/35 bg-sky-500/10 px-2.5 py-2">
                                                    <p className="text-[10px] font-semibold uppercase tracking-wide text-sky-200">
                                                        Teach Lumi (Instruct)
                                                    </p>
                                                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                                                        {queueState?.coachStatus
                                                            || 'Fix mistakes here — not the blue Autofill bubble on the page.'}
                                                    </p>
                                                    <textarea
                                                        className="mt-1.5 min-h-[48px] w-full rounded-md border border-border/60 bg-background/80 px-2 py-1.5 text-[11px]"
                                                        placeholder="Type city, state and zip into Location"
                                                        value={controlInstruct}
                                                        disabled={controlInstructBusy || busy}
                                                        onChange={(e) => setControlInstruct(e.target.value)}
                                                    />
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        className="mt-1.5 h-7 text-[11px]"
                                                        disabled={controlInstructBusy || busy || !controlInstruct.trim()}
                                                        onClick={async () => {
                                                            setControlInstructBusy(true);
                                                            setError('');
                                                            try {
                                                                await instructLumiFromControl(controlInstruct.trim());
                                                                setControlInstruct('');
                                                            } catch (err) {
                                                                setError(err.message || 'Instruct failed');
                                                            } finally {
                                                                setControlInstructBusy(false);
                                                            }
                                                        }}
                                                    >
                                                        {controlInstructBusy ? 'Applying…' : 'Apply instruction'}
                                                    </Button>
                                                </div>
                                            ) : queueState?.coachStatus ? (
                                                <p className="mt-1.5 text-[10px] text-sky-300/90">{queueState.coachStatus}</p>
                                            ) : null}
                                            {notifFeed.length ? (
                                                <div className="mt-2 rounded-lg border border-border/60 bg-muted/15">
                                                    <div className="flex items-center justify-between gap-2 border-b border-border/40 px-2.5 py-1">
                                                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                                            Notifications
                                                        </p>
                                                        <button
                                                            type="button"
                                                            className="text-[10px] text-muted-foreground hover:text-foreground"
                                                            onClick={() => {
                                                                setLocalNotifs([]);
                                                                setExtNotifs([]);
                                                            }}
                                                        >
                                                            Clear
                                                        </button>
                                                    </div>
                                                    <ul className="max-h-36 space-y-0.5 overflow-y-auto overscroll-contain px-2.5 py-1.5">
                                                        {notifFeed.map((n) => {
                                                            const kindClass =
                                                                n.kind === 'error'
                                                                    ? 'text-destructive'
                                                                    : n.kind === 'warn'
                                                                        ? 'text-amber-300'
                                                                        : n.kind === 'learn'
                                                                            ? 'text-sky-300'
                                                                            : n.kind === 'ok'
                                                                                ? 'text-emerald-300'
                                                                                : 'text-muted-foreground';
                                                            const time = (() => {
                                                                try {
                                                                    return new Date(n.at).toLocaleTimeString([], {
                                                                        hour: '2-digit',
                                                                        minute: '2-digit',
                                                                        second: '2-digit'
                                                                    });
                                                                } catch {
                                                                    return '';
                                                                }
                                                            })();
                                                            return (
                                                                <li
                                                                    key={n.id}
                                                                    className="flex items-start gap-2 text-[11px] leading-snug"
                                                                >
                                                                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
                                                                        {time}
                                                                    </span>
                                                                    <span className={kindClass}>{n.short}</span>
                                                                </li>
                                                            );
                                                        })}
                                                    </ul>
                                                </div>
                                            ) : null}
                                        </div>
                                    );
                                })()}
                            </div>
                        </ModalTabsContent>

                        <ModalTabsContent value="courses">
                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40 p-2">
                                <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-border/40 pb-2">
                                    {[
                                        { id: 'all', label: 'All', n: courses.length },
                                        { id: 'success', label: 'SUCCESS', n: courseStats.success },
                                        { id: 'failed', label: 'FAILED', n: courseStats.failed },
                                        { id: 'filled', label: 'FILLED', n: courseStats.filled },
                                        { id: 'attention', label: 'CAPTCHA', n: courseStats.attention },
                                        { id: 'running', label: 'RUNNING', n: courseStats.running }
                                    ].map((f) => (
                                        <button
                                            key={f.id}
                                            type="button"
                                            onClick={() => setOutcomeFilter(f.id)}
                                            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide transition ${
                                                outcomeFilter === f.id
                                                    ? `${runStatusBadgeClass(f.id === 'all' ? 'unknown' : f.id)} ring-1 ring-white/20`
                                                    : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-muted/40'
                                            }`}
                                        >
                                            {f.label}
                                            <span className="tabular-nums opacity-80">{f.n}</span>
                                        </button>
                                    ))}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="ml-auto h-7 gap-1 px-2 text-[10px] text-muted-foreground hover:text-destructive"
                                        disabled={busy || !courses.length}
                                        onClick={clearBidHistory}
                                        title="Clear Lumi history"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        Clear history
                                    </Button>
                                </div>
                                <div
                                    ref={courseListScrollRef}
                                    onScroll={onUserScroll('list')}
                                    className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5"
                                    style={{ WebkitOverflowScrolling: 'touch' }}
                                >
                                    {!filteredCourses.length && (
                                        <p className="rounded-lg border border-dashed border-border/80 px-4 py-10 text-center text-sm text-muted-foreground">
                                            {courses.length
                                                ? `No ${outcomeFilter} courses in this filter.`
                                                : 'No courses yet. Process selected links to create them.'}
                                        </p>
                                    )}
                                    {filteredCourses.map((c) => {
                                        const statusEv = lastStatusEvent(c);
                                        const run = courseRunStatus({
                                            ...c,
                                            last_event_type: statusEv.event_type || c.last_event_type,
                                            last_event_meta: statusEv.meta || c.last_event_meta
                                        });
                                        const failDetail = run.kind === 'failed' || run.kind === 'attention'
                                            ? failureSummary(
                                                statusEv.event_type || c.last_event_type,
                                                statusEv.meta || c.last_event_meta,
                                                { jobUrl: c.job_url }
                                            )
                                            : '';
                                        const active = String(selectedId) === String(c.id);
                                        const company = displayCompanyName(c, null, jobLinkById);
                                        const listProgress = run.kind === 'running'
                                            ? bidStageProgress({
                                                lastEventType: statusEv.event_type || c.last_event_type,
                                                lastEventMeta: statusEv.meta || c.last_event_meta,
                                                queueState:
                                                    String(queueState?.currentId) === String(c.application_id)
                                                        ? queueState
                                                        : null
                                            })
                                            : null;
                                        const badgeClass = runStatusBadgeClass(run.kind);
                                        return (
                                            <button
                                                key={c.id}
                                                type="button"
                                                onClick={() => {
                                                    selectedIdTouchedRef.current = true;
                                                    setSelectedId(c.id);
                                                    setWorkspaceTab('form');
                                                }}
                                                className={`group block w-full rounded-xl border px-3.5 py-3 text-left text-sm transition duration-150 ${runStatusRowClass(run.kind)} ${
                                                    active
                                                        ? 'border-primary/40 bg-primary/5 ring-1 ring-primary/20'
                                                        : 'border-border/50 bg-background/40 hover:border-primary/25 hover:bg-card hover:shadow-sm'
                                                }`}
                                            >
                                                <div className="flex flex-wrap items-start justify-between gap-2">
                                                    <div className="min-w-0 flex-1 font-medium leading-snug break-words">
                                                        {company} — {c.job_role || 'Role'}
                                                    </div>
                                                    <span
                                                        className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold tracking-wide ${badgeClass}`}
                                                    >
                                                        {run.short}
                                                    </span>
                                                </div>
                                                <div
                                                    className={`mt-1 text-xs ${
                                                        run.kind === 'failed'
                                                            ? 'text-red-300'
                                                            : run.kind === 'success'
                                                                ? 'text-emerald-300/90'
                                                                : run.kind === 'filled'
                                                                    ? 'text-sky-300/90'
                                                                    : 'text-muted-foreground'
                                                    }`}
                                                >
                                                    #{c.id} · {run.label}
                                                </div>
                                                {listProgress ? (
                                                    <div className="mt-2">
                                                        <BidProgressBar
                                                            compact
                                                            pct={listProgress.pct || 15}
                                                            label={listProgress.label || 'In progress…'}
                                                            tone="sky"
                                                            stepIndex={-1}
                                                        />
                                                    </div>
                                                ) : null}
                                                {run.kind === 'failed' && failDetail ? (
                                                    <div className="mt-1 text-[11px] leading-snug text-destructive/90">
                                                        {failDetail}
                                                    </div>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </ModalTabsContent>

                        <ModalTabsContent value="form">
                            <div
                                ref={detailScrollRef}
                                onScroll={onUserScroll('detail')}
                                className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1"
                                style={{ WebkitOverflowScrolling: 'touch' }}
                            >
                                {!detail && (
                                    <p className="text-sm text-muted-foreground">
                                        Select a Bid course first to inspect the filled form.
                                    </p>
                                )}
                                {detail && (
                                    <>
                                        {(() => {
                                            const run = detailRun || courseRunStatus(detail.course);
                                            return (
                                                <div className={`rounded-lg border px-3 py-2.5 text-sm ${runStatusBannerClass(run.kind)}`}>
                                                    <div className="text-sm font-bold tracking-wide">
                                                        {runStatusHeadline(run.kind, run.short)}
                                                    </div>
                                                    <p className="mt-1 text-xs leading-relaxed opacity-95">{run.label}</p>
                                                    {detailIssue && run.kind === 'failed' ? (
                                                        <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-red-100/95">
                                                            {detailIssue}
                                                        </p>
                                                    ) : null}
                                                    {run.kind === 'filled' ? (
                                                        <p className="mt-2 text-xs text-sky-100/90">
                                                            FILLED means the form was filled — it is not SUCCESS until the site shows thank-you.
                                                            Check the Success screenshot, or Open apply / mark Submitted OK if confirmed.
                                                        </p>
                                                    ) : null}
                                                    {run.kind === 'success' ? (
                                                        <p className="mt-2 text-xs text-emerald-100/90">
                                                            Site confirmed this application (SUCCESS).
                                                        </p>
                                                    ) : null}
                                                    {(run.kind === 'attention' || run.kind === 'running')
                                                    && (bidProgress.pct > 0 || bidProgress.label) ? (
                                                        <BidProgressBar
                                                            className="mt-2"
                                                            pct={bidProgress.pct}
                                                            label={bidProgress.label}
                                                            tone={run.kind === 'attention' ? 'amber' : bidProgress.tone}
                                                            stepIndex={bidProgress.stepIndex}
                                                        />
                                                    ) : null}
                                                </div>
                                            );
                                        })()}
                                        <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
                                            <div className="min-w-0 space-y-1">
                                                <div className="font-medium">
                                                    {displayCompanyName(detail.course, detail.application, jobLinkById)}
                                                    {' — '}
                                                    {detail.application?.job_role || detail.course?.job_role}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                    Status: {detail.application?.status} · Generation:{' '}
                                                    {detail.application?.generation_status}
                                                    {detail.engine_version ? ` · ${detail.engine_version}` : ''}
                                                </div>
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                {detail.application?.job_url || captchaApplyUrl ? (
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="outline"
                                                        className="h-8 gap-1"
                                                        disabled={busy || dockBusy}
                                                        title="Focus the same apply tab Lumi is using (keeps filled fields)"
                                                        onClick={() => openCaptchaTab()}
                                                    >
                                                        <ExternalLink className="h-3.5 w-3.5" />
                                                        Open tab
                                                    </Button>
                                                ) : null}
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="ghost"
                                                    className="h-8"
                                                    onClick={() => setWorkspaceTab('log')}
                                                >
                                                    View log
                                                </Button>
                                            </div>
                                        </div>

                                        {monitorStatusComment ? (
                                            <div className="rounded-md border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-xs leading-snug text-sky-50">
                                                <span className="font-semibold text-sky-200">Status · </span>
                                                {monitorStatusComment}
                                            </div>
                                        ) : null}

                                        {latestShot && courseIdForShots ? (
                                            <LiveScreenshotPanel
                                                courseId={courseIdForShots}
                                                shot={latestShot}
                                                isAdmin={isAdmin}
                                                refreshKey={shotBustKey}
                                                lastRefreshedAt={lastRefreshedAt}
                                                onExpand={() => openLightbox(latestShot)}
                                            />
                                        ) : selectedId ? (
                                            <div className="rounded-lg border border-dashed border-border/60 bg-muted/10 px-3 py-6 text-center text-xs text-muted-foreground">
                                                Loading screenshots for this job…
                                            </div>
                                        ) : null}

                                        <div>
                                            <div className="mb-1 flex items-center justify-between gap-2 text-sm font-medium">
                                                <span className="inline-flex items-center gap-1">
                                                    <Camera className="h-4 w-4" /> Screenshots
                                                </span>
                                                <span className="text-[11px] font-normal text-muted-foreground">
                                                    Full width — click any frame to zoom
                                                </span>
                                            </div>
                                            <div className="grid grid-cols-1 gap-4">
                                                {reviewShots.map((s) => (
                                                    <AuthShot
                                                        key={`${courseIdForShots}-${s.stage}-${s.filename}-${s.updated_ms || s.created_at || ''}`}
                                                        courseId={courseIdForShots}
                                                        filename={s.filename}
                                                        stage={s.stage}
                                                        isAdmin={isAdmin}
                                                        refreshKey={shotBustKey}
                                                        onExpand={() => openLightbox(s)}
                                                    />
                                                ))}
                                                {!reviewShots.length && (
                                                    <p className="text-xs text-muted-foreground">No screenshots yet.</p>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </ModalTabsContent>

                        <ModalTabsContent value="log">
                            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
                                {!detail && (
                                    <p className="text-sm text-muted-foreground">
                                        Select a Bid course to see answers and timeline.
                                    </p>
                                )}
                                {detail && (
                                    <>
                                        <div className="space-y-1 text-sm">
                                            <div className="font-medium">
                                                {displayCompanyName(detail.course, detail.application, jobLinkById)}
                                                {' — '}
                                                {detail.application?.job_role || detail.course?.job_role}
                                            </div>
                                            {detail.application?.job_url && (
                                                <a
                                                    className="break-all text-primary underline"
                                                    href={detail.application.job_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    {detail.application.job_url}
                                                </a>
                                            )}
                                            {detail.application?.download_url && (
                                                <a
                                                    className="block text-xs text-primary underline"
                                                    href={detail.application.download_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    Download CV
                                                </a>
                                            )}
                                        </div>

                                        <div>
                                            <div className="mb-1 text-sm font-medium">Answers</div>
                                            <div className="space-y-1 text-xs">
                                                {(detail.course?.answers || []).length === 0 && (
                                                    <p className="text-muted-foreground">No answers logged.</p>
                                                )}
                                                {(detail.course?.answers || []).map((a, i) => (
                                                    <div key={i} className="rounded border px-2 py-1">
                                                        <div className="font-medium">{a.label || a.id}</div>
                                                        <div className="whitespace-pre-wrap text-muted-foreground">
                                                            {a.answer || a.value || '—'}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div>
                                            <div className="mb-1 text-sm font-medium">Field attempts</div>
                                            <div className="max-h-64 space-y-1 overflow-y-auto text-xs">
                                                {(detail.field_attempts || []).length === 0 && (
                                                    <p className="text-muted-foreground">None yet.</p>
                                                )}
                                                {(detail.field_attempts || []).map((a) => (
                                                    <div
                                                        key={a.id}
                                                        className={`flex flex-wrap gap-2 border-b border-border/40 py-0.5 ${
                                                            a.ok ? '' : 'text-destructive'
                                                        }`}
                                                    >
                                                        <span className="text-muted-foreground">
                                                            p{a.page_index}#{a.attempt_n}
                                                        </span>
                                                        <span className="font-medium">{a.field_label || a.field_id}</span>
                                                        <span>{a.ok ? 'ok' : 'fail'}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div>
                                            <div className="mb-1 text-sm font-medium">Timeline</div>
                                            <div className="max-h-[min(50vh,28rem)] space-y-1 overflow-y-auto text-xs">
                                                {(() => {
                                                    const evs = (detail.events || []).filter((e) => {
                                                        const t = String(e.event_type || '');
                                                        if (/^(screenshot|live)$/i.test(t)
                                                            && String(e.meta?.stage || '').toLowerCase() === 'live') {
                                                            return false;
                                                        }
                                                        return true;
                                                    });
                                                    const startAt = detail.course?.started_at
                                                        || evs[0]?.at
                                                        || detail.course?.created_at;
                                                    return evs.map((e) => {
                                                        const failed = isFailureEvent(e.event_type);
                                                        const metaText = describeEventMeta(e.event_type, e.meta, {
                                                            jobUrl: detail.application?.job_url
                                                        });
                                                        const elapsed = formatElapsedSince(startAt, e.at);
                                                        return (
                                                            <div
                                                                key={e.id}
                                                                className={`flex flex-col gap-0.5 border-b border-border/40 py-1 ${
                                                                    failed ? 'text-destructive' : ''
                                                                }`}
                                                            >
                                                                <div className="flex flex-wrap gap-2">
                                                                    <span className="w-28 shrink-0 font-medium text-sky-300/90">
                                                                        {elapsed || '—'}
                                                                    </span>
                                                                    <span className="w-32 shrink-0 text-muted-foreground">{e.at}</span>
                                                                    <span className="font-medium">{e.event_type}</span>
                                                                </div>
                                                                {metaText ? (
                                                                    <div className={`pl-28 text-[11px] leading-snug ${failed ? '' : 'text-muted-foreground'}`}>
                                                                        {metaText}
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        );
                                                    });
                                                })()}
                                                {!(detail.events || []).length && (
                                                    <p className="text-muted-foreground">No events yet.</p>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                        </ModalTabsContent>
                    </ModalTabs>
                </DialogBody>
                </div>
            </DialogContent>
        </Dialog>
        <ScreenshotLightbox
            open={!!lightboxShot}
            onClose={() => setLightboxShot(null)}
            courseId={courseIdForShots}
            filename={lightboxShot?.filename}
            stage={lightboxShot?.stage}
            isAdmin={isAdmin}
            refreshKey={shotBustKey}
        />
        <BidMonitorDock
            open={dockOpen || monitorActive}
            minimized={dockMinimized}
            onClose={() => {
                setDockOpen(false);
                setMonitorActive(false);
                writeMonitorStorage({ active: false, courseId: null });
            }}
            onMinimizedChange={(v) => {
                setDockMinimized(v);
                writeMonitorStorage({ minimized: !!v });
            }}
            onExpandDialog={() => onOpenChange?.(true)}
            onFullscreen={() => activeMonitorShot && openLightbox(activeMonitorShot)}
            title={dockTitle}
            statusLine={dockStatus}
            statusComment={monitorStatusComment}
            progressPct={dockProgressPct}
            progressLabel={dockProgressLabel}
            progressTone={dockProgressTone}
            progressStepIndex={detailRun?.kind === 'success' ? 4 : bidProgress.stepIndex}
            outcomeKind={detailRun?.kind || ''}
            outcomeShort={detailRun?.short || ''}
            outcomeLabel={detailRun?.label || ''}
            jobStartedAt={
                detail?.course?.started_at
                || queueState?.jobStartedAt
                || null
            }
            jobEndedAt={
                detail?.course?.applied_at
                || detail?.course?.filled_at
                || null
            }
            queueStartedAt={queueState?.queueStartedAt || null}
            queueEndedAt={queueState?.queueEndedAt || (
                /^(?:done|stopped|empty)$/i.test(String(queueState?.status || ''))
                    ? (queueState?.updatedAt || null)
                    : null
            )}
            queueIndex={Number(queueState?.index) || 0}
            queueTotal={Number(queueState?.total) || 0}
            controlsBusy={dockBusy || busy}
            awaitingCaptcha={awaitingCaptcha}
            captchaTabMissing={captchaTabMissing}
            queueRunning={
                /running|awaiting_captcha|awaiting_email_otp|awaiting_next/i.test(String(queueState?.status || ''))
                || !!queueState?.running
                || monitorActive
            }
            onProcess={() => {
                setDockOpen(true);
                setMonitorActive(true);
                return processSelected();
            }}
            canProcess={canDockProcess}
            processLabel={dockProcessLabel}
            cvFilename={dockCvFilename}
            cvDownloadUrl={dockCvDownloadUrl}
            cvEditHref={dockCvEditHref}
            onOpenApplyTab={() => runDockControl(() => openCaptchaTab(), ownedTabMapped && !captchaTabMissing ? 'Focus tab' : 'Open apply tab')}
            onResumeCaptcha={() => runDockControl(
                () => resumeCaptcha({ force: true, focusTab: true }),
                'Resume'
            )}
            onSkipCaptcha={() => runDockControl(() => skipCaptchaJob(), 'Skip CAPTCHA')}
            onReAutofill={() => runDockControl(() => reAutofillCurrentJob(), 'Re-autofill')}
            onUpdateState={() => runDockControl(() => updateApplyState(), 'Update state')}
            onSubmitApply={() => runDockControl(() => submitApplyFromControl(), 'Submit')}
            onInstructLumi={instructLumiFromControl}
            coachStatus={
                queueState?.coachStatus
                || (queueState?.runState ? `Phase: ${queueState.runState}` : '')
                || (queueState?.running ? 'Watching…' : '')
            }
            notifFeed={notifFeed}
            onClearNotifs={() => {
                setLocalNotifs([]);
                setExtNotifs([]);
            }}
            ownedTabId={ownedTabId}
            ownedTabUrl={captchaApplyUrl || queueState?.ownedTabUrl || queueState?.currentJobUrl || ''}
            ownedTabMapped={ownedTabMapped}
            successConfirming={
                !!successLatchRef.current
                && detailRun?.kind === 'success'
                && !detail?.course?.applied_at
            }
            hostLessons={dockHostLessons}
            onToggleLesson={(les, enable) => {
                const key = `${les.host || lessonHost}|${les.field_key || les.fieldKey || 'form'}|${les.issue_key || les.issueKey || ''}`;
                setDisabledLessonKeys((prev) => {
                    const next = { ...prev };
                    if (enable) delete next[key];
                    else next[key] = true;
                    try { localStorage.setItem('lumi_disabled_fill_lessons', JSON.stringify(next)); } catch (_) { /* ignore */ }
                    try {
                        runExt('JOB_APPLY_BIDDER_SAVE_PREFS', 'Sync lesson disable', {
                            prefs: { bidderDisabledFillLessons: next }
                        }).catch(() => {});
                    } catch (_) { /* ignore */ }
                    return next;
                });
            }}
            openTabLabel={ownedTabMapped && !captchaTabMissing ? 'Focus' : 'Open'}
            courseAnswers={detail?.course?.answers || []}
            onApplyAnswers={async (answers) => {
                setDockBusy(true);
                setError('');
                setStatus('Apply answers…');
                try {
                    await applyAnswersFromPanel(answers);
                } catch (err) {
                    setError(err.message || 'Apply answers failed');
                    setStatus('');
                    throw err;
                } finally {
                    setDockBusy(false);
                }
            }}
            onListFormQuestions={listFormQuestions}
            onNextJob={() => runDockControl(
                () => runExt('JOB_APPLY_BIDDER_NEXT', 'Next'),
                'Next job'
            )}
            onStopQueue={() => runDockControl(
                () => runExt('JOB_APPLY_BIDDER_STOP', 'Stop'),
                'Stop'
            )}
            shotStage={screenshotStageLabel(activeMonitorShot?.stage)}
            imgSrc={dockShot.src}
            imgErr={dockShot.err}
            loading={dockShot.loading}
            lastRefreshedAt={lastRefreshedAt}
            updatedLabel={dockUpdatedLabel}
            frameIndex={monitorFrames.length ? monitorFrameIndex : 0}
            frameCount={monitorFrames.length}
            followLive={monitorFrameFollowLive}
            onPrevFrame={() => {
                setMonitorFrameFollowLive(false);
                setMonitorFrameIndex((i) => Math.max(0, i - 1));
            }}
            onNextFrame={() => {
                setMonitorFrameIndex((i) => {
                    const next = Math.min(monitorFrames.length - 1, i + 1);
                    if (next >= monitorFrames.length - 1) setMonitorFrameFollowLive(true);
                    else setMonitorFrameFollowLive(false);
                    return next;
                });
            }}
            onFollowLive={() => {
                setMonitorFrameFollowLive(true);
                if (monitorFrames.length) setMonitorFrameIndex(monitorFrames.length - 1);
            }}
        />
        </>
    );
}
