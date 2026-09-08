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

// Fix 3: comment merged with itself
content = content.replace(
    /the form\. Keyed by the\/\/ same lowercase slug/,
    "the form.\n// Keyed by the\n// same lowercase slug"
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

// Now handle ALL remaining long lines (over 100 chars) by splitting them
const lines = content.split('\n');
const fixedLines = [];

for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Lines under 150 chars are OK
    if (line.length <= 150) {
        fixedLines.push(line);
        continue;
    }
    
    // Try to intelligently split this long line
    // Split on: }); followed by keywords, ); followed by //, closing arrays/objects
    
    // Pattern 1: '); followed by comment or code
    if (line.includes("');")) {
        const parts = line.split(/'\);(?=\s*(?:\/\/|\/\*\*|const |let |function |if |} ))/);
        if (parts.length > 1) {
            fixedLines.push(...parts.map(p => p.trim()).filter(p => p));
            continue;
        }
    }
    
    // Pattern 2: `); followed by comment or code
    if (line.includes("`);")) {
        const parts = line.split(/`\);(?=\s*(?:\/\/|\/\*\*|const |let |function |if |} ))/);
        if (parts.length > 1) {
            fixedLines.push(...parts.map(p => p.trim()).filter(p => p));
            continue;
        }
    }
    
    // Pattern 3: }); followed by comment or code
    if (line.includes("});")) {
        const parts = line.split(/\}\);(?=\s*(?:\/\/|\/\*\*|const |let |function |if ))/);
        if (parts.length > 1) {
            fixedLines.push(...parts.map(p => p.trim()).filter(p => p));
            continue;
        }
    }
    
    // Pattern 4: ]); followed by comment or code
    if (line.includes("]);")) {
        const parts = line.split(/\]\);(?=\s*(?:\/\/|\/\*\*|const |let |function |if ))/);
        if (parts.length > 1) {
            fixedLines.push(...parts.map(p => p.trim()).filter(p => p));
            continue;
        }
    }
    
    // Pattern 5: For objects and arrays, try splitting on comma-space-keyword
    // e.g., 'python', 'java', etc. followed by another item
    if (line.includes("'python'") && line.includes("'frontend'")) {
        // This is likely PROFILE_TECHSTACKS or PROFILE_TECHSTACK_LABELS
        const parts = line.split(/,\s*(?=')/);
        if (parts.length > 1) {
            fixedLines.push(...parts.map(p => p.trim()).filter(p => p));
            continue;
        }
    }
    
    // If all else fails, keep the line as is
    fixedLines.push(line);
}

content = fixedLines.join('\n');
console.log('After long-line fixes:', content.split('\n').length, 'lines');

// Additional fixes for remaining patterns

// Fix comment block ending followed by code
content = content.replace(
    /the new value\.\n\nconst PROFILE_TECHSTACKS = Object\.freeze\(\[([^\]]+)\]\);/g,
    (match, items) => {
        const formattedItems = items.split(",").map(s => "    " + s.trim()).join(",\n");
        return `the new value.

const PROFILE_TECHSTACKS = Object.freeze([\n${formattedItems}\n]);`;
    }
);

// Fix PROFILE_TECHSTACK_LABELS object
content = content.replace(
    /the DB\.\n\nconst PROFILE_TECHSTACK_LABELS = Object\.freeze\(\{([^}]+)\}\);/g,
    (match, items) => {
        const formattedItems = items.split(",").map(s => "    " + s.trim()).join(",\n");
        return `the DB.

const PROFILE_TECHSTACK_LABELS = Object.freeze({\n${formattedItems}\n});`;
    }
);

// Fix JSDoc + function on same line
content = content.replace(
    /\};\n\n\/\*\*[^}]+\}\n \*\/function/g,
    (match) => {
        return match.replace(/\}\);/g, "});\n\n/**").replace(/ \*\/function/g, "\n */\n\nfunction");
    }
);

// Fix function bodies that got merged
// Pattern: 'function NAME(input) { CODE }'
content = content.replace(
    /function normalizeTechstacks\(input\) \{([^}]+\}[^}]+\})/g,
    (match, body) => {
        // Split on statement boundaries
        const statements = body.split(/(?<=\})\s*(?=\w)/);
        return "function normalizeTechstacks(input) {\n" + 
               statements.map(s => "    " + s.trim()).filter(s => s).join("\n") +
               "\n}";
    }
);

console.log('After all fixes:', content.split('\n').length, 'lines');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
