import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Reusable loading primitives.
 *
 *   <Loader />               – Inline spinner (button / table-cell size)
 *   <Loader size="lg" />     – Larger inline spinner
 *   <PageLoader />           – Full-page centered spinner
 *   <PageLoader message />   – Centered spinner with optional caption
 */

export function Loader({ size = 'md', className }) {
    const sizeMap = {
        xs: 'h-3 w-3',
        sm: 'h-4 w-4',
        md: 'h-5 w-5',
        lg: 'h-8 w-8',
        xl: 'h-12 w-12'
    };

    return (
        <Loader2
            className={cn('animate-spin text-primary', sizeMap[size] || sizeMap.md, className)}
            role="status"
            aria-label="Loading"
        />
    );
}

export function PageLoader({ message, size = 'xl', className }) {
    return (
        <div
            className={cn(
                'flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground',
                className
            )}
            role="status"
            aria-live="polite"
        >
            <Loader size={size} />
            {message && <p className="text-sm">{message}</p>}
        </div>
    );
}

/** Full-viewport overlay for app-level transitions (login redirect, etc.) */
export function FullscreenLoader({ message }) {
    return (
        <div
            className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background text-muted-foreground"
            role="status"
            aria-live="polite"
        >
            <Loader size="xl" />
            {message && <p className="text-sm">{message}</p>}
        </div>
    );
}

export default Loader;
