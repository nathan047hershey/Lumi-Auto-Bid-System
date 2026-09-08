import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AuthLayout from '@/components/AuthLayout';

function PasswordReset() {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [success, setSuccess] = useState('');
    const [error, setError] = useState('');
    const [resetData, setResetData] = useState({ username: '', newPassword: '', confirmPassword: '' });

    const handleChange = (e) => {
        const { name, value } = e.target;
        setResetData((prev) => ({ ...prev, [name]: value }));
        setError('');
        setSuccess('');
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        if (!resetData.username || !resetData.newPassword || !resetData.confirmPassword) {
            setError('All fields are required');
            return;
        }
        if (resetData.newPassword.length < 6) {
            setError('New password must be at least 6 characters');
            return;
        }
        if (resetData.newPassword !== resetData.confirmPassword) {
            setError('Passwords do not match');
            return;
        }
        setLoading(true);
        try {
            await axios.post('/api/auth/reset-password', {
                username: resetData.username,
                newPassword: resetData.newPassword
            });
            setSuccess('Password updated. Redirecting to sign in…');
            setResetData({ username: '', newPassword: '', confirmPassword: '' });
            setTimeout(() => navigate('/login'), 2000);
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to reset password');
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthLayout title="Reset password" subtitle="Choose a new password for your account">
            {success && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border border-success/40 bg-success/10 p-3 text-sm text-success">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{success}</span>
                </div>
            )}
            {error && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input id="username" name="username" value={resetData.username} onChange={handleChange} placeholder="Your username" disabled={loading} autoFocus required />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="newPassword">New password</Label>
                    <Input id="newPassword" type="password" name="newPassword" value={resetData.newPassword} onChange={handleChange} placeholder="At least 6 characters" disabled={loading} required />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm password</Label>
                    <Input id="confirmPassword" type="password" name="confirmPassword" value={resetData.confirmPassword} onChange={handleChange} placeholder="Repeat password" disabled={loading} required />
                </div>
                <Button type="submit" disabled={loading} className="w-full rounded-xl" size="lg" variant="gradient">
                    {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> Updating…</>) : 'Update password'}
                </Button>
            </form>
            <p className="mt-5 text-center text-sm text-muted-foreground">
                <Link to="/login" className="font-semibold text-primary hover:underline">← Back to sign in</Link>
            </p>
        </AuthLayout>
    );
}

export default PasswordReset;
