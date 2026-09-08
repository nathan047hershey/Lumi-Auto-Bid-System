import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Windows 11-inspired button styling.
 *
 * Visual goals:
 *  - Mica / Acrylic feel: subtle vertical gradient + faint highlight on top edge.
 *  - 1px accent-tinted border that softens on press.
 *  - System accent for primary / gradient, semantic colors for status variants.
 *  - Subtle elevation / press-depth animation (translate-y on active).
 *  - focus-ring uses --ring (Win11 system accent).
 */
const buttonVariants = cva(
    [
        'inline-flex items-center justify-center gap-2 whitespace-nowrap',
        'rounded-lg text-sm font-semibold',
        'ring-offset-background',
        'transition-[background,box-shadow,transform,border-color,color,filter] duration-150 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        // Press depth
        'active:translate-y-[1px] active:shadow-inner',
        // Subtle top highlight (mica shimmer) on every filled variant
        'relative overflow-hidden before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:bg-gradient-to-b before:from-white/10 before:to-transparent before:opacity-80'
    ].join(' '),
    {
        variants: {
            variant: {
                // System accent — Mica-style layered gradient (Win11 primary)
                default:
                    'text-primary-foreground border border-primary/45 shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_4px_16px_-2px_hsl(var(--primary)/0.4)] ' +
                    'bg-[linear-gradient(180deg,hsl(var(--primary))_0%,hsl(187_85%_40%)_100%)] ' +
                    'hover:bg-[linear-gradient(180deg,hsl(187_85%_60%)_0%,hsl(var(--primary))_100%)] hover:border-primary/65',

                gradient:
                    'text-primary-foreground border border-cyan-400/35 ' +
                    'bg-[linear-gradient(135deg,hsl(187_85%_53%)_0%,hsl(199_89%_48%)_100%)] ' +
                    'shadow-[0_4px_20px_-4px_hsl(var(--primary)/0.4)] ' +
                    'hover:brightness-110',

                // Secondary — Mica / Card surface
                secondary:
                    'text-foreground border border-border ' +
                    'bg-[linear-gradient(180deg,hsl(var(--secondary)/0.95)_0%,hsl(var(--secondary)/0.85)_100%)] ' +
                    'shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_2px_6px_-2px_rgba(0,0,0,0.3)] ' +
                    'hover:bg-[linear-gradient(180deg,hsl(var(--secondary))_0%,hsl(var(--secondary)/0.9)_100%)] hover:border-border/80',

                // Outline — Acrylic glass
                outline:
                    'text-foreground border border-input bg-background/60 backdrop-blur ' +
                    'hover:bg-accent hover:text-accent-foreground hover:border-primary/40',

                // Ghost — flat, accent on hover (Win11 secondary action)
                ghost:
                    'text-foreground/80 border border-transparent ' +
                    'hover:bg-accent/60 hover:text-foreground hover:border-border/60',

                // Destructive — Win11 red accent
                destructive:
                    'text-destructive-foreground border border-destructive/40 ' +
                    'bg-[linear-gradient(180deg,hsl(0_72%_55%)_0%,hsl(0_72%_45%)_100%)] ' +
                    'shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_4px_12px_-2px_hsl(var(--destructive)/0.5)] ' +
                    'hover:bg-[linear-gradient(180deg,hsl(0_72%_60%)_0%,hsl(0_72%_50%)_100%)] hover:border-destructive/60',

                // Success — Win11 green accent
                success:
                    'text-success-foreground border border-success/40 ' +
                    'bg-[linear-gradient(180deg,hsl(142_71%_50%)_0%,hsl(142_71%_38%)_100%)] ' +
                    'shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_4px_12px_-2px_hsl(var(--success)/0.5)] ' +
                    'hover:bg-[linear-gradient(180deg,hsl(142_71%_55%)_0%,hsl(142_71%_42%)_100%)] hover:border-success/60',

                // Warning — Win11 amber
                warning:
                    'text-warning-foreground border border-warning/40 ' +
                    'bg-[linear-gradient(180deg,hsl(38_92%_55%)_0%,hsl(38_92%_45%)_100%)] ' +
                    'shadow-[0_1px_0_rgba(255,255,255,0.1)_inset,0_4px_12px_-2px_hsl(var(--warning)/0.5)] ' +
                    'hover:bg-[linear-gradient(180deg,hsl(38_92%_60%)_0%,hsl(38_92%_48%)_100%)] hover:border-warning/60',

                // Link — system accent text only
                link:
                    'text-primary border border-transparent underline-offset-4 hover:underline hover:text-primary/90'
            },
            size: {
                default: 'h-10 px-4 py-2 text-sm',
                sm: 'h-8 rounded-lg px-3 text-xs',
                lg: 'h-11 rounded-xl px-6 text-[15px]',
                xl: 'h-12 rounded-xl px-8 text-base',
                icon: 'h-10 w-10'
            }
        },
        defaultVariants: {
            variant: 'default',
            size: 'default'
        }
    }
);

const Button = React.forwardRef(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : 'button';
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        );
    }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
