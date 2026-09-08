/**
 * Browser QA: save profile autofill defaults on Autofill Settings page.
 */
export default async function (page, ui) {
    const base = 'http://127.0.0.1:5173';
    await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="text"], input[name="username"]').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('admin123');
    await page.getByRole('button', { name: /log\s*in|sign\s*in/i }).first().click();
    await page.waitForTimeout(1200);

    await page.goto(`${base}/admin/autofill-settings#bidder-autofill-settings`, {
        waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(1500);

    const saveBtn = page.getByRole('button', { name: /Save autofill defaults/i });
    const count = await saveBtn.count();
    if (!count) {
        return { ok: false, error: 'Save autofill defaults button missing', text: (await page.locator('body').innerText()).slice(0, 800) };
    }

    // Change notice period if the field exists
    const notice = page.locator('input[name="notice_period"]').first();
    let noticeBefore = '';
    if (await notice.count()) {
        noticeBefore = await notice.inputValue();
        await notice.fill(noticeBefore === '3 weeks' ? '2 weeks' : '3 weeks');
    }

    await saveBtn.click();
    await page.waitForTimeout(1500);

    const body = await page.locator('body').innerText();
    const saved = /Autofill defaults saved/i.test(body);
    const failed = /Failed to save autofill/i.test(body);

    // Restore
    if (await notice.count() && noticeBefore) {
        await notice.fill(noticeBefore);
        await saveBtn.click();
        await page.waitForTimeout(800);
    }

    return {
        ok: saved && !failed,
        saved,
        failed,
        noticeBefore,
        url: page.url(),
        snippet: body.slice(0, 600)
    };
}
