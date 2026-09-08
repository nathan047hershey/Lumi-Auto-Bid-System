const fs = require('fs');

const filePath = 'd:\\Projects\\job-apply-master\\job-apply-master\\server\\routes\\admin.js';
let content = fs.readFileSync(filePath, 'utf8');

console.log('Before:', content.length, 'bytes,', content.split('\n').length, 'lines');

// Fix pattern 1: '); followed by // without newline
content = content.replace(/'\);(?=\s*\/\/)/g, "');\n");

// Fix pattern 2: `); followed by // without newline
content = content.replace(/`\);(?=\s*\/\/)/g, "`);\n");

// Fix pattern 3: }); followed by /** (closing object/function followed by JSDoc)
content = content.replace(/\}\);(?=\s*\/\*\*)/g, "});\n");

// Fix pattern 4: }); followed by function (closing object followed by function keyword)
content = content.replace(/\}\);(?=\s*function)/g, "});\n");

// Fix pattern 5: }); followed by // (closing object followed by comment)  
content = content.replace(/\}\);(?=\s*\/\/)/g, "});\n");

// Fix pattern 6: ]); followed by // (closing array call followed by comment)
content = content.replace(/\]\);(?=\s*\/\/)/g, "]);\n");

// Fix pattern 7: ]); followed by /** (closing array followed by JSDoc)
content = content.replace(/\]\);(?=\s*\/\*\*)/g, "]);\n");

// Now handle long lines by splitting on statement boundaries
const lines = content.split('\n');
const fixedLines = [];

for (const line of lines) {
    if (line.length < 1000) {
        fixedLines.push(line);
        continue;
    }
    
    // Long line - try to split intelligently
    // First, try splitting on }; followed by keywords
    const parts = line.split(/\}(?=\s*(?:const|let|function|if|\/\/|\/\*\*|$))/) || [line];
    if (parts.length > 1) {
        fixedLines.push(...parts.map(p => p.trim()).filter(p => p && !p.match(/^$/)));
    } else {
        // Try semicolon split
        const semiParts = line.split(/;(?=\s*(?:const|let|function|if|return|router\.))/);
        if (semiParts.length > 1) {
            fixedLines.push(...semiParts.map(p => p.trim() + ';').filter(p => !p.match(/^;$/)));
        } else {
            fixedLines.push(line);
        }
    }
}

content = fixedLines.join('\n');
console.log('After:', content.length, 'bytes,', content.split('\n').length, 'lines');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed!');
