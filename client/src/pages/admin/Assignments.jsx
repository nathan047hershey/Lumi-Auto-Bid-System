import { useMemo, useState, useEffect } from 'react';
import { Link2, Plus, Search, Star, Trash2, User } from 'lucide-react';
import { adminAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function Assignments() {
    const [assignments, setAssignments] = useState([]);
    const [users, setUsers] = useState([]);
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState({ user_id: '', profile_id: '' });
    const [formError, setFormError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [search, setSearch] = useState('');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        try {
            const [assignmentsRes, usersRes, profilesRes] = await Promise.all([
                adminAPI.getAssignments(),
                adminAPI.getUsers(),
                adminAPI.getProfiles()
            ]);

            setAssignments(Array.isArray(assignmentsRes.data) ? assignmentsRes.data : []);
            const users = Array.isArray(usersRes.data) ? usersRes.data : [];
            // Admins can hold profile assignments too (e.g. apply/generate as themselves).
            setUsers(users.filter((u) => u.role === 'user' || u.role === 'admin'));
            setProfiles(Array.isArray(profilesRes.data) ? profilesRes.data : []);
        } catch (error) {
            console.error('Failed to load data:', error);
            setAssignments([]);
            setUsers([]);
            setProfiles([]);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        setFormError('');
        setSubmitting(true);

        try {
            await adminAPI.createAssignment(
                parseInt(formData.user_id),
                parseInt(formData.profile_id)
            );
            setShowModal(false);
            setFormData({ user_id: '', profile_id: '' });
            loadData();
        } catch (error) {
            setFormError(error.response?.data?.error || 'Failed to create assignment');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Are you sure you want to remove this assignment?')) return;

        try {
            await adminAPI.deleteAssignment(id);
            loadData();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to delete assignment');
        }
    };

    const handleSetDefault = async (id) => {
        try {
            await adminAPI.setDefaultAssignment(id);
            loadData();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to set default');
        }
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return assignments;
        return assignments.filter((a) => {
            const hay = [a.username, a.profile_name].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(q);
        });
    }, [assignments, search]);

    if (loading) {
        return <PageLoader message="Loading assignments..." />;
    }

    return (
        <AppPage
            icon={Link2}
            title="Profile Assignments"
            description="Assign candidate profiles to users"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                            <Input
                                className="h-10 border-white/10 bg-black/25 pl-10"
                                placeholder="Search user or profile…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                    )}
                    actions={(
                        <Button className="h-10" onClick={() => setShowModal(true)}>
                            <Plus className="h-4 w-4" />
                            New Assignment
                        </Button>
                    )}
                />

                <ListToolbar
                    label={`${filtered.length} assignment${filtered.length === 1 ? '' : 's'}`}
                />

                {assignments.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center">
                        <Link2 className="mx-auto mb-3 h-10 w-10 text-white/25" />
                        <h3 className="text-base font-semibold text-white/80">No assignments yet</h3>
                        <p className="mt-1 text-sm text-white/40">
                            Assign profiles to users so they can generate resumes
                        </p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                        No assignments match “{search.trim()}”
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filtered.map((assignment) => (
                            <article
                                key={assignment.id}
                                className={cn(
                                    'overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4',
                                    'transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)]'
                                )}
                            >
                                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                                                <User className="h-4 w-4" />
                                            </span>
                                            <p className="text-base font-semibold tracking-tight">
                                                {assignment.username}
                                            </p>
                                            {assignment.is_default ? (
                                                <Badge variant="default" className="gap-1 text-[10px]">
                                                    <Star className="h-3 w-3" />
                                                    Default
                                                </Badge>
                                            ) : null}
                                        </div>
                                        <p className="mt-2 text-sm text-white/55">
                                            Profile:{' '}
                                            <span className="font-medium text-white/80">
                                                {assignment.profile_name}
                                            </span>
                                        </p>
                                        <p className="mt-1 text-xs text-white/35">
                                            Assigned {new Date(assignment.assigned_at).toLocaleDateString()}
                                        </p>
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        {!assignment.is_default && (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="h-9"
                                                onClick={() => handleSetDefault(assignment.id)}
                                            >
                                                <Star className="h-3.5 w-3.5" />
                                                Set default
                                            </Button>
                                        )}
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            className="h-9"
                                            onClick={() => handleDelete(assignment.id)}
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                            Remove
                                        </Button>
                                    </div>
                                </div>
                            </article>
                        ))}
                    </div>
                )}
            </div>

            {/* Create Assignment Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">Assign Profile to User</h2>
                            <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
                        </div>
                        <form onSubmit={handleCreate}>
                            <div className="modal-body">
                                {formError && <div className="alert alert-error">{formError}</div>}

                                {users.length === 0 && (
                                    <div className="alert alert-info">
                                        No users available. Create users first before assigning profiles.
                                    </div>
                                )}

                                {profiles.length === 0 && (
                                    <div className="alert alert-info">
                                        No profiles available. Create profiles first before assigning.
                                    </div>
                                )}

                                <div className="form-group">
                                    <label className="form-label">Select User</label>
                                    <select
                                        className="form-select"
                                        value={formData.user_id}
                                        onChange={(e) => setFormData({ ...formData, user_id: e.target.value })}
                                        required
                                    >
                                        <option value="">Choose a user...</option>
                                        {users.map((user) => (
                                            <option key={user.id} value={user.id}>
                                                {user.username}
                                                {user.role === 'admin' ? ' (admin)' : ''}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className="form-group">
                                    <label className="form-label">Select Profile</label>
                                    <select
                                        className="form-select"
                                        value={formData.profile_id}
                                        onChange={(e) => setFormData({ ...formData, profile_id: e.target.value })}
                                        required
                                    >
                                        <option value="">Choose a profile...</option>
                                        {profiles.map((profile) => (
                                            <option key={profile.id} value={profile.id}>
                                                {profile.first_name} {profile.last_name} ({profile.email || 'No email'})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    className="btn btn-primary"
                                    disabled={submitting || users.length === 0 || profiles.length === 0}
                                >
                                    {submitting ? 'Assigning...' : 'Assign Profile'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </AppPage>
    );
}

export default Assignments;
