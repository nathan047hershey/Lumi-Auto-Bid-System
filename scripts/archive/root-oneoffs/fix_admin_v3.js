const fs = require('fs');

// Read the corrupted file
const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('File size before fix:', content.length, 'bytes');

// Fix pattern: '); followed by // without newline (code merged with comment)
content = content.replace(/'\)\/\//g, "')\n//");

// Fix pattern: `); followed by // without newline
content = content.replace(/`\);\/\//g, "`);\n//");

// Fix pattern: }); followed by // (closing object without newline)
content = content.replace(/\}\)\/\//g, "})\n//");

// Fix pattern: ]); followed by // (closing array call without newline)  
content = content.replace(/\]\)\/\//g, "])\n//");

// Split on patterns that indicate end of statement
const lines = content.split('\n');
const fixedLines = [];

for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    
    // Skip lines that are already reasonable length
    if (line.length < 800) {
        fixedLines.push(line);
        continue;
    }
    
    // Long line - try to intelligently split
    // First try splitting on '); followed by common keywords
    const parts = line.split(/'(?=\s*(?:const|let|var|function|\/\/|\}))/) || [line];
    if (parts.length <= 1) {
        // Try semicolon pattern
        const semiParts = line.split(/;(?=\s*(?:const|let|var|function|router\.|if|try|return|module\.)|(?:\s*\}))/) || [line];
        if (semiParts.length > 1) {
            fixedLines.push(...semiParts.map(p => p.trim()).filter(p => p.length > 0));
        } else {
            fixedLines.push(line);
        }
    } else {
        fixedLines.push(...parts.map(p => p.trim()).filter(p => p.length > 0));
    }
}

content = fixedLines.join('\n');
console.log('File size after fix:', content.length, 'bytes');
console.log('Number of lines:', content.split('\n').length);

// Write back
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed!');
