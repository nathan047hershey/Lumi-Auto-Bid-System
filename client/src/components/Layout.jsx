import { useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
    LayoutDashboard,
    Users,
    ClipboardList,
    Link2,
    LogOut,
    LayoutTemplate,
    PenLine,
    Menu,
    X,
    Code2,
    Settings,
    FileText,
    BarChart3,
    CalendarClock,
    Sparkles,
    ChevronDown,
    Home,
    TrendingUp
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

function pathIn(pathname, prefixes) {
    return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function NavItem({ to, label, icon: Icon, end, match, matchPrefix, onNavigate, nested }) {
    const location = useLocation();
    let active = false;
    if (match) {
        active = pathIn(location.pathname, match);
    } else if (end) {
        active = location.pathname === to
            || (matchPrefix && location.pathname.startsWith(matchPrefix));
    } else {
        active = location.pathname === to || location.pathname.startsWith(`${to}/`);
    }

    return (
        <NavLink
            to={to}
            end={end}
            onClick={onNavigate}
            className={cn(
                'group flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition',
                nested && 'pl-9 py-1.5 text-[12px]',
                active
                    ? 'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.25)]'
                    : 'text-white/55 hover:bg-white/[0.05] hover:text-white/90'
            )}
        >
            {Icon ? (
                <Icon className={cn('shrink-0 opacity-80', nested ? 'h-3.5 w-3.5' : 'h-4 w-4')} />
            ) : null}
            <span className="truncate">{label}</span>
        </NavLink>
    );
}

function NavGroup({ label, icon: Icon, open, onToggle, children, active }) {
    return (
        <div className="space-y-0.5">
            <button
                type="button"
                onClick={onToggle}
                className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium transition',
                    active
                        ? 'bg-white/[0.06] text-white'
                        : 'text-white/55 hover:bg-white/[0.05] hover:text-white/90'
                )}
            >
                {Icon ? <Icon className="h-4 w-4 shrink-0 opacity-80" /> : null}
                <span className="flex-1 truncate text-left">{label}</span>
                <ChevronDown
                    className={cn('h-3.5 w-3.5 opacity-50 transition', open && 'rotate-180')}
                />
            </button>
            {open ? <div className="space-y-0.5 pb-1">{children}</div> : null}
        </div>
    );
}

