import { cn } from '@/lib/utils';
import AppIcon from '@/components/AppIcon';

export default function BrandMark({ compact = false, className }) {
    return (
        <div className={cn('flex items-center gap-2.5 select-none leading-none', className)}>
            <AppIcon size={compact ? 28 : 32} />
            <div>
                <span className="font-display text-[1.05rem] font-semibold tracking-tight text-white">
                    Lu
                    <span className="text-primary">mi</span>
                </span>
                {!compact && (
                    <p className="mt-1 text-[10px] font-medium tracking-wide text-white/40">
                        Auto apply workspace
                    </p>
                )}
            </div>
        </div>
    );
}
