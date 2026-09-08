import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Phone, MapPin, Wallet, Plus, Edit, Trash2, AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { managerAPI } from '@/api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
    DialogClose
} from '@/components/ui/dialog';
import { cn, formatDate } from '@/lib/utils';

function ProfileCard({ profile, onDelete }) {
    const initials = [profile.first_name?.[0], profile.last_name?.[0]]
        .filter(Boolean)
        .join('')
        .toUpperCase();

    return (
        <Card className="flex h-full flex-col transition-all hover:border-primary/35 hover:shadow-lg hover:shadow-primary/10">
            <CardContent className="flex h-full flex-col gap-4 p-5">
                <div className="flex items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 via-cyan-500 to-cyan-700 text-sm font-bold text-primary-foreground ring-1 ring-white/10">
                        {initials}
                    </div>
                    <div className="min-w-0">
                        <h3 className="truncate font-semibold text-white/90">
                            {profile.first_name} {profile.middle_name || ''} {profile.last_name}
                        </h3>
                        <p className="truncate text-xs text-white/40">{profile.email || 'No email'}</p>
                    </div>
                </div>

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

                <p className="text-xs text-white/35">Created {formatDate(profile.created_at)}</p>

                <div className="mt-auto flex gap-2">
                    <Button asChild variant="secondary" className="flex-1" size="sm">
                        <Link to={`/manager/profiles/${profile.id}/edit`}>
                            <Edit className="h-4 w-4" />
                            Edit
                        </Link>
                    </Button>
                    <Button variant="destructive" className="flex-1" size="sm" onClick={() => onDelete(profile)}>
                        <Trash2 className="h-4 w-4" />
                        Delete
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

function ManagerDashboard() {
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [pendingDelete, setPendingDelete] = useState(null);
    const [deleting, setDeleting] = useState(false);

    useEffect(() => {
        loadProfiles();
    }, []);

    const loadProfiles = async () => {
        try {
            setLoading(true);
            const response = await managerAPI.getProfiles();
            setProfiles(Array.isArray(response.data) ? response.data : []);
        } catch (error) {
            console.error('Failed to load profiles:', error);
            setProfiles([]);
        } finally {
            setLoading(false);
        }
    };

    const handleConfirmDelete = async () => {
        if (!pendingDelete) return;
        setDeleting(true);
        try {
            await managerAPI.deleteProfile(pendingDelete.id);
            setProfiles((prev) => prev.filter((p) => p.id !== pendingDelete.id));
            setPendingDelete(null);
        } catch (error) {
            console.error('Failed to delete profile:', error);
            alert('Failed to delete profile');
        } finally {
            setDeleting(false);
        }
    };

    return (
        <AppPage
            icon={ClipboardList}
            title="My Profiles"
            description="Manage candidate profiles you created"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Your profiles</p>
                            <p className="truncate text-xs text-white/40">
                                {loading ? 'Loading…' : `${profiles.length} profile${profiles.length === 1 ? '' : 's'}`}
                            </p>
                        </div>
                    )}
                    actions={(
                        <>
                            <Button variant="outline" size="sm" className="h-10" onClick={loadProfiles} disabled={loading}>
                                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                                <span className="hidden sm:inline">Refresh</span>
                            </Button>
                            <Button asChild variant="gradient" size="sm" className="h-10">
                                <Link to="/manager/profiles/new">
                                    <Plus className="h-4 w-4" />
                                    New Profile
                                </Link>
                            </Button>
                        </>
                    )}
                />

                {loading ? (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {[...Array(3)].map((_, i) => (
                            <Skeleton key={i} className="h-64 w-full rounded-2xl" />
                        ))}
                    </div>
                ) : profiles.length === 0 ? (
                    <Card>
                        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                                <ClipboardList className="h-6 w-6" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-white/90">No profiles yet</h3>
                                <p className="text-sm text-white/45">
                                    Create your first candidate profile to get started
                                </p>
                            </div>
                            <Button asChild variant="gradient">
                                <Link to="/manager/profiles/new">
                                    <Plus className="h-4 w-4" />
                                    Create Profile
                                </Link>
                            </Button>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {profiles.map((profile) => (
                            <ProfileCard
                                key={profile.id}
                                profile={profile}
                                onDelete={setPendingDelete}
                            />
                        ))}
                    </div>
                )}
            </div>

            <Dialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
                <DialogContent>
                    <DialogHeader>
                        <div className="flex items-start gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                                <AlertTriangle className="h-5 w-5" />
                            </div>
                            <div>
                                <DialogTitle>Delete profile?</DialogTitle>
                                <DialogDescription>
                                    Are you sure you want to delete{' '}
                                    <strong>
                                        {pendingDelete?.first_name} {pendingDelete?.last_name}
                                    </strong>
                                    ? This action cannot be undone.
                                </DialogDescription>
                            </div>
                        </div>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <DialogClose asChild>
                            <Button variant="outline">Cancel</Button>
                        </DialogClose>
                        <Button variant="destructive" onClick={handleConfirmDelete} disabled={deleting}>
                            {deleting ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Deleting...
                                </>
                            ) : (
                                <>
                                    <Trash2 className="h-4 w-4" />
                                    Delete
                                </>
                            )}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </AppPage>
    );
}

export default ManagerDashboard;