function buildNavTree({ isAdmin, isCaller, isManagerOnly, isDeveloperOnly, hasManager, hasDeveloper, userRole }) {
    if (isCaller) {
        return {
            primary: [
                { to: '/caller/dashboard', label: 'Dashboard', icon: LayoutDashboard, match: ['/caller/dashboard'] },
                { to: '/caller/profile', label: 'Profile', icon: Users, match: ['/caller/profile'] }
            ],
            more: []
        };
    }
    if (isManagerOnly) {
        return {
            primary: [
                { to: '/manager/dashboard', label: 'Dashboard', icon: LayoutDashboard, match: ['/manager/dashboard'] },
                { to: '/manager/profiles/new', label: 'Create Profile', icon: ClipboardList, match: ['/manager/profiles'] },
                { to: '/manager/autofill-settings', label: 'Autofill', icon: PenLine, match: ['/manager/autofill-settings'] }
            ],
            more: []
        };
    }
    if (isDeveloperOnly) {
        return {
            primary: [
                { to: '/developer/dashboard', label: 'Queue', icon: Code2, match: ['/developer/dashboard'] },
                { to: '/developer/profile', label: 'Profile', icon: Users, match: ['/developer/profile'] }
            ],
            more: []
        };
    }

    if (isAdmin) {
        return {
            primary: [
                { to: '/admin/dashboard', label: 'Dashboard', icon: LayoutDashboard, match: ['/admin/dashboard'] },
                {
                    id: 'pipeline',
                    label: 'Pipeline',
                    icon: Link2,
                    match: ['/admin/pipeline'],
                    children: [
                        { to: '/admin/pipeline', label: 'Job Links', icon: Link2, end: true, matchPrefix: '/admin/pipeline/links' },
                        { to: '/admin/pipeline/applications', label: 'Applications', icon: FileText, end: true },
                        { to: '/admin/pipeline/interviews', label: 'Interviews', icon: CalendarClock, end: true }
                    ]
                },
                {
                    id: 'performance',
                    label: 'Performance',
                    icon: TrendingUp,
                    match: ['/admin/performance'],
                    children: [
                        { to: '/admin/performance', label: 'Bid Courses', icon: BarChart3, end: true, matchPrefix: '/admin/performance/courses' },
                        { to: '/admin/performance/analyze', label: 'Analyze', icon: Sparkles, end: true }
                    ]
                },
                { to: '/user/generate', label: 'Resume', icon: FileText, match: ['/user/generate'] },
                {
                    id: 'people',
                    label: 'People',
                    icon: Users,
                    match: ['/admin/profiles', '/admin/users', '/admin/assignments', '/admin/developers', '/admin/autofill-settings'],
                    children: [
                        { to: '/admin/profiles', label: 'Profiles', icon: ClipboardList, end: true },
                        { to: '/admin/autofill-settings', label: 'Autofill', icon: PenLine, end: true },
                        { to: '/admin/assignments', label: 'Assignments', icon: Link2, end: true },
                        { to: '/admin/users', label: 'Users', icon: Users, end: true },
                        { to: '/admin/developers', label: 'Developers', icon: Code2, end: true }
                    ]
                }
            ],
            more: [
                { to: '/user/cv-quality', label: 'CV Quality', icon: ClipboardList },
                { to: '/admin/resume-templates', label: 'Resume Templates', icon: LayoutTemplate },
                { to: '/user/templates', label: 'Template Builder', icon: PenLine }
            ]
        };
    }

    const more = [
        { to: '/user/templates', label: 'Templates', icon: LayoutTemplate },
        { to: '/user/autofill-settings', label: 'Autofill Settings', icon: PenLine },
        { to: '/user/dashboard', label: 'Dashboard', icon: LayoutDashboard }
    ];
    if (hasManager && userRole !== 'manager') {
        more.push({ to: '/manager/dashboard', label: 'Manager', icon: ClipboardList });
    }
    if (hasDeveloper) {
        more.push({ to: '/developer/dashboard', label: 'Developer Queue', icon: Code2 });
    }

    return {
        primary: [
            { to: '/user/profiles', label: 'Home', icon: Home, match: ['/user/profiles', '/user/dashboard'] },
            {
                id: 'pipeline',
                label: 'Pipeline',
                icon: Link2,
                match: ['/user/pipeline'],
                children: [
                    { to: '/user/pipeline', label: 'Job Links', icon: Link2, end: true, matchPrefix: '/user/pipeline/links' },
                    { to: '/user/pipeline/applications', label: 'Applications', icon: FileText, end: true },
                    { to: '/user/pipeline/interviews', label: 'Interviews', icon: CalendarClock, end: true }
                ]
            },
            {
                id: 'performance',
                label: 'Performance',
                icon: TrendingUp,
                match: ['/user/performance'],
                children: [
                    { to: '/user/performance', label: 'Bid Courses', icon: BarChart3, end: true, matchPrefix: '/user/performance/courses' },
                    { to: '/user/performance/insights', label: 'Bid Insights', icon: TrendingUp, end: true },
                    { to: '/user/performance/analyze', label: 'Analyze', icon: Sparkles, end: true }
                ]
            },
            { to: '/user/generate', label: 'Resume', icon: FileText, match: ['/user/generate'] },
            { to: '/user/cv-quality', label: 'CV Quality', icon: ClipboardList, match: ['/user/cv-quality'] }
        ],
        more
    };
}

function SidebarNav({ tree, onNavigate }) {
    const location = useLocation();
    const [openGroups, setOpenGroups] = useState(() => ({
        pipeline: true,
        performance: true,
        people: true
    }));

    const toggle = (id) => setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));

    return (
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
            {tree.primary.map((item) => {
                if (item.children) {
                    const groupActive = pathIn(location.pathname, item.match || []);
                    const open = openGroups[item.id] ?? groupActive;
                    return (
                        <NavGroup
                            key={item.id}
                            label={item.label}
                            icon={item.icon}
                            open={open || groupActive}
                            active={groupActive}
                            onToggle={() => toggle(item.id)}
                        >
                            {item.children.map((child) => (
                                <NavItem
                                    key={child.to + child.label}
                                    {...child}
                                    nested
                                    onNavigate={onNavigate}
                                />
                            ))}
                        </NavGroup>
                    );
                }
                return <NavItem key={item.to} {...item} onNavigate={onNavigate} />;
            })}

            {tree.more.length > 0 ? (
                <>
                    <p className="mt-4 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">
                        More
                    </p>
                    {tree.more.map((item) => (
                        <NavItem key={item.to} {...item} onNavigate={onNavigate} />
                    ))}
                </>
            ) : null}
        </nav>
    );
}

