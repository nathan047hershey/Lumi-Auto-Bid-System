import { useState, useEffect } from 'react';
import { managerAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Users, Plus, Trash2, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';

const ROLE_VARIANT = {
    admin: 'destructive',
    manager: 'success',
    caller: 'info',
    user: 'muted',
    developer: 'warning'
};

function ManagerUsers() {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [formData, setFormData] = useState({ username: '', password: '', role: 'user' });
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState(null);

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        try {
            const response = await managerAPI.getUsers();
            setUsers(Array.isArray(response.data) ? response.data : []);
        } catch (error) {
            console.error('Failed to load users:', error);
            setUsers([]);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSubmitting(true);

        try {
            await managerAPI.createUser(formData);
            setFormData({ username: '', password: '', role: 'user' });
            setShowForm(false);
            loadUsers();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to create user');
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id) => {
        try {
            await managerAPI.deleteUser(id);
            setUsers(users.filter((u) => u.id !== id));
            setDeleteConfirm(null);
        } catch (error) {
            console.error('Failed to delete user:', error);
            alert('Failed to delete user');
        }
    };

    if (loading) {
        return <PageLoader message="Loading users..." />;
    }

    return (
        <AppPage
            icon={Users}
            title="User Management"
            description="Manage users you created"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">Your users</p>
                            <p className="truncate text-xs text-white/40">
                                {users.length} user{users.length === 1 ? '' : 's'} · create and delegate
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button
                            size="sm"
                            className="h-10"
                            variant={showForm ? 'outline' : 'gradient'}
                            onClick={() => setShowForm(!showForm)}
                        >
                            {showForm ? (
                                <>
                                    <X className="h-4 w-4" />
                                    Cancel
                                </>
                            ) : (
                                <>
                                    <Plus className="h-4 w-4" />
                                    Add User
                                </>
                            )}
                        </Button>
                    )}
                />

                {showForm && (
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Create New User</CardTitle>
                            <CardDescription>Username, password, and role</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {error && (
                                <div className="mb-4 rounded-xl border border-destructive/50 bg-destructive/15 px-3 py-2 text-sm text-red-200">
                                    {error}
                                </div>
                            )}
                            <form onSubmit={handleSubmit} className="space-y-4">
                                <div className="grid gap-4 sm:grid-cols-3">
                                    <div className="space-y-1.5">
                                        <Label htmlFor="username">Username *</Label>
                                        <Input
                                            id="username"
                                            value={formData.username}
                                            onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                            required
                                            className="border-white/10 bg-black/25"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label htmlFor="password">Password *</Label>
                                        <Input
                                            id="password"
                                            type="password"
                                            value={formData.password}
                                            onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                            required
                                            minLength={6}
                                            className="border-white/10 bg-black/25"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <Label>Role *</Label>
                                        <Select
                                            value={formData.role}
                                            onValueChange={(v) => setFormData({ ...formData, role: v })}
                                        >
                                            <SelectTrigger className="border-white/10 bg-black/25">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="user">User</SelectItem>
                                                <SelectItem value="caller">Caller</SelectItem>
                                                <SelectItem value="manager">Manager</SelectItem>
                                                <SelectItem value="admin">Admin</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>
                                <Button type="submit" disabled={submitting}>
                                    {submitting ? (
                                        <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Creating...
                                        </>
                                    ) : (
                                        'Create User'
                                    )}
                                </Button>
                            </form>
                        </CardContent>
                    </Card>
                )}

                {users.length === 0 ? (
                    <Card>
                        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
                                <Users className="h-6 w-6" />
                            </div>
                            <div>
                                <h3 className="font-semibold text-white/90">No users created yet</h3>
                                <p className="text-sm text-white/45">Create users to delegate profile management</p>
                            </div>
                            <Button variant="gradient" onClick={() => setShowForm(true)}>
                                <Plus className="h-4 w-4" />
                                Create First User
                            </Button>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-2">
                        {users.map((user) => (
                            <div
                                key={user.id}
                                className="flex flex-col gap-3 rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] px-4 py-3 transition-all hover:border-primary/30 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="font-medium text-white/90">{user.username}</p>
                                        <Badge variant={ROLE_VARIANT[user.role] || 'muted'} className="capitalize">
                                            {user.role}
                                        </Badge>
                                    </div>
                                    <p className="mt-1 font-mono text-[11px] text-white/35">
                                        Created {new Date(user.created_at).toLocaleDateString()}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    {deleteConfirm === user.id ? (
                                        <>
                                            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
                                                Cancel
                                            </Button>
                                            <Button variant="destructive" size="sm" onClick={() => handleDelete(user.id)}>
                                                Confirm
                                            </Button>
                                        </>
                                    ) : (
                                        <Button
                                            variant="destructive"
                                            size="sm"
                                            onClick={() => setDeleteConfirm(user.id)}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </AppPage>
    );
}

export default ManagerUsers;
