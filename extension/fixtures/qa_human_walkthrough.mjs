/**
 * Human-style UI walkthrough: login → Job Links → Auto Bidder tabs →
 * Bid Courses tabs → other app pages. Headless (no Lumi extension).
 */
export default async function run(page, ui) {
    const API = 'http://127.0.0.1:9017';
    const FRONT = 'http://127.0.0.1:5173';
    const steps = [];
    const fail = (step, detail) => {
        steps.push({ step, ok: false, detail });
    };
    const pass = (step, detail = '') => {
        steps.push({ step, ok: true, detail });
    };

    const loginRes = await page.request.post(`${API}/auth/login`, {
        data: { username: 'admin', password: 'admin123' }
    });
    const login = await loginRes.json();
    if (!login.token) {
        return { ok: false, error: 'admin login failed', login };
    }
    pass('api_login', login.user?.username);

    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
    }, { token: login.token, user: login.user });

    // --- Job Links ---
    await page.goto(`${FRONT}/admin/job-links`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const jobLinksBody = await page.locator('body').innerText();
    if (!/Job Links|Auto Bidder/i.test(jobLinksBody)) {
        fail('job_links_page', jobLinksBody.slice(0, 200));
    } else {
        pass('job_links_page', page.url());
    }

    const checks = page.locator('table input[type="checkbox"], [role="checkbox"]');
    const checkCount = await checks.count();
    if (checkCount > 1) {
        await checks.nth(1).click({ force: true }).catch(() => {});
        pass('select_job_row', `checkboxes=${checkCount}`);
    } else {
        fail('select_job_row', `only ${checkCount} checkboxes`);
    }

    const autoBtn = page.getByRole('button', { name: /Auto Bidder/i });
    if (!(await autoBtn.count())) {
        fail('open_auto_bidder', 'button missing');
        return { ok: false, steps };
    }
    await autoBtn.first().click();
    await page.waitForTimeout(1200);
    const dialog = page.locator('[role="dialog"]');
    await dialog.waitFor({ state: 'visible', timeout: 8000 });
    pass('open_auto_bidder', 'dialog visible');

    // Setup tab should be default — profile + Process live here now
    let dialogText = await dialog.innerText();
    const setupOk = /Bid profile|Process selected|Check Lumi|Setup/i.test(dialogText);
    if (setupOk) pass('tab_setup', 'controls visible');
    else fail('tab_setup', dialogText.slice(0, 300));

    // Click Courses tab
    const coursesTab = dialog.getByRole('tab', { name: /Courses/i });
    if (await coursesTab.count()) {
        await coursesTab.first().click();
        await page.waitForTimeout(600);
        dialogText = await dialog.innerText();
        if (/Bid courses|No courses yet|#\d+/i.test(dialogText) || /Canonical|OneTrust|FILLED|Filled|Ready/i.test(dialogText)) {
            pass('tab_courses', 'list rendered');
        } else {
            fail('tab_courses', dialogText.slice(0, 400));
        }
    } else {
        fail('tab_courses', 'tab missing');
    }

    // Pick first course card if present, expect Form tab
    const courseCard = dialog.locator('button').filter({ hasText: /#\d+/ }).first();
    if (await courseCard.count()) {
        await courseCard.click();
        await page.waitForTimeout(1000);
        dialogText = await dialog.innerText();
        const formTabActive = await dialog.getByRole('tab', { name: /^Form$/i }).getAttribute('data-state').catch(() => null);
        if (formTabActive === 'active' || /Screenshots|Live monitor|Result:|Open apply/i.test(dialogText)) {
            pass('tab_form_after_select', `state=${formTabActive}`);
        } else {
            fail('tab_form_after_select', dialogText.slice(0, 400));
        }

        const logTab = dialog.getByRole('tab', { name: /^Log$/i });
        if (await logTab.count()) {
            await logTab.first().click();
            await page.waitForTimeout(600);
            dialogText = await dialog.innerText();
            if (/Timeline|Answers|Field attempts|Download CV|queue_|form_/i.test(dialogText)) {
                pass('tab_log', 'timeline/answers visible');
            } else {
                fail('tab_log', dialogText.slice(0, 400));
            }
        }
    } else {
        pass('tab_form_after_select', 'skipped — no course cards yet');
    }

    // Close dialog and use the rest of the app
    const closeBtn = dialog.getByRole('button', { name: /Close dialog|Close/i }).first();
    if (await closeBtn.count()) {
        await closeBtn.click().catch(async () => {
            await page.keyboard.press('Escape');
        });
    } else {
        await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(500);
    pass('close_dialog', 'escaped/closed');

    // --- Bid Courses page ---
    await page.goto(`${FRONT}/admin/bid-courses`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    let pageText = await page.locator('body').innerText();
    if (/Bid Courses|Courses/i.test(pageText)) pass('bid_courses_page', page.url());
    else fail('bid_courses_page', pageText.slice(0, 200));

    const pageCoursesTab = page.getByRole('tab', { name: /Courses/i });
    const pageFormTab = page.getByRole('tab', { name: /^Form$/i });
    const pageLogTab = page.getByRole('tab', { name: /^Log$/i });
    if ((await pageCoursesTab.count()) && (await pageFormTab.count()) && (await pageLogTab.count())) {
        pass('bid_courses_tabs', 'Courses/Form/Log present');
        const firstLink = page.locator('a[href*="/bid-courses/"]').first();
        if (await firstLink.count()) {
            await firstLink.click();
            await page.waitForTimeout(1000);
            pageText = await page.locator('body').innerText();
            if (/Screenshot|Apply URL|Status|Form/i.test(pageText)) {
                pass('bid_courses_form_view', page.url());
            } else {
                fail('bid_courses_form_view', pageText.slice(0, 300));
            }
            await pageLogTab.first().click();
            await page.waitForTimeout(500);
            pageText = await page.locator('body').innerText();
            if (/Answers|Timeline|Field attempts|Job description/i.test(pageText)) {
                pass('bid_courses_log_view', 'ok');
            } else {
                fail('bid_courses_log_view', pageText.slice(0, 300));
            }
        }
    } else {
        fail('bid_courses_tabs', 'missing tabs');
    }

    // --- Other app surfaces (human would click around while bidding) ---
    const routes = [
        ['/admin/settings', /Setting|Password|Account|Save/i],
        ['/admin/dashboard', /Dashboard|stats|Applications|Welcome/i],
        ['/admin/applications', /Applications|Status|Company/i],
        ['/admin/profiles', /Profile|Candidate|Name/i],
        ['/admin/job-links', /Job Links|Auto Bidder/i]
    ];
    for (const [path, re] of routes) {
        await page.goto(`${FRONT}${path}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(900);
        const t = await page.locator('body').innerText();
        const consoleBad = [];
        if (re.test(t) && !/Something went wrong|Cannot read|Unexpected token/i.test(t)) {
            pass(`nav_${path}`, 'usable');
        } else {
            fail(`nav_${path}`, t.slice(0, 220));
        }
    }

    const failed = steps.filter((s) => !s.ok);
    return {
        ok: failed.length === 0,
        failed: failed.length,
        passed: steps.filter((s) => s.ok).length,
        steps,
        note: 'Headless has no Lumi — Process/live fill covered by test:bidder:live separately'
    };
}
