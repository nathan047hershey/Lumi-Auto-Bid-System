import { formatDurationCompact } from '@/lib/bidCourseFailure';

/** Format persisted CV generation duration (ms) → "12s", "1m 5s". */
export function formatCvGenerationMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    return formatDurationCompact(n / 1000);
}

/**
 * Label for a Job Links CV chip / card.
 * Ready → stored generation_ms; generating → elapsed since updated_at.
 */
export function cvGenerationTimeLabel(row, { now = Date.now() } = {}) {
    if (!row) return null;
    const status = String(row.generation_status || '');
    if (status === 'ready') {
        return formatCvGenerationMs(row.generation_ms);
    }
    if (status === 'generating' || status === 'pending') {
        const start = row.generation_updated_at || row.updated_at || row.created_at;
        if (!start) return null;
        const t = new Date(start).getTime();
        if (!Number.isFinite(t) || t <= 0) return null;
        return formatDurationCompact(Math.max(0, (now - t) / 1000));
    }
    return formatCvGenerationMs(row.generation_ms);
}