function Layout() {
    const { user, additionalRoles, logout } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [mobileOpen, setMobileOpen] = useState(false);

    const userRole = user?.role;
    const hasAdmin = userRole === 'admin' || additionalRoles.includes('admin');
    const hasCaller = userRole === 'caller' || additionalRoles.includes('caller');
    const hasManager = userRole === 'manager' || additionalRoles.includes('manager');
    const hasDeveloper = userRole === 'developer' || additionalRoles.includes('developer');
    const isCaller = hasCaller && !hasAdmin;
    const isManagerOnly = hasManager && userRole === 'manager' && !hasAdmin;
    const isDeveloperOnly = hasDeveloper && userRole === 'developer' && !hasAdmin;
    const primaryRole = hasAdmin ? 'admin' : hasCaller ? 'caller' : hasManager ? 'manager' : hasDeveloper ? 'developer' : 'user';

    const settingsPath = hasAdmin
        ? '/admin/settings'
        : hasCaller
            ? '/caller/settings'
            : isManagerOnly
                ? '/manager/settings'
                : isDeveloperOnly
                    ? '/developer/settings'
                    : '/user/settings';

    const tree = useMemo(
        () => buildNavTree({
            isAdmin: hasAdmin,
            isCaller,
            isManagerOnly,
            isDeveloperOnly,
            hasManager,
            hasDeveloper,
            userRole
        }),
        [hasAdmin, isCaller, isManagerOnly, isDeveloperOnly, hasManager, hasDeveloper, userRole]
    );

    const closeMobile = () => setMobileOpen(false);

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    const sidebar = (
        <aside className="flex h-full w-[16.5rem] flex-col border-r border-white/[0.06] bg-[hsl(222_28%_8%)]">
            <div className="flex items-center gap-2.5 border-b border-white/[0.06] px-4 py-4">
                <span
                    className="flex h-9 w-9 items-center justify-center rounded-xl font-display text-[13px] font-bold text-[hsl(222_30%_8%)]"
                    style={{
                        background: 'linear-gradient(145deg, hsl(199 95% 58%), hsl(210 90% 48%))',
                        boxShadow: '0 0 24px hsl(199 95% 58% / 0.35)'
                    }}
                >
                    L
                </span>
                <div className="min-w-0">
                    <p className="font-display text-[15px] font-semibold tracking-tight">
                        Lu<span className="text-primary">mi</span>
                    </p>
                    <p className="truncate text-[10px] text-white/35">{primaryRole} workspace</p>
                </div>
                <Button variant="ghost" size="icon" className="ml-auto h-8 w-8 lg:hidden" onClick={closeMobile}>
                    <X className="h-4 w-4" />
                </Button>
            </div>

            <SidebarNav tree={tree} onNavigate={closeMobile} />

            <div className="mt-auto space-y-1 border-t border-white/[0.06] p-3">
                <button
                    type="button"
                    onClick={() => { navigate(settingsPath); closeMobile(); }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium text-white/55 hover:bg-white/[0.05] hover:text-white/90"
                >
                    <Settings className="h-4 w-4" />
                    Settings
                </button>
                <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium text-white/45 hover:bg-rose-500/10 hover:text-rose-300"
                >
                    <LogOut className="h-4 w-4" />
                    Sign out
                </button>
                <div className="flex items-center gap-2.5 rounded-xl bg-white/[0.03] px-3 py-2">
                    <div
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-[hsl(222_30%_8%)]"
                        style={{ background: 'linear-gradient(145deg, hsl(199 95% 58%), hsl(210 90% 48%))' }}
                    >
                        {(user?.username || '?')[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-white/85">{user?.username}</p>
                        <p className="font-mono text-[10px] uppercase tracking-wider text-white/35">{primaryRole}</p>
                    </div>
                </div>
            </div>
        </aside>
    );

    return (
        <div className="lumi-app flex h-screen overflow-hidden bg-[hsl(222_28%_6%)] text-white">
            <div className="hidden md:flex">{sidebar}</div>

            {mobileOpen ? (
                <>
                    <button
                        type="button"
                        className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
                        aria-label="Close menu"
                        onClick={closeMobile}
                    />
                    <div className="fixed inset-y-0 left-0 z-50 md:hidden">{sidebar}</div>
                </>
            ) : null}

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[hsl(222_24%_7%/0.9)] px-3 backdrop-blur-xl sm:px-5 md:hidden">
                    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => setMobileOpen(true)}>
                        <Menu className="h-5 w-5" />
                    </Button>
                    <span className="font-display text-sm font-semibold">
                        Lu<span className="text-primary">mi</span>
                    </span>
                </header>

                <main className="app-main min-h-0 flex-1 overflow-auto" key={location.pathname}>
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

export default Layout;
