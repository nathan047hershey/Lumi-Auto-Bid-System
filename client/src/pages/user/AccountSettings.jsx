import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../../context/AuthContext';
import { User, ShieldCheck, KeyRound, Save, Loader2 } from 'lucide-react';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import LumiBidderSettings from '@/components/LumiBidderSettings';

function autofillSettingsPath(role) {
    const r = String(role || 'user').toLowerCase();
    if (r === 'admin') return '/admin/autofill-settings';
    if (r === 'manager') return '/manager/autofill-settings';
    return '/user/autofill-settings';
}

function AccountSettings() {
    const { user, additionalRoles } = useAuth();
    const [formData, setFormData] = useState({
        username: '',
        email: '',
        newPassword: '',
        confirmPassword: ''
    });
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (user) {
            setFormData((prev) => ({
                ...prev,
                username: user.username || '',
                email: user.email || ''
            }));
        }
    }, [user]);

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        if (window.location.hash !== '#lumi-bidder-settings') return undefined;
        const t = window.setTimeout(() => {
            document.getElementById('lumi-bidder-settings')?.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }, 120);
        return () => clearTimeout(t);
    }, [user]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        if (formData.newPassword && formData.newPassword !== formData.confirmPassword) {
            setError('New passwords do not match');
            return;
        }

        setLoading(true);
        try {
            // Update via available endpoint - prefer password reset for password change
            if (formData.newPassword) {
                await axios.post('/api/auth/reset-password', {
                    username: user.username,
                    newPassword: formData.newPassword
                });
            }
            setSuccess('Account updated successfully');
            setFormData((prev) => ({
                ...prev,
                newPassword: '',
                confirmPassword: ''
            }));
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update account');
        } finally {
            setLoading(false);
        }
    };

    if (!user) {
        return (
            <AppPage icon={User} title="Account Settings" description="Manage your profile, security, and Lumi">
                <div className="space-y-4">
                    <Skeleton className="h-16 w-full rounded-2xl" />
                    <Skeleton className="h-64 w-full rounded-2xl" />
                </div>
            </AppPage>
        );
    }

    const allRoles = [user.role, ...additionalRoles.filter((r) => r !== user.role)];
    const showLumiSettings = ['admin', 'user', 'manager', 'caller'].includes(String(user.role || '').toLowerCase())
        || additionalRoles.some((r) => ['admin', 'user', 'manager', 'caller'].includes(String(r || '').toLowerCase()));

    return (
        <AppPage icon={User} title="Account Settings" description="Manage your profile, security, and Lumi">
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">@{user.username}</p>
                            <p className="truncate text-xs text-white/40">
                                Profile, password, and Lumi preferences
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button type="submit" form="account-settings-form" size="sm" className="h-10" disabled={loading}>
                            {loading ? (
                                <>
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    Saving...
                                </>
                            ) : (
                                <>
                                    <Save className="h-4 w-4" />
                                    Save changes
                                </>
                            )}
                        </Button>
                    )}
                />

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Profile</CardTitle>
                        <CardDescription>Update your account information</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {error && (
                            <div className="mb-4 rounded-xl border border-destructive/50 bg-destructive/15 p-3 text-sm text-red-200">
                                {error}
                            </div>
                        )}
                        {success && (
                            <div className="mb-4 rounded-xl border border-success/40 bg-success/10 p-3 text-sm text-success">
                                {success}
                            </div>
                        )}

                        <form id="account-settings-form" onSubmit={handleSubmit} className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="username">Username</Label>
                                <Input id="username" value={formData.username} disabled />
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="email">Email</Label>
                                <Input
                                    id="email"
                                    type="email"
                                    value={formData.email}
                                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                                />
                            </div>

                            <Separator />

                            <div className="space-y-2">
                                <Label>Change password</Label>
                                <p className="text-xs text-muted-foreground">Leave blank to keep your current password</p>
                            </div>

                            <div className="grid gap-3 md:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="newPassword">New password</Label>
                                    <Input
                                        id="newPassword"
                                        type="password"
                                        value={formData.newPassword}
                                        onChange={(e) => setFormData({ ...formData, newPassword: e.target.value })}
                                        placeholder="At least 6 characters"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="confirmPassword">Confirm new password</Label>
                                    <Input
                                        id="confirmPassword"
                                        type="password"
                                        value={formData.confirmPassword}
                                        onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                                    />
                                </div>
                            </div>

                            <Button type="submit" disabled={loading}>
                                {loading ? (
                                    <>
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Save className="h-4 w-4" />
                                        Save changes
                                    </>
                                )}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                {showLumiSettings ? (
                    <Card>
                        <CardHeader>
                            <CardTitle>Lumi</CardTitle>
                            <CardDescription>
                                AFK, CAPTCHA solver keys, and auto-submit — synced to the Lumi extension.
                                Full page:{' '}
                                <Link className="underline" to={autofillSettingsPath(user.role)}>
                                    Autofill Settings
                                </Link>
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <LumiBidderSettings
                                showTitle={false}
                                showProfileAutofillHint={user.role === 'admin' || user.role === 'manager'}
                            />
                        </CardContent>
                    </Card>
                ) : null}
                </div>

                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <User className="h-4 w-4" />
                                Account
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Username</span>
                                <span className="font-medium">{user.username}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">User ID</span>
                                <span className="font-mono text-xs">{user.id}</span>
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <ShieldCheck className="h-4 w-4" />
                                Roles
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-wrap gap-2">
                                {allRoles.map((role) => (
                                    <Badge key={role} variant="default" className="capitalize">
                                        {role}
                                    </Badge>
                                ))}
                            </div>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base">
                                <KeyRound className="h-4 w-4" />
                                Security
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="text-sm text-muted-foreground">
                            Use a strong, unique password to keep your account secure.
                        </CardContent>
                    </Card>
                </div>
            </div>
            </div>
        </AppPage>
    );
}

export default AccountSettings;
