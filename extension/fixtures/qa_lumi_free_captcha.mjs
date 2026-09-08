/**
 * Configure Lumi for free CAPTCHA helpers (NopeCHA / Buster):
 * clear CapSolver/2Captcha keys, enable helper wait + AFK-friendly prefs, save.
 */
export default async function (page, ui) {
    const base = 'http://127.0.0.1:5173';
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="text"], input[name="username"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('admin123');
    await page.getByRole('button', { name: /log\s*in|sign\s*in/i }).first().click();
    await page.waitForTimeout(1200);

    await page.goto(`${base}/admin/autofill-settings#lumi-bidder-settings`, {
        waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(1500);

    // Clear paid keys
    const cap = page.locator('#lumi-capsolver');
    const two = page.locator('#lumi-2captcha');
    if (await cap.count()) {
        await cap.fill('');
    }
    if (await two.count()) {
        await two.fill('');
    }

    // Ensure helper wait is on
    const helperLabel = page.getByText(/Also wait for helper extensions/i).first();
    const helperBox = page.locator('#lumi-helper');
    if (await helperBox.count()) {
        const checked = await helperBox.getAttribute('data-state');
        if (checked !== 'checked') await helperLabel.click();
    }

    await page.getByRole('button', { name: /Save & sync to Lumi/i }).click();
    await page.waitForTimeout(1500);

    const body = await page.locator('body').innerText();
    const capVal = await cap.inputValue().catch(() => '');
    const twoVal = await two.inputValue().catch(() => '');

    return {
        ok: capVal === '' && twoVal === '',
        capEmpty: capVal === '',
        twoEmpty: twoVal === '',
        savedMsg: /Saved/i.test(body),
        mode: 'free-helpers-only (NopeCHA/Buster)'
    };
}
