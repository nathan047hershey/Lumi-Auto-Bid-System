/**
 * Regression checks for latent autofill bugs (no browser).
 * Run: node extension/fixtures/test_latent_bugs.js
 */

/** Mirrors fill.js fieldKey — must stay in sync. */
function fieldKey(el, label) {
    const auto = el.getAttribute?.('data-automation-id') || '';
    const base = el.id || el.name || auto || '';
    if (base) return String(base).slice(0, 140);
    if (label) return String(label).slice(0, 140);
    const all = el.__all || [];
    const idx = Math.max(0, all.indexOf(el));
    return `${(el.tagName || 'el').toLowerCase()}_${el.type || 'x'}_${idx}`.slice(0, 140);
}

function over18Fill(profile) {
    const raw = String(profile.over_18 || '').trim();
    if (raw) return raw;
    const country = String(profile.country || 'United States').trim();
    return /^(united states|usa|u\.?s\.?a?\.?)$/i.test(country) ? 'Yes' : '';
}

const checks = [];

// Stable fieldKey: same element twice → same id (no Math.random).
{
    const all = [
        { tagName: 'INPUT', type: 'text', id: '', name: '', getAttribute: () => '' },
        { tagName: 'INPUT', type: 'text', id: '', name: '', getAttribute: () => '' }
    ];
    all.forEach((el) => { el.__all = all; });
    const a1 = fieldKey(all[0], '');
    const a2 = fieldKey(all[0], '');
    const b1 = fieldKey(all[1], '');
    checks.push(['fieldKey stable', a1 === a2]);
    checks.push(['fieldKey distinct', a1 !== b1]);
    checks.push(['fieldKey no random', !/0\.\d+/.test(a1) && a1.includes('input_text_0')]);
}

// over_18 defaults Yes for US when unset
checks.push(['over_18 US default', over18Fill({ country: 'United States' }) === 'Yes']);
checks.push(['over_18 keeps Yes', over18Fill({ over_18: 'Yes', country: 'United States' }) === 'Yes']);
checks.push(['over_18 keeps No', over18Fill({ over_18: 'No', country: 'United States' }) === 'No']);
checks.push(['over_18 non-US empty', over18Fill({ country: 'Canada' }) === '']);

const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
if (failed.length) {
    console.error(`\n${failed.length} failed`);
    process.exit(1);
}
console.log(`\nAll ${checks.length} latent-bug checks passed.`);
