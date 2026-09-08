import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { userAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { Button } from '@/components/ui/button';
import { UserCircle2, FileText } from 'lucide-react';

function ProfileView() {
    const { id } = useParams();
    const [profile, setProfile] = useState(null);
    const [applications, setApplications] = useState([]);
    const [loading, setLoading] = useState(true);
    const [copiedField, setCopiedField] = useState(null);

    useEffect(() => {
        loadData();
    }, [id]);

    const loadData = async () => {
        try {
            const [profileRes, appsRes] = await Promise.all([
                userAPI.getProfile(id),
                userAPI.getApplications(id)
            ]);
            setProfile(profileRes.data);
            // Backend returns { applications: [...], pagination: {...} };
            // tolerate either shape so a future array response keeps working.
            const appsPayload = appsRes.data;
            setApplications(
                Array.isArray(appsPayload)
                    ? appsPayload
                    : (appsPayload?.applications || [])
            );
        } catch (error) {
            console.error('Failed to load data:', error);
        } finally {
            setLoading(false);
        }
    };

    const copyToClipboard = (text, fieldName) => {
        if (!text || text === '-') return;

        navigator.clipboard.writeText(text).then(() => {
            setCopiedField(fieldName);
            setTimeout(() => setCopiedField(null), 2000);
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    };

    const handleStatusUpdate = async (appId, newStatus) => {
        try {
            await userAPI.updateApplicationStatus(appId, newStatus);
            setApplications(apps =>
                apps.map(app => app.id === appId ? { ...app, status: newStatus } : app)
            );
        } catch (error) {
            alert('Failed to update status');
        }
    };

    const downloadResume = (filename) => {
        window.open(`/resumes/${filename}`, '_blank');
    };

    if (loading) {
        return <PageLoader message="Loading profile..." />;
    }

    if (!profile) {
        return (
            <div className="card">
                <div className="empty-state">
                    <h3>Profile not found</h3>
                    <Link to="/user/profiles" className="btn btn-primary mt-md">Back to profiles</Link>
                </div>
            </div>
        );
    }

    return (
        <AppPage
            icon={UserCircle2}
            title={`${profile.first_name} ${profile.middle_name || ''} ${profile.last_name}`.trim()}
            description="Candidate profile details"
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">
                                {`${profile.first_name} ${profile.middle_name || ''} ${profile.last_name}`.trim()}
                            </p>
                            <p className="truncate text-xs text-white/40">
                                {profile.email || 'Candidate profile'}
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button asChild size="sm" className="h-10" variant="gradient">
                            <Link to={`/user/generate/${profile.id}`}>
                                <FileText className="h-4 w-4" />
                                Generate Resume
                            </Link>
                        </Button>
                    )}
                />

            {/* Profile Details */}
            <div className="card mb-lg">
                <h3 className="card-title mb-md">Personal Information</h3>

                {/* Name Fields */}
                <div className="form-row">
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>First Name</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.first_name || '-'}</p>
                            {profile.first_name && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.first_name, 'first_name')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'first_name' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Middle Name</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.middle_name || '-'}</p>
                            {profile.middle_name && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.middle_name, 'middle_name')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'middle_name' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Last Name</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.last_name || '-'}</p>
                            {profile.last_name && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.last_name, 'last_name')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'last_name' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Contact & Basic Info */}
                <div className="form-row mt-lg">
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Email</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.email || '-'}</p>
                            {profile.email && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.email, 'email')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'email' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Phone</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.phone || '-'}</p>
                            {profile.phone && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.phone, 'phone')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'phone' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Birthdate</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.birthdate || '-'}</p>
                            {profile.birthdate && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.birthdate, 'birthdate')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'birthdate' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Salary Range</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.salary_range || '-'}</p>
                            {profile.salary_range && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.salary_range, 'salary_range')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'salary_range' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Location */}
                <div className="form-row mt-lg">
                    <div style={{ position: 'relative', flex: 1 }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>Location</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{[profile.address, profile.city, profile.state, profile.country, profile.postal_code].filter(Boolean).join(', ') || '-'}</p>
                            {[profile.address, profile.city, profile.state, profile.country, profile.postal_code].filter(Boolean).length > 0 && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard([profile.address, profile.city, profile.state, profile.country, profile.postal_code].filter(Boolean).join(', '), 'location')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'location' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Social Links */}
                <div className="form-row mt-lg">
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>LinkedIn</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.linkedin_url ? <a href={profile.linkedin_url} target="_blank" rel="noopener noreferrer">{profile.linkedin_url}</a> : '-'}</p>
                            {profile.linkedin_url && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.linkedin_url, 'linkedin')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'linkedin' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={{ position: 'relative' }}>
                        <p className="text-muted" style={{ fontSize: '0.875rem' }}>GitHub</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ margin: 0 }}>{profile.github_url ? <a href={profile.github_url} target="_blank" rel="noopener noreferrer">{profile.github_url}</a> : '-'}</p>
                            {profile.github_url && (
                                <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => copyToClipboard(profile.github_url, 'github')}
                                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                    title="Copy to clipboard"
                                >
                                    {copiedField === 'github' ? '✓' : '📋'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Bidder autofill (fixed answers) */}
            <div className="card mb-lg">
                <h3 className="card-title mb-md">Bidder autofill settings</h3>
                <p className="text-muted" style={{ fontSize: '0.875rem', marginBottom: '1rem' }}>
                    Fixed answers used by the Chrome extension. Set by admin/manager on the profile — not AI.
                </p>
                <div className="form-row">
                    {[
                        ['gender', 'Gender'],
                        ['hispanic_latino', 'Hispanic / Latino'],
                        ['work_authorization', 'Work authorization'],
                        ['requires_sponsorship', 'Requires sponsorship'],
                        ['disability_status', 'Disability status'],
                        ['veteran_status', 'Veteran status'],
                        ['race_ethnicity', 'Race / ethnicity'],
                        ['over_18', '18 or older'],
                        ['willing_to_relocate', 'Willing to relocate'],
                        ['willing_to_travel', 'Willing to travel'],
                        ['earliest_start_date', 'Earliest start'],
                        ['notice_period', 'Notice period'],
                        ['how_heard', 'How heard'],
                        ['years_of_experience', 'Years of experience'],
                        ['education_level', 'Education level'],
                        ['school', 'School'],
                        ['degree', 'Degree'],
                        ['discipline', 'Discipline'],
                        ['security_clearance', 'Security clearance'],
                        ['preferred_name', 'Preferred name'],
                        ['website_url', 'Website'],
                        ['portfolio_url', 'Portfolio']
                    ].map(([key, label]) => (
                        <div key={key} style={{ position: 'relative' }}>
                            <p className="text-muted" style={{ fontSize: '0.875rem' }}>{label}</p>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <p style={{ margin: 0 }}>{profile[key] || '-'}</p>
                                {profile[key] && (
                                    <button
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => copyToClipboard(profile[key], key)}
                                        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                                        title="Copy to clipboard"
                                    >
                                        {copiedField === key ? '✓' : '📋'}
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Work Experience */}
            {profile.work_experience && (
                <div className="card mb-lg">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h3 className="card-title" style={{ margin: 0 }}>Work Experience</h3>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => copyToClipboard(profile.work_experience, 'work_experience')}
                            title="Copy to clipboard"
                        >
                            {copiedField === 'work_experience' ? '✓ Copied' : '📋 Copy'}
                        </button>
                    </div>
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--text-secondary)' }}>
                        {profile.work_experience}
                    </pre>
                </div>
            )}

            {/* Education */}
            {profile.education && (
                <div className="card mb-lg">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <h3 className="card-title" style={{ margin: 0 }}>Education</h3>
                        <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => copyToClipboard(profile.education, 'education')}
                            title="Copy to clipboard"
                        >
                            {copiedField === 'education' ? '✓ Copied' : '📋 Copy'}
                        </button>
                    </div>
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--text-secondary)' }}>
                        {profile.education}
                    </pre>
                </div>
            )}

            {/* Job Applications */}
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">Job Applications</h3>
                    <span className="badge badge-user">{applications.length} applications</span>
                </div>

                {applications.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-state-icon">📄</div>
                        <h3>No applications yet</h3>
                        <p>Generate a resume to create your first application</p>
                        <Link to={`/user/generate/${profile.id}`} className="btn btn-primary mt-md">
                            Generate Resume
                        </Link>
                    </div>
                ) : (
                    <div className="table-container">
                        <table className="table">
                            <thead>
                                <tr>
                                    <th>Company</th>
                                    <th>Role</th>
                                    <th>Core Skills</th>
                                    <th>Status</th>
                                    <th>Created</th>
                                    <th>Resume</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {applications.map((app) => {
                                    // Map interview and rejected to "applied" for display
                                    const displayStatus = (app.status === 'interview' || app.status === 'rejected') ? 'applied' : app.status;
                                    const isAdminControlled = app.status === 'interview' || app.status === 'rejected';

                                    return (
                                        <tr key={app.id}>
                                            <td>
                                                <div style={{ minWidth: 0, maxWidth: '16rem' }}>
                                                    {app.job_url ? (
                                                        <a
                                                            href={app.job_url}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            title={app.job_url}
                                                            style={{
                                                                display: 'inline-flex',
                                                                alignItems: 'center',
                                                                gap: '0.25rem',
                                                                fontWeight: 600,
                                                                maxWidth: '100%'
                                                            }}
                                                        >
                                                            <span style={{
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}>
                                                                {app.company_name}
                                                            </span>
                                                            <span aria-hidden="true" style={{ flexShrink: 0, fontSize: '0.75rem' }}>↗</span>
                                                        </a>
                                                    ) : (
                                                        <strong>{app.company_name}</strong>
                                                    )}
                                                    {app.job_url && (
                                                        <div
                                                            title={app.job_url}
                                                            style={{
                                                                marginTop: '0.125rem',
                                                                fontSize: '0.75rem',
                                                                color: 'var(--text-secondary)',
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap'
                                                            }}
                                                        >
                                                            {String(app.job_url).replace(/^https?:\/\//i, '')}
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                            <td>{app.job_role || 'Not Specified'}</td>
                                            <td>
                                                <div style={{ maxWidth: '250px', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                                                    {app.core_skills ? (
                                                        <span title={app.core_skills}>
                                                            {app.core_skills.length > 80
                                                                ? app.core_skills.substring(0, 80) + '...'
                                                                : app.core_skills}
                                                        </span>
                                                    ) : (
                                                        <span style={{ fontStyle: 'italic' }}>Not available</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td>
                                                <span className={`badge badge-${displayStatus}`}>
                                                    {displayStatus}
                                                </span>
                                            </td>
                                            <td>{new Date(app.created_at).toLocaleDateString()}</td>
                                            <td>
                                                <button
                                                    className="btn btn-secondary btn-sm"
                                                    onClick={() => downloadResume(app.resume_filename)}
                                                >
                                                    📥 Download
                                                </button>
                                            </td>
                                            <td>
                                                {/* Only allow status change if not admin-controlled (interview/rejected) */}
                                                {isAdminControlled ? (
                                                    <span className="badge badge-applied">applied</span>
                                                ) : (
                                                    <select
                                                        className="form-select"
                                                        value={app.status}
                                                        onChange={(e) => handleStatusUpdate(app.id, e.target.value)}
                                                        style={{ padding: '0.5rem', minWidth: '120px' }}
                                                    >
                                                        <option value="pending">Pending</option>
                                                        <option value="applied">Applied</option>
                                                    </select>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
            </div>
        </AppPage>
    );
}

export default ProfileView;
