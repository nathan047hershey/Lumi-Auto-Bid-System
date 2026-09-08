import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { adminAPI } from '../../api';
import { PageLoader } from '@/components/Loader';
import AppPage from '@/components/AppPage';
import PageCommandBar from '@/components/PageCommandBar';
import { UserPlus, ArrowLeft, User, Briefcase, FileText } from 'lucide-react';
import { DatePicker } from '@/components/DatePicker';
import { Badge } from '@/components/ui/badge';
import { SelectField } from '@/components/ui/SelectField';
import { LOCATION_FLAGS } from '@/lib/locationFlags';
import { DEFAULT_AUTOFILL_ANSWERS, DEFAULT_PROFILE_TECHSTACKS } from '@/components/ProfileAutofillSettings';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Closed enum of techstack slugs the form exposes. These match the
// server-side `PROFILE_TECHSTACKS` array in routes/admin.js and
// `VALID_TECHSTACKS` in routes/jobLinks.js, so a profile's tech
// stack lines up directly with the job_links filter dropdown.
const PROFILE_TECHSTACKS = [
    { value: 'python',   label: 'Python' },
    { value: 'java',     label: 'Java' },
    { value: 'dotnet',   label: 'C# / .NET' },
    { value: 'golang',   label: 'Golang' },
    { value: 'nodejs',   label: 'Node.js' },
    { value: 'frontend', label: 'Frontend' }
];

// Closed enum of region flags the form exposes. Mirrors
// `LOCATION_FLAGS` from server/config/database.js so the form
// can never submit a value the server would reject. The
// `SelectField` below uses these verbatim — keep them in sync
// if the enum grows.
// (Imported from @/lib/locationFlags; the local alias is kept
// here for readability inside this file.)

// Toggle a techstack slug in/out of the selected array. We
// preserve order so the chips render in the order they're added,
// which matches the user's mental model of "what did I add
// most recently". The server normalises and de-duplicates on
// POST/PUT so we don't worry about exact-match duplicates here.
function formatExperiencePlain(raw) {
    if (raw == null || raw === '') return '';
    if (Array.isArray(raw)) {
        return raw.map((job) => {
            if (typeof job === 'string') return job.trim();
            const title = job.title || job.role || '';
            const company = job.company || job.employer || '';
            const years = job.years || job.dates || job.date_range || '';
            const loc = job.location || '';
            const desc = job.description || '';
            if (title && company) {
                return `${title} at ${company}${years ? ` in ${years}` : ''}${loc ? ` ${loc}` : ''}${desc && !loc ? ` ${desc}` : ''}`.trim();
            }
            return [title, company, years, loc, desc].filter(Boolean).join(' — ');
        }).filter(Boolean).join('\n');
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return formatExperiencePlain(parsed);
            } catch {
                /* keep as plain text */
            }
        }
        return raw;
    }
    return String(raw);
}

function formatEducationPlain(raw) {
    if (raw == null || raw === '') return '';
    if (Array.isArray(raw)) {
        return raw.map((ed) => {
            if (typeof ed === 'string') return ed.trim();
            const degree = ed.degree || ed.program || '';
            const field = ed.field || ed.major || '';
            const school = ed.school || ed.institution || ed.university || '';
            const years = ed.years || ed.dates || ed.date_range || '';
            if (degree && field && school) {
                return `${degree} in ${field} at ${school}${years ? ` in ${years}` : ''}`.trim();
            }
            if (degree && school) {
                return `${degree} at ${school}${years ? ` in ${years}` : ''}`.trim();
            }
            return [degree, field, school, years].filter(Boolean).join(' — ');
        }).filter(Boolean).join('\n');
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return formatEducationPlain(parsed);
            } catch {
                /* keep as plain text */
            }
        }
        return raw;
    }
    return String(raw);
}

const toggleTechstack = (list, value) => {
    if (list.includes(value)) {
        return list.filter((v) => v !== value);
    }
    return [...list, value];
};

