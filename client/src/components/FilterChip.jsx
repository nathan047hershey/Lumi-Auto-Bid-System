import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function FilterChip({ label, onClear, className }) {
    return (
        <button
            type="button"
            onClick={onClear}
            className={cn(
                'inline-flex items-center gap-1 rounded-lg border border-primary/25 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/15',
                className
            )}
        >
            {label}
            <X className="h-3 w-3 opacity-70" />
        </button>
    );
}
