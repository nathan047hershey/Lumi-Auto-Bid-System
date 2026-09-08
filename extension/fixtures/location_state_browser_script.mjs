/**
 * Browser: native location <select> + Flexential No readable; fill CA from profile aliases.
 */
export default async function (page) {
    const before = await page.evaluate(() => ({
        loc: document.getElementById('location_state')?.value || '',
        locText: document.getElementById('location_state')?.selectedOptions?.[0]?.text || '',
        flex: (document.querySelector('#field-flexential .select__single-value')?.textContent || '').trim(),
        phone: document.getElementById('phone')?.value || ''
    }));

    // Simulate engine fillSelect: match "California" / "CA" / "OH"
    const filled = await page.evaluate(() => {
        const sel = document.getElementById('location_state');
        const wanted = ['California', 'CA', 'Ohio', 'OH'];
        for (const opt of [...sel.options]) {
            const t = (opt.textContent || '').trim();
            const v = (opt.value || '').trim();
            if (wanted.some((w) => t.toLowerCase() === w.toLowerCase() || v.toLowerCase() === w.toLowerCase())) {
                sel.value = opt.value;
                sel.dispatchEvent(new Event('input', { bubbles: true }));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                return { ok: true, text: t, value: v };
            }
        }
        return { ok: false };
    });

    const after = await page.evaluate(() => ({
        loc: document.getElementById('location_state')?.value || '',
        locText: document.getElementById('location_state')?.selectedOptions?.[0]?.text || '',
        flex: (document.querySelector('#field-flexential .select__single-value')?.textContent || '').trim(),
        phoneDigits: String(document.getElementById('phone')?.value || '').replace(/\D/g, '')
    }));

    // Label classify (same rules as production)
    const kind = await page.evaluate(() => {
        const lab = (document.querySelector('#field-location label')?.innerText || '').toLowerCase();
        if (/\bwhere (?:are|do) you (?:located|currently reside|live)\b/.test(lab)
            || /\bwhere are you located\b/.test(lab)) {
            if (/\bstates?\s+we\s+do\s+not\s+hire|\bdo not hire in\b/.test(lab)
                || (/\b(alabama|alaska|hawaii|utah|nebraska)\b/.test(lab) && /\bhire\b/.test(lab))) {
                return 'state';
            }
            return 'city';
        }
        return 'other';
    });

    const ok =
        kind === 'state'
        && before.loc === ''
        && before.flex === 'No'
        && filled.ok
        && after.locText === 'California'
        && after.flex === 'No'
        && after.phoneDigits.length >= 10;

    return { ok, kind, before, filled, after };
}
