import { useEffect, useState } from 'react';
import { formatDurationCompact } from '@/lib/bidCourseFailure';
import { parseSqliteUtcMs } from '@/lib/sqliteDate';

/** Format persisted CV generation duration (ms) → "12s", "1m 5s". */
export function formatCvGenerationMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    return formatDurationCompact(n / 1000);
}

/**
 * One clock: first Generating start → Ready/Failed finish (or now if still running).
 */
export function cvGenerationDurationMs(row, { now = Date.now() } = {}) {
    if (!row) return null;
    const start = parseSqliteUtcMs(row.generation_started_at);
    const status = String(row.generation_status || '');
    if (status === 'generating') {
        if (!Number.isFinite(start) || start <= 0) return null;
        return Math.max(0, now - start);
    }
    if (Number.isFinite(start) && start > 0) {
        const end = parseSqliteUtcMs(row.generation_finished_at);
        if (Number.isFinite(end) && end >= start) return end - start;
    }
    const stored = Number(row.generation_ms);
    if (Number.isFinite(stored) && stored > 0) return stored;
    return null;
}

/**
 * Label for a Job Links CV chip / card.
 * Ready / failed → start→finish (or stored generation_ms).
 * Generating → elapsed since generation_started_at.
 */
export function cvGenerationTimeLabel(row, { now = Date.now() } = {}) {
    if (!row) return null;
    const status = String(row.generation_status || '');
    if (status === 'pending') return formatCvGenerationMs(row.generation_ms);
    return formatCvGenerationMs(cvGenerationDurationMs(row, { now }));
}

/** Re-render once a second while any CV is generating so the chip clock moves. */
export function useNowTick(active, intervalMs = 1000) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return undefined;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(id);
    }, [active, intervalMs]);
    return now;
}
