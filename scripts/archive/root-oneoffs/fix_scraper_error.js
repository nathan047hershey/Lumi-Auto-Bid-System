const fs = require('fs');
const p = 'd:/Projects/job-apply-master/job-apply-master/server/services/jobLinkScraper.js';
let c = fs.readFileSync(p, 'utf8');

// Add a safe error formatter after the imports at the top
const errorFormatter = `
// Helper to safely format any error (including AggregateError) to a string
function formatFetchError(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) {
        // Handle AggregateError specifically - it has multiple sub-errors
        if (err.constructor && err.constructor.name === 'AggregateError') {
            const subErrors = (err.errors || []).map(e => {
                if (e instanceof Error) return e.message;
                if (typeof e === 'string') return e;
                try { return JSON.stringify(e); } catch { return String(e); }
            }).filter(Boolean);
            if (subErrors.length > 0) {
                return 'AggregateError: ' + subErrors.join(' | ');
            }
            return 'AggregateError (no detail)';
        }
        // For regular Errors, return the message
        if (err.message) return err.message;
        // Some errors have a 'reason' field
        if (err.reason) {
            if (typeof err.reason === 'string') return err.reason;
            if (err.reason.message) return err.reason.message;
        }
    }
    // Fallback to String() conversion
    try {
        const s = String(err);
        if (s && s !== '[object Object]') return s;
    } catch {}
    try {
        return JSON.stringify(err);
    } catch {
        return 'unknown error';
    }
}

`;

// Insert the formatter before the scrapeRow function
if (!c.includes('function formatFetchError')) {
    // Insert after the imports
    c = c.replace(
        /(const \{[^}]+\} = require\('\.\.\/config\/database'\);)/,
        '$1\n' + errorFormatter
    );
}

// Replace the catch block in scrapeRow that converts errors
const oldCatch = `    } catch (err) {
        parsed = { error: (err && err.message) || String(err) };
    }`;
const newCatch = `    } catch (err) {
        parsed = { error: formatFetchError(err) };
    }`;

if (c.includes(oldCatch)) {
    c = c.replace(oldCatch, newCatch);
    console.log('✓ Replaced catch block in scrapeRow');
} else {
    console.log('✗ Catch block pattern not found');
}

fs.writeFileSync(p, c);
console.log('✓ Fixed jobLinkScraper.js error formatting');
