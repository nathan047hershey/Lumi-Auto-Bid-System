import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
    ClipboardList,
    Copy,
    MapPin,
    Pencil,
    Phone,
    Plus,
    Search,
    Trash2
} from 'lucide-react';
import { adminAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import ListToolbar from '@/components/ListToolbar';
import { cn } from '@/lib/utils';

// Display label for each techstack slug the API returns. Mirrors
// the form's PROFILE_TECHSTACKS so the chips on the card match
// the labels the admin picked in the form.
const TECHSTACK_LABEL = {
    python:   'Python',
    java:     'Java',
    dotnet:   'C# / .NET',
    golang:   'Golang',
    nodejs:   'Node.js',
    frontend: 'Frontend'
};

function CandidateProfiles() {
    const [profiles, setProfiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => {
        loadProfiles();
    }, []);

    const loadProfiles = async () => {
        try {
            const response = await adminAPI.getProfiles();
            setProfiles(Array.isArray(response.data) ? response.data : []);
        } catch (error) {
            console.error('Failed to load profiles:', error);
            setProfiles([]);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id, name) => {
        if (!confirm(`Are you sure you want to delete profile for "${name}"?`)) return;

        try {
            await adminAPI.deleteProfile(id);
            loadProfiles();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to delete profile');
        }
    };

    const handleDuplicate = async (id, name) => {
        if (!confirm(`Duplicate profile "${name}"?`)) return;

        try {
            await adminAPI.duplicateProfile(id);
            loadProfiles();
        } catch (error) {
            alert(error.response?.data?.error || 'Failed to duplicate profile');
        }
    };

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return profiles;
        return profiles.filter((p) => {
            const hay = [
                p.first_name,
                p.middle_name,
                p.last_name,
                p.email,
                p.phone,
                p.city,
                p.country,
                p.salary_range,
                ...(Array.isArray(p.techstacks) ? p.techstacks.map((s) => TECHSTACK_LABEL[s] || s) : [])
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
            return hay.includes(q);
        });
    }, [profiles, search]);

    if (loading) {
        return <PageLoader message="Loading candidate profiles..." />;
    }

    return (
        <AppPage
            icon={ClipboardList}
            title="Candidate Profiles"
            description="Manage candidate profiles and resume generation prompts"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                            <Input
                                className="h-10 border-white/10 bg-black/25 pl-10"
                                placeholder="Search name, email, city, techstack…"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                            />
                        </div>
                    )}
                    actions={(
                        <Button asChild className="h-10">
                            <Link to="/admin/profiles/new">
                                <Plus className="h-4 w-4" />
                                Create Profile
                            </Link>
                        </Button>
                    )}
                />

                <ListToolbar
                    label={`${filtered.length} profile${filtered.length === 1 ? '' : 's'}${search.trim() ? ' matching' : ''}`}
                />

                {profiles.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center">
                        <ClipboardList className="mx-auto mb-3 h-10 w-10 text-white/25" />
                        <h3 className="text-base font-semibold text-white/80">No profiles yet</h3>
                        <p className="mt-1 text-sm text-white/40">Create your first candidate profile to get started</p>
                        <Button asChild className="mt-4">
                            <Link to="/admin/profiles/new">
                                <Plus className="h-4 w-4" />
                                Create Profile
                            </Link>
                        </Button>
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 px-6 py-16 text-center text-sm text-white/40">
                        No profiles match “{search.trim()}”
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {filtered.map((profile) => {
                            const fullName = `${profile.first_name} ${profile.middle_name || ''} ${profile.last_name}`
                                .replace(/\s+/g, ' ')
                                .trim();
                            const initials = `${profile.first_name?.[0] || ''}${profile.last_name?.[0] || ''}`;
                            return (
                                <article
                                    key={profile.id}
                                    className={cn(
                                        'group flex flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-[hsl(222_24%_9%/0.75)] p-4',
                                        'transition-all hover:border-primary/35 hover:bg-[hsl(222_24%_11%/0.9)] hover:shadow-lg hover:shadow-primary/10'
                                    )}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-sm font-bold text-primary">
                                            {initials}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-base font-semibold tracking-tight group-hover:text-primary">
                                                {fullName}
                                            </p>
                                            <p className="mt-0.5 truncate text-xs text-white/40">
                                                {profile.email || 'No email'}
                                            </p>
                                        </div>
                                        <Badge
                                            variant="outline"
                                            className="shrink-0 text-[10px] font-medium"
                                            title={`Region flag: ${profile.location_flag || 'US'}`}
                                        >
                                            {profile.location_flag || 'US'}
                                        </Badge>
                                    </div>

                                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-white/45">
                                        {profile.phone && (
                                            <span className="inline-flex items-center gap-1">
                                                <Phone className="h-3 w-3" />
                                                {profile.phone}
                                            </span>
                                        )}
                                        {profile.city && (
                                            <span className="inline-flex items-center gap-1">
                                                <MapPin className="h-3 w-3" />
                                                {profile.city}{profile.country ? `, ${profile.country}` : ''}
                                            </span>
                                        )}
                                        {profile.salary_range && (
                                            <span className="inline-flex items-center gap-1">
                                                {profile.salary_range}
                                            </span>
                                        )}
                                    </div>

                                    <div className="mt-3 flex flex-wrap gap-1">
                                        {profile.gender && (
                                            <Badge variant="secondary" className="text-[10px] font-medium" title="Autofill gender">
                                                Gender: {profile.gender}
                                            </Badge>
                                        )}
                                        {profile.work_authorization && (
                                            <Badge variant="secondary" className="text-[10px] font-medium" title="Autofill work auth">
                                                Auth: {profile.work_authorization}
                                            </Badge>
                                        )}
                                        {profile.requires_sponsorship && (
                                            <Badge variant="secondary" className="text-[10px] font-medium" title="Autofill visa sponsorship">
                                                Visa: {profile.requires_sponsorship}
                                            </Badge>
                                        )}
                                        {!profile.gender && !profile.work_authorization && !profile.requires_sponsorship && (
                                            <Badge variant="outline" className="text-[10px] font-medium text-muted-foreground">
                                                Autofill defaults not set
                                            </Badge>
                                        )}
                                    </div>

                                    {Array.isArray(profile.techstacks) && profile.techstacks.length > 0 && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {profile.techstacks.map((slug) => (
                                                <Badge key={slug} variant="secondary" className="font-medium">
                                                    {TECHSTACK_LABEL[slug] || slug}
                                                </Badge>
                                            ))}
                                        </div>
                                    )}

                                    <div className="mt-auto flex gap-2 pt-4">
                                        <Button asChild variant="secondary" size="sm" className="flex-1">
                                            <Link to={`/admin/profiles/${profile.id}/edit`}>
                                                <Pencil className="h-3.5 w-3.5" />
                                                Edit
                                            </Link>
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => handleDuplicate(profile.id, fullName)}
                                            title="Duplicate"
                                        >
                                            <Copy className="h-3.5 w-3.5" />
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            size="icon"
                                            className="h-8 w-8"
                                            onClick={() => handleDelete(profile.id, fullName)}
                                            title="Delete"
                                        >
                                            <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </div>
        </AppPage>
    );
}

export default CandidateProfiles;
