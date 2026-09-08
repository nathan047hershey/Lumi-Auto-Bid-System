/**
 * Browser QA: Autofill Settings page loads after admin login.
 */
export default async function (page, ui) {
    const base = 'http://127.0.0.1:5173';
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(500);

    // Fill login
    const user = page.locator('input[type="text"], input[name="username"], input#username').first();
    const pass = page.locator('input[type="password"]').first();
    await user.fill('admin');
    await pass.fill('admin123');
    await page.getByRole('button', { name: /log\s*in|sign\s*in/i }).first().click();
    await page.waitForTimeout(1500);

    // Navigate to autofill settings
    await page.goto(`${base}/admin/autofill-settings`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    const title = await page.getByRole('heading', { name: /Autofill Settings/i }).count();
    const lumi = await page.getByText(/Lumi \/ Auto Bidder/i).count();
    const profileSection = await page.getByText(/Profile autofill defaults/i).count();
    const saveLumi = await page.getByRole('button', { name: /Save & sync to Lumi/i }).count();
    const navLink = await page.getByRole('link', { name: /Autofill Settings/i }).count();

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));

    // Toggle a checkbox and ensure no crash
    const afk = page.getByText(/Unattended \/ AFK/i).first();
    let toggled = false;
    if (await afk.count()) {
        await afk.click();
        toggled = true;
        await page.waitForTimeout(300);
    }

    const bodyText = await page.locator('body').innerText();
    const hasErrorBanner = /Failed to load profiles|Internal server error|Something went wrong/i.test(bodyText);

    return {
        ok: title > 0 && lumi > 0 && profileSection > 0 && saveLumi > 0 && navLink > 0 && !hasErrorBanner,
        title,
        lumi,
        profileSection,
        saveLumi,
        navLink,
        toggled,
        hasErrorBanner,
        url: page.url(),
        snippet: bodyText.slice(0, 500)
    };
}
