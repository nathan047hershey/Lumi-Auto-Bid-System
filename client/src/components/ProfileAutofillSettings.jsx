import { SelectField } from '@/components/ui/SelectField';

/** Sentinel for Radix Select (empty string is not a valid item value). */
const UNSET = '__unset__';

/**
 * Defaults aligned with Nathan Hershey–style fixed autofill answers
 * (Simplify / Jobright). Admin can change per profile; extension fills these as-is (not AI).
 * Identity fields (name, race, school) stay empty — fill per candidate.
 */
export const DEFAULT_AUTOFILL_ANSWERS = {
    gender: 'Male',
    work_authorization: 'Yes',
    requires_sponsorship: 'No',
    disability_status: 'No, I do not have a disability',
    veteran_status: 'I am not a protected veteran',
    race_ethnicity: '',
    website_url: '',
    portfolio_url: '',
    preferred_name: '',
    over_18: 'Yes',
    hispanic_latino: 'No',
    willing_to_relocate: 'No',
    willing_to_travel: 'Yes',
    earliest_start_date: '2 weeks',
    notice_period: '2 weeks',
    how_heard: 'LinkedIn',
    years_of_experience: '8',
    education_level: "Bachelor's",
    school: '',
    degree: 'Bachelor of Science in Computer Science',
    discipline: 'Computer Science',
    security_clearance: 'None'
};

/**
 * Copied by “Save to all profiles” / public Autofill Settings.
 * Education + preferred name stay on the full profile editor.
 */
export const SHARED_AUTOFILL_KEYS = [
    'gender',
    'work_authorization',
    'requires_sponsorship',
    'disability_status',
    'veteran_status',
    'hispanic_latino',
    'over_18',
    'willing_to_relocate',
    'willing_to_travel',
    'earliest_start_date',
    'notice_period',
    'how_heard',
    'years_of_experience',
    'security_clearance',
    'race_ethnicity'
];

/** Per-candidate fields — edit on the full profile, not public Autofill Settings. */
export const IDENTITY_AUTOFILL_KEYS = [
    'preferred_name',
    'website_url',
    'portfolio_url',
    'education_level',
    'school',
    'degree',
    'discipline'
];

/** Default tech stacks for new profiles (same set as Nathan Hershey). */
export const DEFAULT_PROFILE_TECHSTACKS = ['dotnet', 'golang', 'java', 'python'];

export const AUTOFILL_GENDER_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: 'Male', label: 'Male (Man)' },
    { value: 'Female', label: 'Female (Woman)' },
    { value: 'Non-binary', label: 'Non-binary' },
    { value: 'Prefer not to say', label: 'Prefer not to say' }
];

export const AUTOFILL_YES_NO_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: 'Yes', label: 'Yes (true)' },
    { value: 'No', label: 'No (false)' }
];

export const AUTOFILL_WORK_AUTH_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: 'Yes', label: 'Yes (true) — authorized' },
    { value: 'No', label: 'No (false) — not authorized' },
    { value: 'Authorized to work in the US', label: 'Authorized to work in the US' },
    { value: 'Citizen', label: 'Citizen' },
    { value: 'Permanent Resident', label: 'Permanent Resident' }
];

export const AUTOFILL_DISABILITY_OPTIONS = [
    { value: 'No, I do not have a disability', label: 'No, I do not have a disability (fixed)' }
];

export const AUTOFILL_VETERAN_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: 'I am not a protected veteran', label: 'I am not a protected veteran' },
    { value: 'I identify as one or more of the classifications of a protected veteran', label: 'I am a protected veteran' },
    { value: 'I do not want to answer', label: 'I do not want to answer' }
];

export const AUTOFILL_EDUCATION_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: "High School", label: 'High School' },
    { value: "Associate's", label: "Associate's" },
    { value: "Bachelor's", label: "Bachelor's" },
    { value: "Master's", label: "Master's" },
    { value: 'Doctorate', label: 'Doctorate / PhD' },
    { value: 'Other', label: 'Other' }
];

export const AUTOFILL_CLEARANCE_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: 'None', label: 'None' },
    { value: 'Confidential', label: 'Confidential' },
    { value: 'Secret', label: 'Secret' },
    { value: 'Top Secret', label: 'Top Secret' }
];

