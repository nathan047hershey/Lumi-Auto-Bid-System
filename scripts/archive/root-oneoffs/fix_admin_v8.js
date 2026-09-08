const fs = require('fs');

const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('Before:', content.split('\n').length, 'lines');

// Fix 1: resumesDir followed directly by comment
content = content.replace(
    /const resumesDir = path\.join\(__dirname, '\.\.\/resumes'\)\);/,
    "const resumesDir = path.join(__dirname, '../resumes');\n\n// ====="
);

// Fix 2: comment ending with . followed by const
content = content.replace(
    /the new value\.const PROFILE_TECHSTACKS/,
    "the new value.\n\nconst PROFILE_TECHSTACKS"
);

// Fix 3: comment followed by const
content = content.replace(
    /the DB\.const PROFILE_TECHSTACK_LABELS/,
    "the DB.\n\nconst PROFILE_TECHSTACK_LABELS"
);

// Fix 4: closing }); followed by JSDoc without newline
content = content.replace(
    /frontend: 'Frontend'\n\}\);\n\/\*\* \* Validate/,
    "frontend: 'Frontend'\n};\n\n/**\n * Validate"
);

// Fix 5: JSDoc closing */ followed by function without newline
content = content.replace(
    /\} \*\/function normalizeTechstacks/,
    "}\n */\n\nfunction normalizeTechstacks"
);

console.log('After fixes:', content.split('\n').length, 'lines');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
