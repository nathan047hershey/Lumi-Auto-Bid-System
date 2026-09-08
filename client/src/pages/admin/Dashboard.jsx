import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, LayoutDashboard, UserPlus, Mail, MapPin, Calendar } from 'lucide-react';
import { adminAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import StatsDashboard from '@/components/StatsDashboard';
import PlatformHero from '@/components/dashboard/PlatformHero';
import FiltersBar from '@/components/admin/FiltersBar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { formatDate } from '@/lib/utils';

function RecentProfiles({ recentProfiles }) {
    if (recentProfiles.length === 0) {
        return (
            <Card>
                <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                        <UserPlus className="h-5 w-5" />
                    </div>
                    <div>
                        <h3 className="font-semibold text-white/90">No profiles yet</h3>
                        <p className="text-sm text-white/45">Create your first candidate profile</p>
                    </div>
                    <Button asChild variant="gradient" size="sm">
                        <Link to="/admin/profiles/new">Create profile</Link>
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
                <div>
                    <CardTitle className="font-display text-base">Recent profiles</CardTitle>
                    <CardDescription>Latest candidates added</CardDescription>
                </div>
                <Button asChild variant="outline" size="sm" className="h-9">
                    <Link to="/admin/profiles">View all</Link>
                </Button>
            </CardHeader>
            <CardContent className="space-y-2">
                {recentProfiles.map((profile) => {
                    const name = `${profile.first_name} ${profile.middle_name || ''} ${profile.last_name}`.replace(/\s+/g, ' ').trim();
                    const location = [profile.city, profile.state, profile.country].filter(Boolean).join(', ') || '—';
                    return (
                        <Link
                            key={profile.id}
                            to={`/admin/profiles/${profile.id}/edit`}
                            className="group flex flex-col gap-2 rounded-xl border border-white/[0.07] bg-black/20 px-4 py-3 transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)] sm:flex-row sm:items-center sm:justify-between"
                        >
                            <div className="min-w-0">
                                <p className="truncate font-medium text-white/90 group-hover:text-white">{name}</p>
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/40">
                                    <span className="inline-flex items-center gap-1 truncate">
                                        <Mail className="h-3 w-3 shrink-0" />
                                        {profile.email || '—'}
                                    </span>
                                    <span className="inline-flex items-center gap-1 truncate">
                                        <MapPin className="h-3 w-3 shrink-0" />
                                        {location}
                                    </span>
                                </div>
                            </div>
                            <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-white/35">
                                <Calendar className="h-3 w-3" />
                                {formatDate(profile.created_at)}
                            </span>
                        </Link>
                    );
                })}
            </CardContent>
        </Card>
    );
}

function toIsoDateInput(d) {
    if (!d) return '';
    try {
        return new Date(d).toISOString().slice(0, 10);
    } catch {
        return '';
    }
}

function AdminDashboard() {
    const [overview, setOverview] = useState({
        users: 0,
        profiles: 0,
        assignments: 0,
        recentProfiles: []
    });
    const [overviewLoading, setOverviewLoading] = useState(true);

    const [stats, setStats] = useState(null);
    const [statsLoading, setStatsLoading] = useState(true);
    const [statsError, setStatsError] = useState(null);

    const [period, setPeriod] = useState('24h');
    const [customRange, setCustomRange] = useState(() => {
        const today = new Date();
        const oneDayAgo = new Date(today.getTime() - 24 * 60 * 60 * 1000);
        return {
            from: toIsoDateInput(oneDayAgo),
            to: toIsoDateInput(today)
        };
    });
    const [userId, setUserId] = useState('');

    const [users, setUsers] = useState([]);
    const [usersLoading, setUsersLoading] = useState(true);

    const loadOverview = useCallback(async () => {
        try {
            const [usersRes, profilesRes, assignmentsRes] = await Promise.all([
                adminAPI.getUsers(),
                adminAPI.getProfiles(),
                adminAPI.getAssignments()
            ]);
            const usersList = Array.isArray(usersRes.data) ? usersRes.data : [];
            const profiles = Array.isArray(profilesRes.data) ? profilesRes.data : [];
            const assignments = Array.isArray(assignmentsRes.data) ? assignmentsRes.data : [];
            setOverview({
                users: usersList.length,
                profiles: profiles.length,
                assignments: assignments.length,
                recentProfiles: profiles.slice(0, 5)
            });
        } catch (error) {
            console.error('Failed to load admin overview:', error);
        } finally {
            setOverviewLoading(false);
        }
    }, []);

    const loadUsers = useCallback(async () => {
        try {
            const res = await adminAPI.getUsers();
            setUsers(Array.isArray(res.data) ? res.data : []);
        } catch (err) {
            console.error('Failed to load users for filter:', err);
            setUsers([]);
        } finally {
            setUsersLoading(false);
        }
    }, []);

    const loadStats = useCallback(async () => {
        const params = { period };
        if (period === 'custom') {
            if (!customRange?.from || !customRange?.to) {
                params.period = '24h';
            } else {
                params.from = `${customRange.from}T00:00:00`;
                params.to = `${customRange.to}T23:59:59`;
            }
        }
        if (userId) {
            params.userIds = userId;
        }

        try {
            setStatsLoading(true);
            setStatsError(null);
            const response = await adminAPI.getStats(params);
            setStats(response.data);
        } catch (err) {
            console.error('Failed to load admin stats:', err);
            setStatsError(err.response?.data?.error || 'Failed to load statistics');
        } finally {
            setStatsLoading(false);
        }
    }, [period, customRange, userId]);

    useEffect(() => {
        loadOverview();
        loadUsers();
    }, [loadOverview, loadUsers]);

    useEffect(() => {
        loadStats();
    }, [loadStats]);

    const onReset = useCallback(() => {
        setUserId('');
        setPeriod('24h');
    }, []);

    const refreshAll = useCallback(() => {
        loadStats();
        if (!overviewLoading) loadOverview();
    }, [loadStats, loadOverview, overviewLoading]);

    const lastUpdated = stats?.generatedAtEST
        ? `Updated ${stats.generatedAtEST.replace('T', ' ')} EST`
        : null;

    return (
        <AppPage
            icon={LayoutDashboard}
            title="Dashboard"
            description="Platform overview and application activity."
            meta={lastUpdated}
        >
            <div className="space-y-6">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Platform filters</p>
                            <p className="truncate text-xs text-white/40">
                                Scope stats by period and user
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" onClick={refreshAll} disabled={statsLoading}>
                            <RefreshCw className={statsLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                    filters={(
                        <div className="w-full basis-full">
                            <FiltersBar
                                period={period}
                                customRange={customRange}
                                userId={userId}
                                users={users}
                                usersLoading={usersLoading}
                                onPeriodChange={setPeriod}
                                onCustomRangeChange={setCustomRange}
                                onUserChange={setUserId}
                                onReset={onReset}
                                loading={statsLoading}
                            />
                        </div>
                    )}
                />

                <PlatformHero
                    users={overview.users}
                    profiles={overview.profiles}
                    assignments={overview.assignments}
                    loading={overviewLoading}
                />

                <StatsDashboard
                    stats={stats}
                    loading={statsLoading}
                    error={statsError}
                    onRefresh={loadStats}
                    scope="admin"
                    embedded
                    hideFilterBar
                    hideToolbar
                    filterProps={{
                        period,
                        customRange,
                        userId,
                        users,
                        usersLoading,
                        onPeriodChange: setPeriod,
                        onCustomRangeChange: setCustomRange,
                        onUserChange: setUserId,
                        onReset
                    }}
                />

                {!overviewLoading && <RecentProfiles recentProfiles={overview.recentProfiles} />}
            </div>
        </AppPage>
    );
}

export default AdminDashboard;
