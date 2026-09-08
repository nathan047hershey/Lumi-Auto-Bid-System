/**
 * Full-site human crawl — visit every main admin (+ key user) route,
 * open dialogs, click tabs, and collect real breakage.
 */
export default async function run(page, ui) {
    const API = 'http://127.0.0.1:9017';
    const FRONT = 'http://127.0.0.1:5173';
    const pages = [];
    const issues = [];
    const consoleHits = [];

    page.on('console', (msg) => {
        const t = msg.type();
        if (t === 'error' || t === 'warning') {
            const text = msg.text();
            if (/Download the React DevTools|favicon|fonts\.gstatic|net::ERR_ABORTED.*woff/i.test(text)) return;
            consoleHits.push({ type: t, text: text.slice(0, 240), url: page.url() });
        }
    });
    page.on('pageerror', (err) => {
        consoleHits.push({ type: 'pageerror', text: String(err?.message || err).slice(0, 240), url: page.url() });
        issues.push({ severity: 'high', kind: 'pageerror', url: page.url(), detail: String(err?.message || err).slice(0, 300) });
    });

    const loginRes = await page.request.post(`${API}/auth/login`, {
        data: { username: 'admin', password: 'admin123' }
    });
    const login = await loginRes.json();
    if (!login.token) return { ok: false, error: 'login failed', login };

    await page.goto(`${FRONT}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
    }, { token: login.token, user: login.user });

    const crashRe = /Something went wrong|Cannot read propert|is not a function|Unexpected token|ChunkLoadError|Minified React error|Failed to fetch|Internal Server Error|404 Not Found|Page not found/i;
    const emptyish = (t) => !t || t.replace(/\s+/g, '').length < 40;

    async function visit(path, expectRe, opts = {}) {
        const url = `${FRONT}${path}`;
        const start = Date.now();
        let status = 0;
        try {
            const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            status = res?.status() || 0;
        } catch (err) {
            issues.push({ severity: 'high', kind: 'nav_fail', path, detail: String(err?.message || err).slice(0, 200) });
            pages.push({ path, ok: false, ms: Date.now() - start, status: 0 });
            return null;
        }
        await page.waitForTimeout(opts.waitMs || 1100);
        const text = await page.locator('body').innerText().catch(() => '');
        const title = await page.title().catch(() => '');
        const crashed = crashRe.test(text);
        const blank = emptyish(text);
        const expected = expectRe ? expectRe.test(text) : true;
        const ok = status < 400 && !crashed && !blank && expected;
        pages.push({
            path,
            ok,
            ms: Date.now() - start,
            status,
            title,
            chars: text.length,
            snippet: text.replace(/\s+/g, ' ').slice(0, 160)
        });
        if (!ok) {
            issues.push({
                severity: crashed ? 'high' : 'medium',
                kind: crashed ? 'crash_text' : blank ? 'blank' : !expected ? 'missing_content' : 'bad_status',
                path,
                detail: text.replace(/\s+/g, ' ').slice(0, 280)
            });
        }
        return text;
    }

    // ---- Admin surfaces ----
    await visit('/admin/settings', /Setting|Password|API|Save|Account/i);
    await visit('/admin/dashboard', /Dashboard|Applications|Job Links|stats|Welcome|Overview/i);
    await visit('/admin/users', /Users|Username|Role|Email|Create|Add/i);
    await visit('/admin/developers', /Developer|Name|Email|Add|Create/i);
    await visit('/admin/profiles', /Profile|Candidate|Name|Create|Add/i);
    await visit('/admin/profiles/new', /Profile|Save|First|Name|Email|Cancel|Create/i);
    await visit('/admin/assignments', /Assign|Profile|User|Job/i);
    await visit('/admin/applications', /Application|Company|Status|Profile/i);
    await visit('/admin/interviews', /Interview|Request|Status|Schedule|Company/i);
    await visit('/admin/resume-templates', /Template|Resume|Create|Name/i);
    await visit('/admin/job-links', /Job Links|Auto Bidder|Company|URL/i);
    await visit('/admin/bid-courses', /Bid Courses|Courses|Form|Log/i);
    await visit('/admin/analyze', /Analyze|Overview|Signals|Company|Run/i);

    // Job link detail — open first row if present
    await page.goto(`${FRONT}/admin/job-links`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const detailLink = page.locator('a[href*="/admin/job-links/"]').first();
    if (await detailLink.count()) {
        const href = await detailLink.getAttribute('href');
        await visit(href.replace(FRONT, '').replace(/^http:\/\/127\.0\.0\.1:5173/, ''), /Job|Company|URL|Profile|Generate|Status|Apply/i, { waitMs: 1500 });
    } else {
        issues.push({ severity: 'low', kind: 'no_job_links', path: '/admin/job-links', detail: 'no detail links to open' });
    }

    // Bid course detail + tabs
    await page.goto(`${FRONT}/admin/bid-courses`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const courseLink = page.locator('a[href*="/bid-courses/"]').first();
    if (await courseLink.count()) {
        await courseLink.click();
        await page.waitForTimeout(1200);
        const formTab = page.getByRole('tab', { name: /^Form$/i });
        const logTab = page.getByRole('tab', { name: /^Log$/i });
        if (!(await formTab.count()) || !(await logTab.count())) {
            issues.push({ severity: 'medium', kind: 'missing_tabs', path: page.url(), detail: 'Form/Log tabs missing on Bid Courses detail' });
        } else {
            await formTab.click();
            await page.waitForTimeout(500);
            let t = await page.locator('body').innerText();
            if (!/Screenshot|Apply URL|Status|No screenshots/i.test(t)) {
                issues.push({ severity: 'medium', kind: 'form_tab_empty', path: page.url(), detail: t.slice(0, 200) });
            }
            // Check broken screenshot images
            const brokenShots = await page.evaluate(() => {
                const imgs = [...document.querySelectorAll('img')];
                return imgs
                    .filter((img) => img.src && /screenshot/i.test(img.src) && (!img.complete || img.naturalWidth === 0))
                    .map((img) => img.src)
                    .slice(0, 5);
            });
            if (brokenShots.length) {
                issues.push({ severity: 'medium', kind: 'broken_screenshot', path: page.url(), detail: brokenShots.join(' | ') });
            }
            await logTab.click();
            await page.waitForTimeout(500);
            t = await page.locator('body').innerText();
            if (!/Answers|Timeline|Field attempts|Job description/i.test(t)) {
                issues.push({ severity: 'medium', kind: 'log_tab_empty', path: page.url(), detail: t.slice(0, 200) });
            }
            pages.push({ path: page.url().replace(FRONT, '') + '#tabs', ok: true, ms: 0, status: 200, chars: t.length });
        }
    }

    // Auto Bidder dialog deep check
    await page.goto(`${FRONT}/admin/job-links`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const checks = page.locator('table input[type="checkbox"], [role="checkbox"]');
    if ((await checks.count()) > 1) {
        await checks.nth(1).click({ force: true }).catch(() => {});
    }
    const autoBtn = page.getByRole('button', { name: /Auto Bidder/i });
    if (await autoBtn.count()) {
        await autoBtn.first().click();
        await page.waitForTimeout(1000);
        const dialog = page.locator('[role="dialog"]');
        const visible = await dialog.isVisible().catch(() => false);
        if (!visible) {
            issues.push({ severity: 'high', kind: 'autobidder_dialog', path: '/admin/job-links', detail: 'dialog did not open' });
        } else {
            const tabs = ['Setup', 'Courses', 'Form', 'Log'];
            for (const name of tabs) {
                const tab = dialog.getByRole('tab', { name: new RegExp(`^${name}`, 'i') });
                if (!(await tab.count())) {
                    issues.push({ severity: 'high', kind: 'missing_dialog_tab', path: 'AutoBidder', detail: name });
                    continue;
                }
                // Form/Log may be disabled until a course is selected
                const disabled = await tab.isDisabled().catch(() => false);
                if (disabled && (name === 'Form' || name === 'Log')) {
                    // select a course first
                    await dialog.getByRole('tab', { name: /Courses/i }).click();
                    await page.waitForTimeout(400);
                    const card = dialog.locator('button').filter({ hasText: /#\d+/ }).first();
                    if (await card.count()) await card.click();
                    await page.waitForTimeout(700);
                }
                await tab.click({ force: true }).catch(() => {});
                await page.waitForTimeout(450);
                const dt = await dialog.innerText();
                if (name === 'Setup' && !/Bid profile|Process selected|Check Lumi/i.test(dt)) {
                    issues.push({ severity: 'high', kind: 'setup_empty', detail: dt.slice(0, 200) });
                }
                if (name === 'Courses' && !/Bid courses|No courses|#\d+/i.test(dt)) {
                    issues.push({ severity: 'medium', kind: 'courses_empty', detail: dt.slice(0, 200) });
                }
                if (name === 'Form' && !/Screenshot|Live monitor|Result:|Select a Bid course|Open apply|No screenshots/i.test(dt)) {
                    issues.push({ severity: 'medium', kind: 'form_empty', detail: dt.slice(0, 200) });
                }
                if (name === 'Log' && !/Timeline|Answers|Field attempts|Select a Bid course/i.test(dt)) {
                    issues.push({ severity: 'medium', kind: 'log_empty', detail: dt.slice(0, 200) });
                }
            }
            pages.push({ path: '/admin/job-links#autobidder', ok: true, ms: 0, status: 200, chars: 1 });
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
        }
    } else {
        issues.push({ severity: 'high', kind: 'no_autobidder_btn', path: '/admin/job-links' });
    }

    // ---- User surfaces (admin session can still open /user if allowed) ----
    await visit('/user/settings', /Setting|Password|Account|Save/i);
    await visit('/user/profiles', /Profile|Dashboard|Generate|Application|Job/i);
    await visit('/user/dashboard', /Dashboard|Stat|Application|Interview|Bid/i);
    await visit('/user/applications', /Application|Company|Status/i);
    await visit('/user/job-links', /Job Links|Company|URL|Auto Bidder/i);
    await visit('/user/interviews', /Interview|Request|Status/i);
    await visit('/user/bid-insights', /Insight|Bid|Chart|Company|Application/i);
    await visit('/user/analyze', /Analyze|Overview|Signals|Run/i);
    await visit('/user/bid-courses', /Bid Courses|Courses|Form|Log/i);
    await visit('/user/generate', /Generate|Resume|Job|Profile|Description/i);
    await visit('/user/templates', /Template|Resume|Create|Editor|Name/i);

    // Collect failed API-ish requests from performance
    const failedNet = await page.evaluate(() => {
        // best-effort: nothing stored; return empty — runner already tracks failed requests
        return [];
    });

    // Deduplicate console noise for report
    const consoleErrors = consoleHits
        .filter((c) => c.type === 'error' || c.type === 'pageerror')
        .reduce((acc, c) => {
            const key = `${c.type}|${c.text}`;
            if (!acc.map.has(key)) {
                acc.map.set(key, { ...c, count: 1 });
                acc.list.push(acc.map.get(key));
            } else {
                acc.map.get(key).count += 1;
            }
            return acc;
        }, { map: new Map(), list: [] }).list;

    // Promote repeated 404 screenshot fetches if seen in console
    for (const c of consoleErrors) {
        if (/screenshots\/.+\.png/i.test(c.text) || /404.*screenshot/i.test(c.text)) {
            issues.push({ severity: 'medium', kind: 'screenshot_404_console', detail: c.text, count: c.count });
        }
    }

    const pageFail = pages.filter((p) => !p.ok);
    return {
        ok: issues.filter((i) => i.severity !== 'low').length === 0 && pageFail.length === 0,
        summary: {
            pagesTried: pages.length,
            pagesOk: pages.filter((p) => p.ok).length,
            pagesFailed: pageFail.length,
            issues: issues.length,
            consoleErrors: consoleErrors.length
        },
        issues,
        pageFail,
        consoleErrors: consoleErrors.slice(0, 30),
        pages: pages.map((p) => ({ path: p.path, ok: p.ok, ms: p.ms, chars: p.chars }))
    };
}
