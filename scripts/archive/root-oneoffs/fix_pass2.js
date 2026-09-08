// Fix the Node.js pattern — match "Node", then optional whitespace,
// then ".js" (with optional whitespace between Node and .)
const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/resumeService.js';
let c = fs.readFileSync(p, 'utf8');

const old = /\bNode\.?\\s?js\\b/g;
const replacement = /\\bNode[\\s\\S]*?\\.?\\s?js\\b/g;

const compound = `const COMPOUND_JOINERS = [
            // Spring ecosystem
            /\\bSpring\\s+Boot\\b/g,
            /\\bSpring\\s+Cloud\\b/g,
            // React ecosystem
            /\\bReact\\s+Native\\b/g,
            /\\bReact\\s+Hooks?\\b/g,
            /\\bReact\\s+Router\\b/g,
            /\\bReact\\s+Redux\\b/g,
            // JS frameworks
            /\\bNode[\\s\\S]*?\\.?\\s?js\\b/g,
            /\\bNext[\\s\\S]*?\\.?\\s?js\\b/g,
            /\\bNuxt[\\s\\S]*?\\.?\\s?js\\b/g,
            /\\bVue[\\s\\S]*?\\.?\\s?js\\b/g,
            /\\bExpress[\\s\\S]*?\\.?\\s?js\\b/g,`;

if (c.includes(old.source)) {
    c = c.replace(old, replacement.source);
    console.log('Fixed Node.js pattern');
}

const oldBlock = `            // JS frameworks
            /\\bNode\\.?\\s?js\\b/g,
            /\\bNext\\.?\\s?js\\b/g,
            /\\bNuxt\\.?\\s?js\\b/g,
            /\\bVue\\.?\\s?js\\b/g,
            /\\bExpress\\.?\\s?js\\b/g,`;

if (c.includes(oldBlock)) {
    c = c.replace(oldBlock, compound);
    console.log('Updated COMPOUND_JOINERS block');
}

fs.writeFileSync(p, c);
