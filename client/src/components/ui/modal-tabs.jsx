import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * Modern workspace tabs — mica segmented control (same family as Analyze pills,
 * tuned for bidding dialogs).
 */
export const modalTabsListClass =
    'flex h-auto w-full shrink-0 flex-wrap justify-start gap-0.5 rounded-xl border border-white/[0.08] bg-black/25 p-1';

export const modalTabsTriggerClass = cn(
    'h-8 rounded-lg px-3.5 text-[13px] font-semibold tracking-wide',
    'data-[state=active]:bg-primary data-[state=active]:text-primary-foreground',
    'data-[state=active]:shadow-sm data-[state=active]:shadow-primary/25'
);

export const modalTabsContentClass =
    'mt-0 flex min-h-0 flex-1 flex-col overflow-hidden pt-3 data-[state=inactive]:hidden focus-visible:outline-none focus-visible:ring-0';

export function ModalTabs({ className, ...props }) {
    return <Tabs className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)} {...props} />;
}

export function ModalTabsList({ className, ...props }) {
    return <TabsList className={cn(modalTabsListClass, className)} {...props} />;
}

export function ModalTabsTrigger({ className, ...props }) {
    return <TabsTrigger className={cn(modalTabsTriggerClass, className)} {...props} />;
}

export function ModalTabsContent({ className, ...props }) {
    return <TabsContent className={cn(modalTabsContentClass, className)} {...props} />;
}
