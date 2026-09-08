const fs = require('fs');

const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('Before:', content.split('\n').length, 'lines');

// Fix 1: resumesDir line followed by comment (missing newline)
content = content.replace(
    /const resumesDir = path\.join\(__dirname, '\.\.\/resumes'\)\);// ===========================================================================/g,
    `const resumesDir = path.join(__dirname, '../resumes');

// ===========================================================================`
);

// Fix 2: Comment block followed by const (missing newline at end of comment)
content = content.replace(
    /\/\/ tables and this array; until then, the form will silently lack\n\/\/ the new value\.const PROFILE_TECHSTACKS/g,
    `// tables and this array; until then, the form will silently lack
// the new value.

const PROFILE_TECHSTACKS`
);

// Fix 3: Human-friendly labels comment merged with code
content = content.replace(
    /\/\/ Human-friendly labels for the chips on the form\. Keyed by the\n\/\/ same lowercase slug we store in the DB\.const PROFILE_TECHSTACK_LABELS/g,
    `// Human-friendly labels for the chips on the form. Keyed by the
// same lowercase slug we store in the DB.

const PROFILE_TECHSTACK_LABELS`
);

// Fix 4: The closing of PROFILE_TECHSTACK_LABELS object followed by JSDoc
content = content.replace(
    /frontend: 'Frontend'\n\}\);/g,
    `frontend: 'Frontend'
};

// Human-friendly labels for the chips on the form. Keyed by the
// same lowercase slug we store in the DB.
const PROFILE_TECHSTACK_LABELS = Object.freeze({
    python:   'Python',
    java:     'Java',
    dotnet:   'C# / .NET',
    golang:   'Golang',
    nodejs:   'Node.js',
    frontend: 'Frontend'
});

/**`
);

content = content.replace(
    /frontend: 'Frontend'\n\}\);\n\/\*\* \* Validate/g,
    `frontend: 'Frontend'
};

/**
 * Validate`
);

// Fix 5: JSDoc closing followed by function
content = content.replace(
    /\} \*\/function normalizeTechstacks/g,
    `}
 */

/**
 * Validate + normalise the \`techstacks\` payload from a request
 * body. Accepts either an array of strings or a comma-separated
 * string (for form-encoded submits). Returns the deduplicated,
 * order-preserved list of valid values.
 *
 * Bad values throw a structured 400 response — the caller should
 * catch via the validate-and-return helper below.
 */
function normalizeTechstacks`
);

// Fix 6: Normalize all remaining long lines with code and comments mixed
// Pattern: comment ending with . followed by code keyword
content = content.replace(
    /\.\/ profile form and they live in the `profile_techstacks`\/\/ many-to-many table\.\/ We mirror the exact enum used by/g,
    `./ profile form and they live in the \`profile_techstacks\`
// many-to-many table.

// We mirror the exact enum used by`
);

// Fix 7: Code after comment without proper newline
content = content.replace(
    /\/\/ posting for "python" matches a profile that knows Python\. Adding\/\/ a new techstack means updating the CHECK constraint on bothconst PROFILE_TECHSTACKS/g,
    `// posting for "python" matches a profile that knows Python. Adding
// a new techstack means updating the CHECK constraint on both

const PROFILE_TECHSTACKS`
);

// Fix 8: Check for the closing of PROFILE_TECHSTACK_LABELS followed by JSDoc
// Look for the pattern 'Frontend' followed by '});/**'
content = content.replace(
    /frontend: 'Frontend'\n\}\);(?=\/\*\*)/g,
    `frontend: 'Frontend'
};

/**
 * Validate`
);

console.log('After fixes:', content.split('\n').length, 'lines');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
