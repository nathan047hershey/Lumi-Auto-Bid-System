const fs = require('fs');

// Read the corrupted file
const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size before fix:', content.length, 'bytes');
console.log('Number of lines before:', content.split('\n').length);

// The file has literal backslash-n (2 chars: \ and n) instead of real newlines
// We need to split on the literal \n pattern and rejoin with real newlines

// Strategy: Find where real code structure breaks down and insert newlines
// The file was mangled - multiple statements ended up on same line

// First, let's try replacing literal \n (backslash-n) with real newlines
// But we need to be careful about escaped newlines in strings like `\n[admin`

// Check the pattern - looking at the corrupted output, it seems like
// the literal \n (without backtick) was used as a separator
let fixed = content.replace(/\\n(?!\\)/g, '\n');

console.log('Number of lines after basic replace:', fixed.split('\n').length);

// Now we need to split long lines that have multiple statements
// Common patterns:
// - statements ending with ; followed by keywords like const, let, function
// - closing } followed by const, let, function

const lines = fixed.split('\n');
const newLines = [];

for (const line of lines) {
    if (line.length < 500) {
        // Short enough line, keep as is
        newLines.push(line);
    } else {
        // Long line - try to split on statement boundaries
        // Split on semicolons followed by common keywords
        let parts = line.split(/;(?=\s*(?:const|let|var|function|if|try|catch|return|router\.|router\.|module\.)|(?:\s*\}))/) || [line];
        if (parts.length === 1) parts = [line];
        newLines.push(...parts.map(p => p.trim()).filter(p => p.length > 0));
    }
}

fixed = newLines.join('\n');
console.log('Number of lines after splitting long lines:', fixed.split('\n').length);

// Write back
fs.writeFileSync(filePath, fixed, 'utf8');
console.log('Fixed! File size after:', fixed.length, 'bytes');
