/**
 * Greenhouse human open+click via accessibility refs (ui.click).
 */
export default async function run(page, ui) {
    async function pickCombobox(nameIncludes, preferRe, avoidRe = /not at all|afghanistan/i) {
        const snap = await ui.snapshot();
        const lines = snap.split('\n');
        const line = lines.find((l) => /combobox/i.test(l) && nameIncludes.test(l));
        if (!line) return { ok: false, stage: 'find', snapHint: lines.filter((l) => /combobox/i.test(l)).slice(0, 8), nameIncludes: String(nameIncludes) };

        const ref = line.match(/@(e\d+)/)?.[1];
        if (!ref) return { ok: false, stage: 'ref', line };

        await ui.click(`@${ref}`);
        await page.waitForTimeout(800);

        const openSnap = await ui.snapshot();
        const optionLines = openSnap
            .split('\n')
            .map((l) => {
                const m = l.match(/@(e\d+)\s+option\s+"([^"]+)"/i);
                return m ? { ref: m[1], text: m[2] } : null;
            })
            .filter(Boolean);

        // Also match option without quotes variants
        if (!optionLines.length) {
            for (const l of openSnap.split('\n')) {
                const m = l.match(/@(e\d+)\s+option\s+(.+)$/i);
                if (m) optionLines.push({ ref: m[1], text: m[2].replace(/^"|"$/g, '').trim() });
            }
        }

        const prefer = preferRe instanceof RegExp ? preferRe : new RegExp(preferRe, 'i');
        const avoid = avoidRe instanceof RegExp ? avoidRe : new RegExp(avoidRe, 'i');
        const pick =
            optionLines.find((o) => prefer.test(o.text) && !avoid.test(o.text)) ||
            optionLines.find((o) => prefer.test(o.text)) ||
            optionLines.find((o) => !avoid.test(o.text) && !/\+\d/.test(o.text));

        if (!pick) {
            return {
                ok: false,
                stage: 'menu',
                opened: line.trim(),
                optionCount: optionLines.length,
                options: optionLines.map((o) => o.text).slice(0, 15),
                openSnapSample: openSnap.split('\n').filter((l) => /option|listbox|menu/i.test(l)).slice(0, 20)
            };
        }

        await ui.click(`@${pick.ref}`);
        await page.waitForTimeout(450);

        // Re-read combobox accessible name/value
        const after = await ui.snapshot();
        const afterLine = after.split('\n').find((l) => /combobox/i.test(l) && nameIncludes.test(l)) || '';

        return {
            ok: true,
            stage: 'picked',
            field: line.trim(),
            clicked: pick.text,
            afterLine: afterLine.trim(),
            options: optionLines.map((o) => o.text).slice(0, 12)
        };
    }

    // Close any open menu
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);

    const rest = await pickCombobox(/REST APIs/i, /product|I have|built|written|experience|familiar|years/i);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);

    const ai = await pickCombobox(/AI tools|empowering every employee with AI/i, /extensively|moderately|regularly|daily|frequently/i, /not at all|do not use/i);
    await page.keyboard.press('Escape').catch(() => {});

    const python = await pickCombobox(/Python code that runs in a production/i, /^Yes$/i);
    await page.keyboard.press('Escape').catch(() => {});

    const startMonth = await pickCombobox(/Start date month/i, /January|September/i);
    await page.keyboard.press('Escape').catch(() => {});

    const disability = await pickCombobox(/Disability Status/i, /do not have a disability|don.?t have a disability/i, /Yes, I have/i);

    return { rest, ai, python, startMonth, disability };
}