export const AUTOFILL_HOW_HEARD_OPTIONS = [
    { value: UNSET, label: 'Not set' },
    { value: 'LinkedIn', label: 'LinkedIn' },
    { value: 'Company website', label: 'Company website' },
    { value: 'Indeed', label: 'Indeed' },
    { value: 'Referral', label: 'Referral' },
    { value: 'Other', label: 'Other' }
];

function toSelectValue(raw) {
    const v = String(raw || '').trim();
    return v || UNSET;
}

function fromSelectValue(v) {
    return v === UNSET ? '' : v;
}

function FieldSelect({ label, name, formData, setFormData, options, placeholder }) {
    const withCustom = (() => {
        const v = String(formData[name] || '').trim();
        if (!v || options.some((o) => o.value === v)) return options;
        return [...options, { value: v, label: `${v} (custom)` }];
    })();
    return (
        <div className="form-group">
            <label className="form-label">{label}</label>
            <SelectField
                value={toSelectValue(formData[name])}
                onChange={(v) => setFormData((prev) => ({ ...prev, [name]: fromSelectValue(v) }))}
                options={withCustom}
                placeholder={placeholder}
            />
        </div>
    );
}

function FieldText({ label, name, formData, handleChange, placeholder }) {
    return (
        <div className="form-group">
            <label className="form-label">{label}</label>
            <input
                type="text"
                name={name}
                className="form-input"
                value={formData[name] || ''}
                onChange={handleChange}
                placeholder={placeholder}
            />
        </div>
    );
}

function Section({ title, hint, children }) {
    return (
        <div style={{ marginTop: '1.25rem' }}>
            <h4 style={{ margin: '0 0 0.35rem', fontSize: '0.95rem' }}>{title}</h4>
            {hint && (
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>{hint}</p>
            )}
            <div className="grid grid-2 gap-md">{children}</div>
        </div>
    );
}

/**
 * Fixed autofill answers on admin/manager candidate profiles.
 * Modeled after Simplify (Personal Info + Preferences) and Jobright EEO/logistics.
 */
