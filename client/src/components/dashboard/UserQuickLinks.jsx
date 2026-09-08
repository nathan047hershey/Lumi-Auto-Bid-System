import { Link } from 'react-router-dom';
import { ClipboardList, FileText, Send, CalendarClock, Settings, Link2, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';

const LINKS = [
    { to: '/user/settings', icon: Settings, label: 'Settings' },
    { to: '/user/profiles', icon: ClipboardList, label: 'My profiles' },
    { to: '/user/pipeline', icon: Link2, label: 'Pipeline' },
    { to: '/user/pipeline/applications', icon: Send, label: 'Applications' },
    { to: '/user/pipeline/interviews', icon: CalendarClock, label: 'Interviews' },
    { to: '/user/performance', icon: BarChart3, label: 'Performance' },
    { to: '/user/generate', icon: FileText, label: 'Resume builder' }
];

export default function UserQuickLinks({ className }) {
    return (
        <div className={cn('flex flex-wrap gap-2', className)}>
            {LINKS.map(({ to, icon: Icon, label }) => (
                <Link
                    key={to}
                    to={to}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-primary/30 hover:bg-accent/40"
                >
                    <Icon className="h-3.5 w-3.5 text-primary" />
                    {label}
                </Link>
            ))}
        </div>
    );
}
