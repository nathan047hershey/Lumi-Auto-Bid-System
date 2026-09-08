import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import AuthLayout from '@/components/AuthLayout';

function Login() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const user = await login(username, password);
            const isAdmin = user.role === 'admin' || user.additionalRoles?.includes('admin');
            const isCaller = user.role === 'caller' || user.additionalRoles?.includes('caller');
            const isManager = user.role === 'manager' || user.additionalRoles?.includes('manager');
            const isDeveloper = user.role === 'developer' || user.additionalRoles?.includes('developer');
            const path = isAdmin ? '/admin/settings'
                : isCaller ? '/caller/settings'
                : isManager ? '/manager/settings'
                : isDeveloper ? '/developer/settings'
                : '/user/settings';
            navigate(path);
        } catch (err) {
            setError(err.response?.data?.error || 'Login failed. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthLayout title="Welcome back" subtitle="Sign in to your Lumi workspace">
            {error && (
                <div className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                        id="username"
                        name="username"
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Username"
                        required
                        autoFocus
                        autoComplete="username"
                    />
                </div>
                <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                        id="password"
                        name="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        required
                        autoComplete="current-password"
                    />
                </div>
                <Button type="submit" disabled={loading} className="w-full rounded-xl" size="lg" variant="gradient">
                    {loading ? (<><Loader2 className="h-4 w-4 animate-spin" /> Signing in…</>) : 'Sign in'}
                </Button>
            </form>
            <p className="mt-5 text-center text-sm text-muted-foreground">
                <Link to="/reset-password" className="font-semibold text-primary hover:underline">Forgot password?</Link>
            </p>
        </AuthLayout>
    );
}

export default Login;
