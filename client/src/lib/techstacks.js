// =============================================================================
// techstacks — closed enum for the `techstack` column on `job_links`.
// =============================================================================
//
// MUST match the server-side `VALID_TECHSTACKS` list in
// server/routes/jobLinks.js (the SQL CHECK constraint is also
// derived from this set). When adding a stack, update BOTH sides
// (and the migration that updated the CHECK constraint).
// =============================================================================

export const VALID_TECHSTACKS = ['python', 'java', 'dotnet', 'golang', 'nodejs', 'frontend'];

// Human-friendly label for dropdowns / filter chips.
export const TECHSTACK_LABELS = {
    python:   'Python',
    java:     'Java',
    dotnet:   'C# / .NET',
    golang:   'Golang',
    nodejs:   'Node.js',
    frontend: 'Frontend'
};

export function techstackLabel(key) {
    return TECHSTACK_LABELS[key] || key;
}
