import * as React from 'react';
import { DayPicker } from 'react-day-picker';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// react-day-picker ships with its own default CSS in v9+ but exposes
// classNames for full control. We avoid loading its stylesheet so the
// calendar inherits the project's tailwind tokens and dark theme.
function Calendar({ className, classNames, showOutsideDays = true, ...props }) {
    return (
        <DayPicker
            showOutsideDays={showOutsideDays}
            className={cn('p-3', className)}
            classNames={{
                months: 'flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0',
                month: 'space-y-4',
                month_caption: 'flex justify-center pt-1 relative items-center text-sm font-medium',
                caption_label: 'text-sm font-medium',
                nav: 'flex items-center gap-1',
                button_previous: cn(
                    buttonVariants({ variant: 'outline' }),
                    'h-7 w-7 bg-transparent p-0 opacity-70 hover:opacity-100 absolute left-1 top-1 z-10'
                ),
                button_next: cn(
                    buttonVariants({ variant: 'outline' }),
                    'h-7 w-7 bg-transparent p-0 opacity-70 hover:opacity-100 absolute right-1 top-1 z-10'
                ),
                month_grid: 'w-full border-collapse space-y-1',
                weekdays: 'flex',
                weekday: 'text-muted-foreground rounded-md w-9 font-normal text-[0.8rem] flex-1 text-center',
                week: 'flex w-full mt-2',
                day: 'h-9 w-9 text-center text-sm p-0 relative flex-1 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20',
                day_button: cn(
                    buttonVariants({ variant: 'ghost' }),
                    'h-9 w-9 p-0 font-normal aria-selected:opacity-100'
                ),
                selected:
                    'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
                today: 'bg-accent text-accent-foreground',
                outside:
                    'text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground',
                disabled: 'text-muted-foreground opacity-50',
                range_start: 'rounded-l-md',
                range_end: 'rounded-r-md',
                range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
                hidden: 'invisible',
                ...classNames
            }}
            components={{
                Chevron: ({ orientation }) =>
                    orientation === 'left' ? (
                        <ChevronLeft className="h-4 w-4" />
                    ) : (
                        <ChevronRight className="h-4 w-4" />
                    )
            }}
            {...props}
        />
    );
}
Calendar.displayName = 'Calendar';

export { Calendar };