function ProfileForm() {
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
        // Plain-text lines (one job / degree per line), matching the
        // classic profile editor. Example:
        //   Staff Software Engineer at YouTube in 02/2025 - Present Remote
        //   B.S. Honors degrees in Computer Science at Virginia Tech in 2004 - 2007
        work_experience: '',
        education: '',
        resume_prompt: '',
        // Array of techstack slugs (e.g. ['python', 'dotnet']).
        // Stored on the profile via the
        // `profile_techstacks` join table; the server replaces
        // the entire set on every save (PUT semantics).
        // New profiles start with Nathan-style default stacks.
        techstacks: [...DEFAULT_PROFILE_TECHSTACKS],
        // Resume template preference. null / "" / 0 means "use the
        // system default template" — the generation route interprets
        // a missing value exactly that way, so we keep null on the
        // wire too. Stored as a string in form state to play nicely
        // with the <Select value="" /> convention used elsewhere in
        // this codebase; we coerce to a number-or-null right before
        // sending the request. The matching `preferred_template_kind`
        // is 'admin' for resume_templates (DOCX) or 'user' for
        // user_resume_templates (drag-drop) — null id forces kind
        // back to 'admin' on submit.
        preferred_template_id: null,
        preferred_template_kind: 'admin',
        // Coarse region flag. Defaults to 'US' so a brand-new
        // profile lands in the same region as the rest of the
        // default-template candidates. The SelectField below
        // mirrors the closed enum from server
        // `LOCATION_FLAGS` so the form can never send a typo'd
        // value.
        location_flag: 'US',
        // Default fixed autofill answers for new profiles (admin can change).
        ...DEFAULT_AUTOFILL_ANSWERS
    });

    // Two parallel lists for the dropdown. `templates` is the
    // admin-uploaded DOCX library (resume_templates). `userTemplates`
    // is the cross-user drag-drop library (user_resume_templates).
    // The dropdown renders them as two optgroups so the admin can
    // pick either kind for this profile.
    const [templates, setTemplates] = useState([]);
    const [userTemplates, setUserTemplates] = useState([]);
    const [templatesLoading, setTemplatesLoading] = useState(false);

    useEffect(() => {
        if (isEdit) {
            loadProfile();
        }
        loadTemplates();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]);

    useEffect(() => {
        if (loading || !isEdit || !id) return;
        if (typeof window === 'undefined') return;
        if (window.location.hash !== '#bidder-autofill-settings') return;
        navigate(`/admin/autofill-settings?profile=${id}`, { replace: true });
    }, [loading, isEdit, id, navigate]);

    const loadProfile = async () => {
        try {
            const response = await adminAPI.getProfile(id);
            // The server returns `techstacks`, `preferred_template_id`,
            // and `preferred_template_kind` on every profile. Fall
            // back to safe defaults for older rows that pre-date
            // these columns.
            const data = response.data || {};
            if (!Array.isArray(data.techstacks)) data.techstacks = [];
            else data.techstacks = data.techstacks.filter((s) => typeof s === 'string');
            // Coerce numeric IDs to strings so <Select value=...> is
            // happy; we coerce back to a number on submit.
            if (data.preferred_template_id != null) {
                data.preferred_template_id = String(data.preferred_template_id);
            }
            if (data.preferred_template_kind != null) {
                data.preferred_template_kind = data.preferred_template_kind;
            } else {
                data.preferred_template_kind = 'admin';
            }
            // Legacy rows pre-date the column — default to 'US' so
            // the form stays consistent with the server default.
            if (!data.location_flag || !LOCATION_FLAGS.includes(data.location_flag)) {
                data.location_flag = 'US';
            }
            // Plain text (one line per job/degree). If the DB still has
            // legacy JSON arrays, convert them to readable lines.
            data.work_experience = formatExperiencePlain(data.work_experience);
            data.education = formatEducationPlain(data.education);
            setFormData((prev) => ({ ...prev, ...data }));
        } catch (error) {
            console.error('Failed to load profile:', error);
            navigate('/admin/profiles');
        } finally {
            setLoading(false);
        }
    };

    const loadTemplates = async () => {
        try {
            setTemplatesLoading(true);
            // Fire both requests in parallel. The admin-uploaded
            // DOCX templates (resume_templates) and the cross-user
            // drag-drop library (user_resume_templates) live in
            // different tables; we need both lists to render the
            // dropdown's two optgroups.
            const [adminRes, userRes] = await Promise.all([
                adminAPI.listTemplates(),
                adminAPI.listUserTemplates().catch((err) => {
                    // Drag-drop library is optional — fall back to
                    // an empty list so the dropdown still renders
                    // just the admin-uploaded templates.
                    console.warn('Failed to load user templates:', err);
                    return { data: { templates: [] } };
                })
            ]);
            const adminList = adminRes?.data?.templates || adminRes?.templates || [];
            const userList = userRes?.data?.templates || userRes?.templates || [];
            setTemplates(Array.isArray(adminList) ? adminList : []);
            setUserTemplates(Array.isArray(userList) ? userList : []);
        } catch (error) {
            // Non-fatal — the form can still be used if the templates
            // list isn't available. Templates won't appear in the
            // dropdown until the admin reloads.
            console.error('Failed to load resume templates:', error);
        } finally {
            setTemplatesLoading(false);
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

        // Build the payload explicitly so we control which fields
        // leave the form. `preferred_template_id` lives in form
        // state as a string (to play nicely with <Select value>),
        // but the server expects either a positive integer or
        // null. Coerce here once. We also send
        // `preferred_template_kind` ('admin' | 'user') so the
        // server knows which table the id points at — without
        // it the resolver can't disambiguate between a DOCX
        // template id and a drag-drop template id.
        const rawId = formData.preferred_template_id;
        let preferredTemplateId = null;
        if (rawId !== '' && rawId !== null && rawId !== undefined) {
            const n = parseInt(rawId, 10);
            if (Number.isFinite(n) && n > 0) preferredTemplateId = n;
        }
        // Always send kind so legacy clients that omit it don't
        // get the wrong default. The server defaults to 'admin'
        // when missing, which matches our form default.
        const preferredTemplateKind = (formData.preferred_template_kind === 'user') ? 'user' : 'admin';
        // location_flag must be one of LOCATION_FLAGS. Fall back
        // to 'US' so a stale form (e.g. before the column was
        // added) still sends a valid value.
        const locationFlag = LOCATION_FLAGS.includes(formData.location_flag)
            ? formData.location_flag
            : 'US';
        const payload = {
            ...formData,
            preferred_template_id: preferredTemplateId,
            preferred_template_kind: preferredTemplateKind,
            location_flag: locationFlag,
            work_experience: formData.work_experience || '',
            education: formData.education || ''
        };

        try {
            if (isEdit) {
                await adminAPI.updateProfile(id, payload);
            } else {
                await adminAPI.createProfile(payload);
            }
            navigate('/admin/profiles');
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
            description={isEdit ? 'Update candidate profile details' : 'Add a new candidate profile'}
        >
            <div className="space-y-4">
                <PageCommandBar
                    search={(
                        <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-white/80">
                                {isEdit ? 'Edit candidate profile' : 'New candidate profile'}
                            </p>
                            <p className="truncate text-xs text-white/40">
                                Identity, experience, and resume settings
                            </p>
                        </div>
                    )}
                    actions={(
                        <Button variant="outline" size="sm" className="h-10" asChild>
                            <Link to="/admin/profiles">
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
                                <div className="form-group profile-dense-span-1 profile-dense-mobile-1">
                                    <label className="form-label">Postal</label>
                                    <input
                                        type="text"
                                        name="postal_code"
                                        className="form-input"
                                        value={formData.postal_code || ''}
                                        onChange={handleChange}
                                    />
                                </div>
                                <div className="form-group profile-dense-span-1 profile-dense-mobile-1">
                                    <label className="form-label">Region</label>
                                    <SelectField
                                        value={formData.location_flag || 'US'}
                                        onChange={(v) => setFormData((prev) => ({
                                            ...prev,
                                            location_flag: v
                                        }))}
                                        options={LOCATION_FLAGS.map((flag) => ({
                                            value: flag,
                                            label: flag
                                        }))}
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
                                    placeholder={`One job per line, e.g.\nStaff Software Engineer at YouTube in 02/2025 - Present Remote`}
                                    rows={8}
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Format: <code>Title at Company in MM/YYYY - MM/YYYY|Present Location</code>
                                </p>
                            </div>
                            <div className="form-group mb-0">
                                <label className="form-label">Education</label>
                                <textarea
                                    name="education"
                                    className="form-textarea"
                                    value={formData.education || ''}
                                    onChange={handleChange}
                                    placeholder={`One entry per line, e.g.\nB.S. Honors degrees in Computer Science at Virginia Tech in 2004 - 2007`}
                                    rows={4}
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Format: <code>Degree in Field at School in YYYY - YYYY</code>
                                </p>
                            </div>
                        </TabsContent>

                        <TabsContent value="resume" forceMount className="profile-form-dense mt-0 space-y-3 data-[state=inactive]:hidden">
                            <div className="form-group">
                                <label className="form-label">Technical Stacks</label>
                                <div className="mb-sm flex flex-wrap gap-2">
                                    {PROFILE_TECHSTACKS.map((t) => {
                                        const selected = Array.isArray(formData.techstacks)
                                            && formData.techstacks.includes(t.value);
                                        return (
                                            <button
                                                key={t.value}
                                                type="button"
                                                onClick={() => setFormData((prev) => ({
                                                    ...prev,
                                                    techstacks: toggleTechstack(
                                                        Array.isArray(prev.techstacks) ? prev.techstacks : [],
                                                        t.value
                                                    )
                                                }))}
                                                aria-pressed={selected}
                                                className={
                                                    'inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium transition-colors ' +
                                                    (selected
                                                        ? 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'
                                                        : 'border-input bg-background hover:bg-accent hover:text-accent-foreground')
                                                }
                                            >
                                                {selected && <span aria-hidden="true" className="mr-1">✓</span>}
                                                {t.label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    Used to match this profile against open job links. New profiles default to C# / .NET, Golang, Java, and Python.
                                </p>
                                {Array.isArray(formData.techstacks) && formData.techstacks.length > 0 && (
                                    <div className="mt-sm flex flex-wrap gap-1">
                                        {formData.techstacks.map((slug) => {
                                            const def = PROFILE_TECHSTACKS.find((x) => x.value === slug);
                                            return (
                                                <Badge key={slug} variant="secondary" className="font-medium">
                                                    {def ? def.label : slug}
                                                </Badge>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <div className="form-group">
                                <label className="form-label">Preferred Resume Template</label>
                                <SelectField
                                    value={
                                        formData.preferred_template_id == null
                                            ? ''
                                            : `${formData.preferred_template_kind || 'admin'}:${formData.preferred_template_id}`
                                    }
                                    onChange={(v) => {
                                        const meta = String(v).match(/^(admin|user):(\d+)$/);
                                        if (meta) {
                                            setFormData((prev) => ({
                                                ...prev,
                                                preferred_template_id: meta[2],
                                                preferred_template_kind: meta[1]
                                            }));
                                        } else {
                                            setFormData((prev) => ({
                                                ...prev,
                                                preferred_template_id: null,
                                                preferred_template_kind: 'admin'
                                            }));
                                        }
                                    }}
                                    groups={[
                                        {
                                            label: 'System',
                                            options: [
                                                { value: '', label: 'System default (no preference)' }
                                            ]
                                        },
                                        {
                                            label: `Admin-uploaded templates (${(templates || []).length})`,
                                            options: (templates || []).map((t) => ({
                                                value: `admin:${t.id}`,
                                                label: t.is_default
                                                    ? `${t.name} (default)`
                                                    : t.name
                                            }))
                                        },
                                        {
                                            label: `Team drag-drop templates (${(userTemplates || []).length})`,
                                            options: (userTemplates || []).map((t) => ({
                                                value: `user:${t.id}`,
                                                label: t.is_default
                                                    ? `${t.name} (${t.owner_username || 'Team'} · default)`
                                                    : `${t.name} (${t.owner_username || 'Team'})`
                                            }))
                                        }
                                    ]}
                                    placeholder={
                                        templatesLoading
                                            ? 'Loading templates…'
                                            : 'Pick a template'
                                    }
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Used when this profile's resume is generated. Leave on System default to use the built-in template.
                                </p>
                            </div>

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
                            onClick={() => navigate('/admin/profiles')}
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

export default ProfileForm;
