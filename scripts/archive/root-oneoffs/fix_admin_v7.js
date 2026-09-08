const fs = require('fs');

const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('Before:', content.split('\n').length, 'lines');

// Fix: resumesDir followed directly by comment (missing newline)
content = content.replace(
    /const resumesDir = path\.join\(__dirname, '\.\.\/resumes'\)\);// =====+/,
    "const resumesDir = path.join(__dirname, '../resumes');\n\n// ====="
);

// Fix: comment line ending with . followed by more comment then code
// Pattern: "...the new value.const PROFILE_TECHSTACKS"
content = content.replace(
    /the new value\.const PROFILE_TECHSTACKS/,
    "the new value.\n\nconst PROFILE_TECHSTACKS"
);

// Fix: comment line followed by code without newline
// Pattern: "...the DB.const PROFILE_TECHSTACK_LABELS"
content = content.replace(
    /the DB\.const PROFILE_TECHSTACK_LABELS/,
    "the DB.\n\nconst PROFILE_TECHSTACK_LABELS"
);

// Fix: closing brace with }); followed by JSDoc
content = content.replace(
    /frontend: 'Frontend'\n\}\);\n\/\*\* \* Validate/,
    "frontend: 'Frontend'\n};\n\n/**\n * Validate"
);

// Fix: JSDoc followed by function on same line
content = content.replace(
    /\} \*\/function normalizeTechstacks/,
    "}\n */\n\nfunction normalizeTechstacks"
);

console.log('After fixes:', content.split('\n').length, 'lines');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