export default function ProfileAutofillSettings({
    formData,
    setFormData,
    handleChange,
    showApplyDefaults = true,
    embedded = false,
    /** When true, only EEO / work auth / logistics (public, same for all profiles). */
    publicOnly = false
}) {
    const applyDefaults = () => {
        setFormData((prev) => {
            const next = {
                ...prev,
                ...DEFAULT_AUTOFILL_ANSWERS,
                techstacks: (Array.isArray(prev.techstacks) && prev.techstacks.length)
                    ? prev.techstacks
                    : [...DEFAULT_PROFILE_TECHSTACKS]
            };
            if (publicOnly) {
                for (const key of IDENTITY_AUTOFILL_KEYS) {
                    next[key] = prev[key] ?? DEFAULT_AUTOFILL_ANSWERS[key] ?? '';
                }
            }
            return next;
        });
    };

    return (
        <div
            id="bidder-autofill-settings"
            className={embedded ? 'mb-0' : 'card mb-lg'}
            style={embedded ? {
                padding: '0.25rem 0 0',
                border: 'none',
                background: 'transparent'
            } : {
                padding: '1.25rem',
                border: '1px solid var(--border, #e5e7eb)',
                background: 'var(--card, #fafafa)'
            }}
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                <div>
                    <h3 className="mb-sm" style={{ marginTop: 0 }}>
                        {publicOnly ? 'Public autofill answers' : 'Autofill defaults (fixed answers)'}
                    </h3>
                    <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: 0, maxWidth: '40rem' }}>
                        {publicOnly
                            ? 'Same for every profile — gender, visa, work auth, logistics. Education and preferred name are edited on each full profile.'
                            : 'Fixed answers on the profile. Extension autofills them — not AI.'}
                    </p>
                </div>
                {showApplyDefaults && (
                    <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={applyDefaults}
                    >
                        Apply recommended defaults
                    </button>
                )}
            </div>

            <Section title="EEO / demographics" hint="Voluntary disclosures — gender, race, disability, veteran.">
                <FieldSelect label="Gender" name="gender" formData={formData} setFormData={setFormData} options={AUTOFILL_GENDER_OPTIONS} placeholder="Male (Man)" />
                <FieldSelect label="Hispanic / Latino?" name="hispanic_latino" formData={formData} setFormData={setFormData} options={AUTOFILL_YES_NO_OPTIONS} placeholder="Yes / No" />
                <FieldText label="Race / ethnicity" name="race_ethnicity" formData={formData} handleChange={handleChange} placeholder="Optional — match form wording" />
                <FieldSelect label="Disability status (fixed: No)" name="disability_status" formData={formData} setFormData={setFormData} options={AUTOFILL_DISABILITY_OPTIONS} placeholder="No" />
                <FieldSelect label="Veteran status" name="veteran_status" formData={formData} setFormData={setFormData} options={AUTOFILL_VETERAN_OPTIONS} placeholder="Veteran" />
            </Section>

            <Section title="Work eligibility" hint="Work auth + visa sponsorship (always review before submit).">
                <FieldSelect label="Work authorization (true/false)" name="work_authorization" formData={formData} setFormData={setFormData} options={AUTOFILL_WORK_AUTH_OPTIONS} placeholder="Yes (true)" />
                <FieldText label="Work auth custom text" name="work_authorization" formData={formData} handleChange={handleChange} placeholder="e.g. Authorized to work in the US" />
                <FieldSelect label="Visa sponsorship required?" name="requires_sponsorship" formData={formData} setFormData={setFormData} options={AUTOFILL_YES_NO_OPTIONS} placeholder="No (false)" />
                <FieldSelect label="Are you 18 or older?" name="over_18" formData={formData} setFormData={setFormData} options={AUTOFILL_YES_NO_OPTIONS} placeholder="Yes" />
                <FieldSelect label="Security clearance" name="security_clearance" formData={formData} setFormData={setFormData} options={AUTOFILL_CLEARANCE_OPTIONS} placeholder="None" />
            </Section>

            <Section title="Logistics" hint="Start date, relocate, travel — common ATS fixed questions.">
                <FieldSelect label="Willing to relocate?" name="willing_to_relocate" formData={formData} setFormData={setFormData} options={AUTOFILL_YES_NO_OPTIONS} placeholder="No" />
                <FieldSelect label="Willing to travel?" name="willing_to_travel" formData={formData} setFormData={setFormData} options={AUTOFILL_YES_NO_OPTIONS} placeholder="Yes" />
                <FieldText label="Earliest start date" name="earliest_start_date" formData={formData} handleChange={handleChange} placeholder="e.g. 2 weeks / Immediately" />
                <FieldText label="Notice period" name="notice_period" formData={formData} handleChange={handleChange} placeholder="e.g. 2 weeks" />
                <FieldSelect label="How did you hear about us?" name="how_heard" formData={formData} setFormData={setFormData} options={AUTOFILL_HOW_HEARD_OPTIONS} placeholder="LinkedIn" />
                <FieldText label="Years of experience" name="years_of_experience" formData={formData} handleChange={handleChange} placeholder="e.g. 8" />
            </Section>

            {!publicOnly ? (
                <>
                    <Section title="Education" hint="Highest level, school, degree, and major.">
                        <FieldSelect label="Highest education" name="education_level" formData={formData} setFormData={setFormData} options={AUTOFILL_EDUCATION_OPTIONS} placeholder="Bachelor's" />
                        <FieldText label="School / University" name="school" formData={formData} handleChange={handleChange} placeholder="e.g. University of Washington" />
                        <FieldText label="Degree" name="degree" formData={formData} handleChange={handleChange} placeholder="e.g. Bachelor of Science" />
                        <FieldText label="Discipline / Major" name="discipline" formData={formData} handleChange={handleChange} placeholder="e.g. Computer Science" />
                    </Section>

                    <Section title="Links & preferred name" hint="Extra profile links beyond LinkedIn/GitHub (already on contact section).">
                        <FieldText label="Preferred name" name="preferred_name" formData={formData} handleChange={handleChange} placeholder="If different from legal first name" />
                        <FieldText label="Website" name="website_url" formData={formData} handleChange={handleChange} placeholder="https://…" />
                        <FieldText label="Portfolio URL" name="portfolio_url" formData={formData} handleChange={handleChange} placeholder="https://…" />
                    </Section>
                </>
            ) : null}
        </div>
    );
}
