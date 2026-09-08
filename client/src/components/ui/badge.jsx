import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
    'inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
    {
        variants: {
            variant: {
                default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
                secondary: 'border border-border bg-secondary text-secondary-foreground hover:bg-secondary/80',
                destructive: 'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
                outline: 'border border-border bg-card text-foreground hover:bg-secondary',
                success: 'border border-emerald-500/35 bg-emerald-500/15 text-emerald-300',
                warning: 'border border-amber-500/35 bg-amber-500/15 text-amber-200',
                info: 'border border-cyan-500/35 bg-cyan-500/15 text-cyan-200',
                muted: 'border border-border bg-secondary text-foreground/85'
            }
        },
        defaultVariants: {
            variant: 'default'
        }
    }
);

function Badge({ className, variant, ...props }) {
    return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
