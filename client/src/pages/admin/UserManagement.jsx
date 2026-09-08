import { useMemo, useState, useEffect } from 'react';
import { Plus, Search, Trash2, Users } from 'lucide-react';
import { adminAPI, authAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const ALL_ROLES = ['user', 'caller', 'developer', 'manager', 'admin'];

const ROLE_BADGE = {
    admin: 'default',
    manager: 'outline',
    caller: 'secondary',
    developer: 'secondary',
    user: 'outline'
};

function UserManagement() {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [formData, setFormData] = useState({ username: '', password: '', role: 'user' });
    const [formError, setFormError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [roleDropdown, setRoleDropdown] = useState({}); // { userId: '' }
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');

    useEffect(() => {
        loadUsers();
    }, []);

    const loadUsers = async () => {
        try {
            const response = await adminAPI.getUsers();
            setUsers(Array.isArray(response.data) ? response.data : []);
        } catch (error) {
            console.error('Failed to load users:', error);
            setUsers([]);
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async (e) => {
        e.preventDefault();
        setFormError('');
        setSubmitting(true);

        try {
            await authAPI.register(formData.username, formData.password, formData.role);
            setShowModal(false);
            setFormData({ username: '', password: '', role: 'user' });
            loadUsers();
        } catch (error) {
            setFormError(error.response?.data?.error || 'Failed to create user');
        } finally {
            setSubmitting(false);
        }
    };

    const handleAssignRole = async (userId) => {
        const role = roleDropdown[userId];
        if (!role) return;

        try {
            await adminAPI.assignRole(userId, role);
            setRoleDropdown({ ...roleDropdown, [userId]: '' });
            loadUsers();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to assign role');
        }
    };

    const handleRemoveRole = async (userId, role) => {
        if (!confirm(`Remove ${role} role from this user?`)) return;

        try {
            await adminAPI.removeRole(userId, role);
            loadUsers();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to remove role');
        }
    };

    const handleDelete = async (id, username) => {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;

        try {
            await adminAPI.deleteUser(id);
            loadUsers();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to delete user');
        }
    };

    const getAllRoles = (user) => {
        const roles = [user.role];
        if (user.additional_roles && user.additional_roles.length > 0) {
            roles.push(...user.additional_roles);
        }
        return [...new Set(roles)];
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return users.filter((user) => {
            const roles = getAllRoles(user);
            if (roleFilter !== 'all' && !roles.includes(roleFilter)) return false;
            if (!q) return true;
            return (
                String(user.username || '').toLowerCase().includes(q)
                || String(user.id).includes(q)
                || roles.some((r) => r.includes(q))
            );
        });
    }, [users, search, roleFilter]);

    if (loading) {
        return <PageLoader message="Loading users..." />;
    }

    return (
        <AppPage
            icon={Users}
            title="User Management"
            description="Create and manage platform users"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                            <Input
                                className="h-10 border-white/10 bg-black/25 pl-10"
                                placeholder="Search username, id, or role…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                    )}
                    actions={(
                        <Button className="h-10" onClick={() => setShowModal(true)}>
                            <Plus className="h-4 w-4" />
                            Create User
                        </Button>
                    )}
                    filters={(
                        <Select value={roleFilter} onValueChange={setRoleFilter}>
                            <SelectTrigger className="h-9 w-[9rem] border-white/10 bg-black/20">
                                <SelectValue placeholder="Role" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All roles</SelectItem>
                                {ALL_ROLES.map((r) => (
                                    <SelectItem key={r} value={r}>{r}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                />

                <ListToolbar
                    label={`${filtered.length} user${filtered.length === 1 ? '' : 's'}`}
                />

                {users.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center">
                        <Users className="mx-auto mb-3 h-10 w-10 text-white/25" />
                        <h3 className="text-base font-semibold text-white/80">No users yet</h3>
                        <p className="mt-1 text-sm text-white/40">Create your first user to get started</p>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                        No users match the current filters
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filtered.map((user) => {
                            const roles = getAllRoles(user);
                            const assignable = ALL_ROLES.filter((r) => !roles.includes(r));
                            return (
                                <article
                                    key={user.id}
                                    className={cn(
                                        'overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4',
                                        'transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)]'
                                    )}
                                >
                                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <p className="text-base font-semibold tracking-tight">
                                                    {user.username}
                                                </p>
                                                <span className="font-mono text-[11px] text-white/35">#{user.id}</span>
                                            </div>
                                            <p className="mt-1 text-xs text-white/40">
                                                Created {new Date(user.created_at).toLocaleDateString()}
                                            </p>
                                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                                                {roles.map((role) => (
                                                    <Badge
                                                        key={role}
                                                        variant={ROLE_BADGE[role] || 'outline'}
                                                        className="gap-1 text-[10px] font-medium capitalize"
                                                    >
                                                        {role}
                                                        {role !== user.role && (
                                                            <button
                                                                type="button"
                                                                className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                                                                onClick={() => handleRemoveRole(user.id, role)}
                                                                title="Remove role"
                                                            >
                                                                ×
                                                            </button>
                                                        )}
                                                    </Badge>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                                            {assignable.length > 0 && (
                                                <>
                                                    <Select
                                                        value={roleDropdown[user.id] || undefined}
                                                        onValueChange={(value) => setRoleDropdown({
                                                            ...roleDropdown,
                                                            [user.id]: value
                                                        })}
                                                    >
                                                        <SelectTrigger className="h-9 w-[8.5rem] border-white/10 bg-black/20">
                                                            <SelectValue placeholder="Add role" />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            {assignable.map((r) => (
                                                                <SelectItem key={r} value={r}>{r}</SelectItem>
                                                            ))}
                                                        </SelectContent>
                                                    </Select>
                                                    <Button
                                                        size="sm"
                                                        className="h-9"
                                                        onClick={() => handleAssignRole(user.id)}
                                                        disabled={!roleDropdown[user.id]}
                                                    >
                                                        Add
                                                    </Button>
                                                </>
                                            )}
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                className="h-9"
                                                onClick={() => handleDelete(user.id, user.username)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                                Delete
                                            </Button>
                                        </div>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Create User Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">Create New User</h2>
                            <button className="modal-close" onClick={() => setShowModal(false)}>×</button>
                        </div>
                        <form onSubmit={handleCreate}>
                            <div className="modal-body">
                                {formError && <div className="alert alert-error">{formError}</div>}

                                <div className="form-group">
                                    <label className="form-label">Username</label>
                                    <input
                                        type="text"
                                        className="form-input"
                                        value={formData.username}
                                        onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                        placeholder="Enter username"
                                        required
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label">Password</label>
                                    <input
                                        type="password"
                                        className="form-input"
                                        value={formData.password}
                                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                        placeholder="Enter password"
                                        required
                                    />
                                </div>

                                <div className="form-group">
                                    <label className="form-label">Role</label>
                                    <select
                                        className="form-input"
                                        value={formData.role}
                                        onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                                    >
                                        <option value="user">user</option>
                                        <option value="caller">caller</option>
                                        <option value="developer">developer</option>
                                        <option value="manager">manager</option>
                                        <option value="admin">admin</option>
                                    </select>
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" className="btn btn-primary" disabled={submitting}>
                                    {submitting ? 'Creating...' : 'Create User'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </AppPage>
    );
}

export default UserManagement;
