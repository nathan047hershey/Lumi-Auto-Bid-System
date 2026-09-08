export default async function (page) {
    const base = 'http://127.0.0.1:5173';
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="text"], input[name="username"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('admin123');
    await page.getByRole('button', { name: /log\s*in|sign\s*in/i }).first().click();
    await page.waitForTimeout(1000);
    await page.goto(`${base}/admin/autofill-settings#lumi-bidder-settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const cap = page.locator('#lumi-capsolver');
    const two = page.locator('#lumi-2captcha');
    await cap.fill('');
    await two.fill('');

    const helper = page.locator('#lumi-helper');
    if (await helper.count()) {
        const state = await helper.getAttribute('data-state');
        if (state !== 'checked') {
            await page.getByText(/Also wait for helper extensions/i).first().click();
        }
    }

    // Persist locally even if extension sync fails
    await page.evaluate(() => {
        const raw = localStorage.getItem('lumi_bidder_prefs');
        const prefs = raw ? JSON.parse(raw) : {};
        prefs.capsolverApiKey = '';
        prefs.twocaptchaApiKey = '';
        prefs.captchaHelper = true;
        prefs.unattended = true;
        localStorage.setItem('lumi_bidder_prefs', JSON.stringify(prefs));
        localStorage.setItem('lumi_capsolver_api_key', '');
        localStorage.setItem('lumi_twocaptcha_api_key', '');
    });

    await page.getByRole('button', { name: /Save & sync to Lumi/i }).click();
    await page.waitForTimeout(1200);

    return {
        capsolver: await cap.inputValue(),
        twocaptcha: await two.inputValue(),
        helperState: await helper.getAttribute('data-state').catch(() => null),
        local: await page.evaluate(() => ({
            prefs: JSON.parse(localStorage.getItem('lumi_bidder_prefs') || '{}'),
            capKey: localStorage.getItem('lumi_capsolver_api_key'),
            twoKey: localStorage.getItem('lumi_twocaptcha_api_key')
        }))
    };
}
