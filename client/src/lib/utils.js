import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
    return twMerge(clsx(inputs));
}

export function formatDate(input) {
    if (!input) return '—';
    try {
        return new Date(input).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch {
        return String(input);
    }
}

/** Parse API/SQLite datetimes; bare "YYYY-MM-DD HH:MM:SS" is treated as UTC. */
function toDate(input) {
    if (input instanceof Date) return input;
    if (typeof input === 'number') return new Date(input);
    const s = String(input).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
        return new Date(s.replace(' ', 'T') + 'Z');
    }
    return new Date(s);
}

export function formatDateTime(input) {
    if (!input) return '—';
    try {
        return toDate(input).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    } catch {
        return String(input);
    }
}
