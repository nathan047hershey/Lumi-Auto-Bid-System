/**
 * QA: Job Links Auto Bidder UI has profile + Check Lumi + Process.
 * Headless — no Chrome extension; verifies page shell only.
 */
export default async function run(page, ui) {
    const API = 'http://127.0.0.1:9017';
    const FRONT = 'http://127.0.0.1:5173';

    const loginRes = await page.request.post(`${API}/auth/login`, {
        data: { username: 'admin', password: 'admin123' }
    });
    const login = await loginRes.json();
    if (!login.token) {
        return { ok: false, error: 'admin login failed', login };
    }

    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
    }, { token: login.token, user: login.user });

    await page.goto(`${FRONT}/admin/job-links`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Click nav if still not on the list
    let body = await page.locator('body').innerText();
    if (!/Auto Bidder/i.test(body)) {
        const link = page.getByRole('link', { name: /^Job Links$/i });
        if (await link.count()) {
            await link.first().click();
            await page.waitForTimeout(2000);
            body = await page.locator('body').innerText();
        }
    }

    const hasAutoBidderBtn = await page.getByRole('button', { name: /Auto Bidder/i }).count();
    const checks = page.locator('table input[type="checkbox"], [role="checkbox"]');
    const checkCount = await checks.count();
    if (checkCount > 1) {
        await checks.nth(1).click({ force: true }).catch(() => {});
    }

    if (hasAutoBidderBtn) {
        await page.getByRole('button', { name: /Auto Bidder/i }).first().click();
        await page.waitForTimeout(1200);
    }

    const dialogText = await page.locator('[role="dialog"]').innerText().catch(() => '');
    const hasProfile = /Bid profile/i.test(dialogText);
    const hasCheckLumi = /Check Lumi/i.test(dialogText);
    const hasProcess = /Process selected/i.test(dialogText);
    const connected = /Lumi v[\d.]+ connected/i.test(dialogText);
    const notConnected = /not connected|Connect Job Links|Reload Lumi/i.test(dialogText);

    return {
        ok: hasProfile && hasCheckLumi && hasProcess,
        url: page.url(),
        user: login.user?.username,
        hasAutoBidderBtn: hasAutoBidderBtn > 0,
        checkCount,
        hasProfile,
        hasCheckLumi,
        hasProcess,
        connected,
        notConnected,
        dialogSnippet: dialogText.slice(0, 700),
        bodyHasJobLinks: /Job Links|techstack|OneTrust|Guidehouse/i.test(body),
        note: 'Headless has no Lumi extension — connected should be false; UI controls must still render'
    };
}
