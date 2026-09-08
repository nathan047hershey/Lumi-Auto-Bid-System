/**
 * High-contrast chart palette for dark UI backgrounds.
 */
export const CHART = {
    axis: '#d4d4d8',
    grid: 'rgba(212, 212, 216, 0.28)',
    applied: '#5eead4',
    replied: '#67e8f9',
    scheduled: '#6ee7b7',
    primary: '#5eead4',
    secondary: '#67e8f9',
    tertiary: '#6ee7b7',
    muted: '#a1a1aa',
    track: 'rgba(255, 255, 255, 0.12)',
    funnel: {
        applied: { bg: '#155e75', border: '#22d3ee' },
        replied: { bg: '#115e59', border: '#2dd4bf' },
        scheduled: { bg: '#065f46', border: '#34d399' }
    }
};

export const CHART_SERIES = [
    { key: 'applied', label: 'Applied', color: CHART.applied },
    { key: 'replied', label: 'Replied', color: CHART.replied },
    { key: 'scheduled', label: 'Interviews', color: CHART.scheduled }
];
