const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'server', 'routes', 'admin.js');
let content = fs.readFileSync(file, 'utf8');

console.log('Original file size:', content.length, 'bytes');
console.log('First 200 chars:', content.substring(0, 200));

// The corruption pattern: literal backslash-n (2 chars) instead of actual newline (1 char)
// Replace all occurrences of the literal string "\n" (not actual newlines) with real newlines
// But we need to be careful not to break things that legitimately have \n in strings

// Strategy: Find patterns that indicate line breaks should be inserted:
// 1. After statements like const, let, var, function, if, try, catch, return, etc.
// 2. After semicolons followed by these keywords
// 3. After closing braces followed by keywords

// The file seems to have actual CRLF or LF newlines now, but content is merged
// Let's check what kind of newlines we have
const hasLiteralBackslashN = content.includes('\\n');
const hasActualLF = content.includes('\n');
const hasActualCRLF = content.includes('\r\n');

console.log('Has literal \\\\n:', hasLiteralBackslashN);
console.log('Has actual LF:', hasActualLF);
console.log('Has actual CRLF:', hasActualCRLF);

// If the file has actual newlines but still has issues, the problem might be
// that we need to re-split based on statement patterns

// For now, let's try a targeted fix: look for the specific corruption pattern
// where we have `} = require(...);\n` followed by `const` without proper separation

// Find patterns like ";\nconst" and ensure proper line breaks
let fixed = content;

// Fix patterns where statements are merged without proper separation
// Common patterns:
// - `;\nconst` should have a blank line
// - `;\nfunction`  
// - `;\nrouter`
// - `;\n//`

// But first, let's check if the file actually has proper structure
// by counting visible lines
const lines = content.split(/\r?\n/);
console.log('Number of lines:', lines.length);

// The file should have thousands of lines if it's the full admin.js
if (lines.length < 100) {
    console.log('File appears truncated - only', lines.length, 'lines found');
    console.log('Re-reading with binary mode...');
    
    // Try binary mode to see raw bytes
    const buffer = fs.readFileSync(file);
    const text = buffer.toString('utf8');
    console.log('Binary read length:', text.length);
    
    // Check for literal backslash-n in binary
    const str = text;
    const idx = str.indexOf('\\n');
    if (idx !== -1) {
        console.log('Found literal \\n at position', idx);
        console.log('Context:', str.substring(Math.max(0, idx-30), idx+50));
    }
}

console.log('Script needs more investigation. File saved unchanged.');
