import { Link } from 'react-router-dom';
import { Users, ClipboardList, Link2, Plus, UserCog, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

const QUICK_ACTIONS = [
    { to: '/admin/profiles/new', icon: Plus, label: 'New profile', variant: 'primary' },
    { to: '/admin/pipeline/applications', icon: ShieldCheck, label: 'Applications', variant: 'default' },
    { to: '/admin/users', icon: UserCog, label: 'Users', variant: 'default' },
    { to: '/admin/assignments', icon: Link2, label: 'Assignments', variant: 'default' }
];

function MetricCell({ icon: Icon, value, label, accent }) {
    const accentMap = {
        primary: 'text-primary',
        success: 'text-emerald-400',
        info: 'text-cyan-300'
    };

    return (
        <div className="flex min-w-0 items-center gap-3 px-5 py-4">
            <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background/60', accentMap[accent])}>
                <Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
                <p className="font-display text-2xl font-semibold leading-none tracking-tight">{value}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{label}</p>
            </div>
        </div>
    );
}

export default function PlatformHero({ users, profiles, assignments, loading }) {
    if (loading) {
        return (
            <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.88)] shadow-[0_16px_48px_-28px_rgba(0,0,0,0.7)]">
                <div className="grid grid-cols-1 divide-y divide-white/[0.06] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                    {[...Array(3)].map((_, i) => (
                        <div key={i} className="flex items-center gap-3 px-5 py-4">
                            <Skeleton className="h-10 w-10 rounded-lg" />
                            <div className="space-y-2">
                                <Skeleton className="h-7 w-12" />
                                <Skeleton className="h-3 w-24" />
                            </div>
                        </div>
                    ))}
                </div>
                <div className="border-t border-white/[0.06] px-5 py-3">
                    <Skeleton className="h-9 w-full max-w-xl" />
                </div>
            </div>
        );
    }

    return (
        <div className="overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.88)] shadow-[0_16px_48px_-28px_rgba(0,0,0,0.7)]">
            <div className="grid grid-cols-1 divide-y divide-white/[0.06] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <MetricCell icon={Users} value={users} label="Team members" accent="primary" />
                <MetricCell icon={ClipboardList} value={profiles} label="Candidate profiles" accent="success" />
                <MetricCell icon={Link2} value={assignments} label="Profile assignments" accent="info" />
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] bg-white/[0.02] px-4 py-3">
                <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    Quick
                </span>
                {QUICK_ACTIONS.map(({ to, icon: Icon, label, variant }) => (
                    <Link
                        key={to}
                        to={to}
                        className={cn(
                            'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                            variant === 'primary'
                                ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                                : 'border-white/10 bg-white/[0.03] text-foreground hover:border-primary/30 hover:bg-accent/40'
                        )}
                    >
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                    </Link>
                ))}
            </div>
        </div>
    );
}
