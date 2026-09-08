import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, LayoutDashboard } from 'lucide-react';
import { userAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import StatsDashboard from '@/components/StatsDashboard';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function UserStatsDashboard() {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const loadStats = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const response = await userAPI.getStats();
            setStats(response.data);
        } catch (err) {
            console.error('Failed to load stats:', err);
            setError(err.response?.data?.error || 'Failed to load statistics');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadStats();
    }, [loadStats]);

    const lastUpdated = stats?.generatedAtEST
        ? `Updated ${stats.generatedAtEST.replace('T', ' ')} EST`
        : null;

    return (
        <AppPage
            icon={LayoutDashboard}
            title="Dashboard"
            description="Your application activity and progress."
            meta={lastUpdated}
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Activity overview</p>
                            <p className="truncate text-xs text-white/40">
                                {lastUpdated || 'Your application funnel and volume'}
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" onClick={loadStats} disabled={loading}>
                            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                />

                <StatsDashboard
                    stats={stats}
                    loading={loading}
                    error={error}
                    onRefresh={loadStats}
                    scope="user"
                    embedded
                    hideToolbar
                />
            </div>
        </AppPage>
    );
}

export default UserStatsDashboard;
