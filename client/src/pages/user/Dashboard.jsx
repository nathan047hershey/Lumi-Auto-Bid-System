import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Phone, MapPin, Wallet, FileText, RefreshCw } from 'lucide-react';
import { userAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

function ProfileCard({ profile, onDefaultChanged }) {
    const initials = [profile.first_name?.[0], profile.last_name?.[0]]
        .filter(Boolean)
        .join('')
        .toUpperCase();

    return (
        <Card className="h-full transition-all hover:border-primary/35 hover:shadow-lg hover:shadow-primary/10">
            <CardContent className="space-y-4 p-5">
                <Link to={`/user/profile/${profile.id}`} className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 via-cyan-500 to-cyan-700 text-sm font-bold text-primary-foreground ring-1 ring-white/10">
                        {initials}
                    </div>
                    <div className="min-w-0">
                        <h3 className="truncate font-semibold text-white/90">
                            {profile.first_name} {profile.middle_name || ''} {profile.last_name}
                            {profile.is_default ? (
                                <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide text-primary">
                                    Default
                                </span>
                            ) : null}
                        </h3>
                        <p className="truncate text-xs text-white/40">
                            {profile.email || 'No email'}
                        </p>
                    </div>
                </Link>

                <div className="flex flex-wrap gap-1.5 text-xs text-white/45">
                    {profile.phone && (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1">
                            <Phone className="h-3 w-3" />
                            {profile.phone}
                        </span>
                    )}
                    {profile.city && (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1">
                            <MapPin className="h-3 w-3" />
                            {profile.city}, {profile.country}
                        </span>
                    )}
                    {profile.salary_range && (
                        <span className="inline-flex items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1">
                            <Wallet className="h-3 w-3" />
                            {profile.salary_range}
                        </span>
                    )}
                </div>

                <div className="flex flex-col gap-2">
                    <Button variant="gradient" className="w-full" size="sm" asChild>
                        <Link to={`/user/generate/${profile.id}`}>
                            <FileText className="h-4 w-4" />
                            Generate Resume
                        </Link>
                    </Button>
                    {!profile.is_default && (
                        <Button
                            variant="outline"
                            className="w-full"
                            size="sm"
                            onClick={async () => {
                                try {
                                    await userAPI.setDefaultProfile(profile.id);
                                    onDefaultChanged?.();
                                } catch (err) {
                                    console.error('Failed to set default profile', err);
                                }
                            }}
                        >
                            Set as default
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
}

function UserDashboard() {
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadProfiles();
    }, []);

    const loadProfiles = async () => {
        try {
            setLoading(true);
            const response = await userAPI.getProfiles();
            setProfiles(Array.isArray(response.data) ? response.data : []);
        } catch (error) {
            console.error('Failed to load profiles:', error);
            setProfiles([]);
        } finally {
            setLoading(false);
        }
    };

    return (
        <AppPage
            icon={ClipboardList}
            title="My Profiles"
            description="View your assigned candidate profiles and generate resumes"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Assigned profiles</p>
                            <p className="truncate text-xs text-white/40">
                                {loading ? 'Loading…' : `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`}
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" onClick={loadProfiles} disabled={loading}>
                            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                            <span className="hidden sm:inline">Refresh</span>
                        </Button>
                    )}
                />

                {loading ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {[...Array(3)].map((_, i) => (
                            <Card key={i}>
                                <CardContent className="space-y-3 p-6">
                                    <div className="flex items-center gap-3">
                                        <Skeleton className="h-12 w-12 rounded-xl" />
                                        <div className="space-y-2">
                                            <Skeleton className="h-4 w-32" />
                                            <Skeleton className="h-3 w-48" />
                                        </div>
                                    </div>
                                    <Skeleton className="h-20 w-full" />
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                ) : profiles.length === 0 ? (
                    <Card>
                        <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
                            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                                <ClipboardList className="h-5 w-5" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-white/90">No profiles assigned</h3>
                                <p className="text-sm text-white/45">
                                    Contact your administrator to get candidate profiles assigned to you
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {profiles.map((profile) => (
                            <ProfileCard
                                key={profile.id}
                                profile={profile}
                                onDefaultChanged={loadProfiles}
                            />
                        ))}
                    </div>
                )}
            </div>
        </AppPage>
    );
}

export default UserDashboard;
