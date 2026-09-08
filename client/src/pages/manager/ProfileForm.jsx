import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { managerAPI } from '../../api';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { PageLoader } from '@/components/Loader';
import { UserPlus, ArrowLeft, User, Briefcase, FileText } from 'lucide-react';
import { DatePicker } from '@/components/DatePicker';
import { DEFAULT_AUTOFILL_ANSWERS } from '@/components/ProfileAutofillSettings';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function ManagerProfileForm() {
    const { id } = useParams();
    const navigate = useNavigate();
    const isEdit = !!id;

    const [loading, setLoading] = useState(isEdit);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [activeTab, setActiveTab] = useState('personal');

    const [formData, setFormData] = useState({
        first_name: '',
        last_name: '',
        middle_name: '',
        birthdate: '',
        phone: '',
        email: '',
        linkedin_url: '',
        github_url: '',
        address: '',
        city: '',
        state: '',
        country: '',
        postal_code: '',
        salary_range: '',
        work_experience: '',
        education: '',
        resume_prompt: '',
        ...DEFAULT_AUTOFILL_ANSWERS
    });

    useEffect(() => {
        if (isEdit) {
            loadProfile();
        }
    }, [id]);

    const loadProfile = async () => {
        try {
            const response = await managerAPI.getProfile(id);
            setFormData(response.data);
        } catch (error) {
            console.error('Failed to load profile:', error);
            navigate('/manager/dashboard');
        } finally {
            setLoading(false);
        }
    };

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData((prev) => ({ ...prev, [name]: value }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSubmitting(true);

        try {
            if (isEdit) {
                await managerAPI.updateProfile(id, formData);
            } else {
                await managerAPI.createProfile(formData);
            }
            navigate('/manager/dashboard');
        } catch (error) {
            setError(error.response?.data?.error || 'Failed to save profile');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) {
        return <PageLoader message={isEdit ? 'Loading profile...' : 'Preparing form...'} />;
    }

    return (
        <AppPage
            icon={UserPlus}
            title={isEdit ? 'Edit Profile' : 'Create Profile'}
            description={isEdit ? 'Update candidate profile information' : 'Add a new candidate profile'}
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">
                                {isEdit ? 'Edit candidate profile' : 'New candidate profile'}
                            </p>
                            <p className="truncate text-xs text-white/40">
                                Personal details, experience, and resume prompt
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" asChild>
                            <Link to="/manager/profiles">
                                <ArrowLeft className="h-4 w-4" />
                                <span className="hidden sm:inline">Back</span>
                            </Link>
                        </Button>
                    )}
                />
            <div className="card">
                {error && <div className="alert alert-error">{error}</div>}

                <form onSubmit={handleSubmit}>
                    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                        <TabsList className="mb-4 flex h-auto w-full flex-wrap justify-start gap-1">
                            <TabsTrigger value="personal" className="gap-1.5 text-xs sm:text-sm">
                                <User className="h-3.5 w-3.5" />
                                Personal
                            </TabsTrigger>
                            <TabsTrigger value="experience" className="gap-1.5 text-xs sm:text-sm">
                                <Briefcase className="h-3.5 w-3.5" />
                                Experience
                            </TabsTrigger>
                            <TabsTrigger value="resume" className="gap-1.5 text-xs sm:text-sm">
                                <FileText className="h-3.5 w-3.5" />
                                Resume
                            </TabsTrigger>
                        </TabsList>

                        <TabsContent value="personal" forceMount className="profile-form-dense mt-0 data-[state=inactive]:hidden">
                            <div className="profile-dense-grid">
                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">First Name *</label>
                                    <input
                                        type="text"
                                        name="first_name"
                                        className="form-input"
                                        value={formData.first_name}
                                        onChange={handleChange}
                                        required
                                    />
                                </div>
                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">Middle Name</label>
                                    <input
                                        type="text"
                                        name="middle_name"
                                        className="form-input"
                                        value={formData.middle_name || ''}
                                        onChange={handleChange}
                                    />
                                </div>
                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">Last Name *</label>
                                    <input
                                        type="text"
                                        name="last_name"
                                        className="form-input"
                                        value={formData.last_name}
                                        onChange={handleChange}
                                        required
                                    />
                                </div>

                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">Birthdate</label>
                                    <DatePicker
                                        name="birthdate"
                                        className="form-input"
                                        value={formData.birthdate || ''}
                                        onChange={handleChange}
                                        placeholder="Select birthdate"
                                    />
                                </div>
                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">Phone</label>
                                    <input
                                        type="tel"
                                        name="phone"
                                        className="form-input"
                                        value={formData.phone || ''}
                                        onChange={handleChange}
                                        placeholder="+1 234 567 8900"
                                    />
                                </div>
                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">Email</label>
                                    <input
                                        type="email"
                                        name="email"
                                        className="form-input"
                                        value={formData.email || ''}
                                        onChange={handleChange}
                                        placeholder="email@example.com"
                                    />
                                </div>

                                <hr className="profile-dense-divider" />

                                <div className="form-group profile-dense-span-3">
                                    <label className="form-label">LinkedIn</label>
                                    <input
                                        type="url"
                                        name="linkedin_url"
                                        className="form-input"
                                        value={formData.linkedin_url || ''}
                                        onChange={handleChange}
                                        placeholder="https://linkedin.com/in/…"
                                    />
                                </div>
                                <div className="form-group profile-dense-span-3">
                                    <label className="form-label">GitHub</label>
                                    <input
                                        type="url"
                                        name="github_url"
                                        className="form-input"
                                        value={formData.github_url || ''}
                                        onChange={handleChange}
                                        placeholder="https://github.com/…"
                                    />
                                </div>

                                <hr className="profile-dense-divider" />

                                <div className="form-group profile-dense-span-6">
                                    <label className="form-label">Street Address</label>
                                    <input
                                        type="text"
                                        name="address"
                                        className="form-input"
                                        value={formData.address || ''}
                                        onChange={handleChange}
                                        placeholder="123 Main Street"
                                    />
                                </div>
                                <div className="form-group profile-dense-span-2 profile-dense-mobile-1">
                                    <label className="form-label">City</label>
                                    <input
                                        type="text"
                                        name="city"
                                        className="form-input"
                                        value={formData.city || ''}
                                        onChange={handleChange}
                                    />
                                </div>
                                <div className="form-group profile-dense-span-1 profile-dense-mobile-1">
                                    <label className="form-label">State</label>
                                    <input
                                        type="text"
                                        name="state"
                                        className="form-input"
                                        value={formData.state || ''}
                                        onChange={handleChange}
                                    />
                                </div>
                                <div className="form-group profile-dense-span-1 profile-dense-mobile-1">
                                    <label className="form-label">Country</label>
                                    <input
                                        type="text"
                                        name="country"
                                        className="form-input"
                                        value={formData.country || ''}
                                        onChange={handleChange}
                                    />
                                </div>
                                <div className="form-group profile-dense-span-2 profile-dense-mobile-1">
                                    <label className="form-label">Postal</label>
                                    <input
                                        type="text"
                                        name="postal_code"
                                        className="form-input"
                                        value={formData.postal_code || ''}
                                        onChange={handleChange}
                                    />
                                </div>

                                <div className="form-group profile-dense-span-2">
                                    <label className="form-label">Expected Salary</label>
                                    <input
                                        type="text"
                                        name="salary_range"
                                        className="form-input"
                                        value={formData.salary_range || ''}
                                        onChange={handleChange}
                                        placeholder="$80,000 - $100,000"
                                    />
                                </div>
                            </div>
                        </TabsContent>

                        <TabsContent value="experience" forceMount className="profile-form-dense mt-0 space-y-3 data-[state=inactive]:hidden">
                            <div className="form-group">
                                <label className="form-label">Work Experience</label>
                                <textarea
                                    name="work_experience"
                                    className="form-textarea"
                                    value={formData.work_experience || ''}
                                    onChange={handleChange}
                                    placeholder="Enter work experience details. Include job titles, companies, dates, and responsibilities."
                                    rows={6}
                                />
                            </div>
                            <div className="form-group mb-0">
                                <label className="form-label">Education</label>
                                <textarea
                                    name="education"
                                    className="form-textarea"
                                    value={formData.education || ''}
                                    onChange={handleChange}
                                    placeholder="Enter education details. Include degrees, institutions, graduation dates."
                                    rows={4}
                                />
                            </div>
                        </TabsContent>

                        <TabsContent value="resume" forceMount className="profile-form-dense mt-0 space-y-3 data-[state=inactive]:hidden">
                            <div className="form-group mb-0">
                                <label className="form-label">Resume Generation Prompt</label>
                                <textarea
                                    name="resume_prompt"
                                    className="form-textarea"
                                    value={formData.resume_prompt || ''}
                                    onChange={handleChange}
                                    placeholder="Enter instructions for AI resume generation…"
                                    rows={8}
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Used with the job description to generate tailored resumes.
                                </p>
                            </div>
                        </TabsContent>
                    </Tabs>

                    <div className="mt-lg flex gap-md border-t border-border/60 pt-4">
                        <button type="submit" className="btn btn-primary" disabled={submitting}>
                            {submitting ? 'Saving...' : (isEdit ? 'Update Profile' : 'Create Profile')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => navigate('/manager/dashboard')}
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            </div>
            </div>
        </AppPage>
    );
}

export default ManagerProfileForm;