/**
 * Human-style Greenhouse select using real Playwright clicks (not synthetic DOM events).
 */
export default async function run(page, ui) {
    async function humanPick(labelIncludes, preferRe, avoidRe) {
        const label = page.locator('label').filter({ hasText: labelIncludes }).first();
        const count = await label.count();
        if (!count) return { ok: false, stage: 'label', error: 'not found', labelIncludes };

        const wrap = label.locator(
            'xpath=ancestor::*[contains(@class,"field-wrapper") or contains(@class,"select__container")][1]'
        );
        const control = wrap.locator('.select__control').first();
        await control.scrollIntoViewIfNeeded();
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(150);

        // Human open
        await control.click({ force: true });
        await page.waitForTimeout(700);

        // Wait for options that are NOT phone country codes
        const optionLocator = page.locator('[role="option"], .select__option');
        await page.waitForTimeout(400);

        const optionTexts = [];
        const n = await optionLocator.count();
        for (let i = 0; i < Math.min(n, 80); i++) {
            const t = ((await optionLocator.nth(i).innerText()) || '').replace(/\s+/g, ' ').trim();
            if (!t || /^select/i.test(t)) continue;
            if (/\+\d{1,4}$/.test(t)) continue;
            optionTexts.push(t);
        }

        // If still empty / only phone, try clicking the dropdown indicator
        if (optionTexts.length < 2) {
            const indicator = wrap.locator('.select__dropdown-indicator, [class*="indicatorContainer"]').first();
            if (await indicator.count()) {
                await indicator.click({ force: true });
                await page.waitForTimeout(700);
            } else {
                await control.click({ force: true });
                await page.waitForTimeout(700);
            }
            optionTexts.length = 0;
            const n2 = await optionLocator.count();
            for (let i = 0; i < Math.min(n2, 80); i++) {
                const t = ((await optionLocator.nth(i).innerText()) || '').replace(/\s+/g, ' ').trim();
                if (!t || /^select/i.test(t) || /\+\d{1,4}$/.test(t)) continue;
                optionTexts.push(t);
            }
        }

        const prefer = new RegExp(preferRe, 'i');
        const avoid = new RegExp(avoidRe || '$^', 'i');
        const pickText =
            optionTexts.find((t) => prefer.test(t) && !avoid.test(t)) ||
            optionTexts.find((t) => prefer.test(t)) ||
            optionTexts.find((t) => !avoid.test(t));

        if (!pickText) {
            const expanded = await wrap.locator('input[role="combobox"]').getAttribute('aria-expanded').catch(() => null);
            return {
                ok: false,
                stage: 'menu',
                labelIncludes,
                expanded,
                optionTexts: optionTexts.slice(0, 15),
                error: 'no option'
            };
        }

        // Click the visible option with that text (human)
        const opt = page
            .locator('[role="option"], .select__option')
            .filter({ hasText: pickText })
            .first();
        await opt.scrollIntoViewIfNeeded();
        await opt.click({ force: true });
        await page.waitForTimeout(400);

        const shown = (
            (await wrap.locator('.select__single-value, [class*="singleValue"]').first().innerText().catch(() => '')) ||
            ''
        ).trim();

        return {
            ok: !!shown && !/^select/i.test(shown),
            stage: 'picked',
            labelIncludes,
            clicked: pickText,
            shown,
            optionTexts: optionTexts.slice(0, 12)
        };
    }

    await page.locator('#application-form, .application--form').first().scrollIntoViewIfNeeded().catch(() => {});

    const rest = await humanPick(
        'REST APIs',
        'product|built|written|used|familiar|expert|proficient|extensive|years|I have',
        'not at all|afghanistan'
    );

    const ai = await humanPick(
        'AI tools in your current job',
        'extensively|moderately|regularly|daily|frequently',
        'not at all|do not use'
    );

    const python = await humanPick('written Python code that runs in a production', 'Yes', 'afghanistan');

    const startMonth = await humanPick('Start date month', 'January|September', 'afghanistan');

    const disability = await humanPick(
        'Disability Status',
        'do not have a disability|don.?t have a disability',
        'Yes, I have'
    );

    await page
        .locator('label')
        .filter({ hasText: 'REST APIs' })
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
    await page.waitForTimeout(300);

    return { rest, ai, python, startMonth, disability };
}
