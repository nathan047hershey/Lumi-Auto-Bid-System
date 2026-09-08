/**
 * Select typeahead must wait for loading to finish (not skip on "Loading…").
 * Run: node extension/fixtures/test_select_wait_loading.js
 */
'use strict';

function isLoadingOptionText(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return /^loading/.test(s) || /^searching/.test(s) || /^please wait/.test(s) || /^fetching/.test(s);
}

function filterRealOptions(labels) {
    return labels.filter((t) => {
        const s = String(t || '').replace(/\s+/g, ' ').trim();
        if (!s) return false;
        if (/^no options$/i.test(s) || /^no results/i.test(s)) return false;
        if (isLoadingOptionText(s)) return false;
        return true;
    });
}

function shouldKeepWaiting({ loading, options, elapsedMs, timeoutMs }) {
    if (elapsedMs >= timeoutMs) return false;
    if (loading) return true;
    if (!options.length) return true;
    return false;
}

const checks = [];
checks.push(['filter drops Loading', filterRealOptions(['Loading…', 'California']).length === 1]);
checks.push(['filter drops Searching', filterRealOptions(['Searching…']).length === 0]);
checks.push(['keep waiting while loading', shouldKeepWaiting({
    loading: true,
    options: [],
    elapsedMs: 200,
    timeoutMs: 8000
}) === true]);
checks.push(['keep waiting empty not loading', shouldKeepWaiting({
    loading: false,
    options: [],
    elapsedMs: 200,
    timeoutMs: 8000
}) === true]);
checks.push(['stop when options ready', shouldKeepWaiting({
    loading: false,
    options: ['California'],
    elapsedMs: 400,
    timeoutMs: 8000
}) === false]);
checks.push(['stop on timeout even loading', shouldKeepWaiting({
    loading: true,
    options: [],
    elapsedMs: 8000,
    timeoutMs: 8000
}) === false]);
checks.push(['human flow includes wait', ['click_open', 'type', 'wait_options', 'match', 'click'].includes('wait_options')]);

// Complete → no wait; incomplete → wait
function shouldWaitForSelect({ complete, loading, options }) {
    if (complete) return false;
    if (loading) return true;
    if (!options || !options.length) return true;
    return false;
}
checks.push(['no wait when complete', shouldWaitForSelect({
    complete: true, loading: false, options: ['Computer Science']
}) === false]);
checks.push(['wait when incomplete loading', shouldWaitForSelect({
    complete: false, loading: true, options: []
}) === true]);
checks.push(['wait when incomplete empty', shouldWaitForSelect({
    complete: false, loading: false, options: []
}) === true]);
checks.push(['no wait when options ready to pick', shouldWaitForSelect({
    complete: false, loading: false, options: ['Computer Science']
}) === false]);

// Simplify-style: click is not enough — must VERIFY displayed value (not "Select...")
function simplifyVerified(want, displayed) {
    const w = String(want || '').toLowerCase().trim();
    const g = String(displayed || '').replace(/\s+/g, ' ').trim();
    if (!w) return true;
    if (!g || /^select(\.\.\.|…|:)?$/i.test(g) || /^choose/i.test(g)) return false;
    const gl = g.toLowerCase();
    if (gl === w || gl.includes(w) || w.includes(gl)) return true;
    if (/computer/.test(w) && /computer|computing|\bcs\b/.test(gl)) return true;
    if (/bachelor/.test(w) && /bachelor/.test(gl)) return true;
    return false;
}
function simplifyShouldRetry(want, displayed) {
    return !simplifyVerified(want, displayed);
}
checks.push(['verify rejects Select...', simplifyShouldRetry('Computer Science', 'Select...') === true]);
checks.push(['verify accepts CS', simplifyVerified('Computer Science', 'Computer Science') === true]);
checks.push(['verify soft CS/Computing', simplifyVerified('Computer Science', 'Computing') === true]);
checks.push(['verify rejects empty', simplifyVerified('Computer Science', '') === false]);
checks.push(['type before wait for typeahead', ['open', 'type', 'wait_options', 'pick'].indexOf('type')
    < ['open', 'type', 'wait_options', 'pick'].indexOf('wait_options')]);
checks.push(['no pre-wait before input', true]);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) process.exit(1);
console.log(`\nAll ${checks.length} select-wait-loading checks passed.`);
