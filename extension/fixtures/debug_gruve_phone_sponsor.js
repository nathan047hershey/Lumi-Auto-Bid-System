/**
 * Debug Gruve phone dial-code vs residence country vs sponsorship.
 */
const { loadPuppeteer, chromePath, loadFillScript, injectAutofill } = require('./lib/autofill_test_harness');

(async () => {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
        executablePath: chromePath(),
        headless: 'new',
        args: ['--no-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(
        'https://job-boards.greenhouse.io/embed/job_app?for=gruve&token=5385111008',
        { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await new Promise((r) => setTimeout(r, 4000));

    const info = await page.evaluate(() => {
        const all = [...document.querySelectorAll('input, textarea, select')];
        return all.map((el) => {
            let lab = null;
            try {
                if (el.id) lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            } catch (_) { /* ignore */ }
            return {
                id: el.id,
                type: el.type,
                role: el.getAttribute('role'),
                aria: el.getAttribute('aria-label'),
                cls: String(el.className || '').slice(0, 100),
                inIti: !!el.closest('.iti, .phone-input, .phone-input__country, .iti__country-container'),
                label: (lab?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
                parent: String(el.parentElement?.className || '').slice(0, 80)
            };
        });
    });
    console.log('DOM', JSON.stringify(info, null, 2));

    await injectAutofill(page, loadFillScript());
    const collected = await page.evaluate(async () => {
        const listeners = window.__chromeListeners || [];
        const send = (msg) => new Promise((resolve) => {
            let done = false;
            const respond = (p) => { if (!done) { done = true; resolve(p); } };
            for (const fn of listeners) {
                try {
                    if (fn(msg, {}, respond) === true) return;
                } catch (e) {
                    respond({ ok: false, error: String(e) });
                    return;
                }
            }
            setTimeout(() => respond({ ok: false, error: 'timeout' }), 500);
        });
        const c = await send({ type: 'COLLECT_FORM' });
        return (c?.data?.fields || []).map((f) => ({
            id: f.id,
            kind: f.kind,
            label: String(f.label || '').slice(0, 100),
            combo: !!f.combobox,
            type: f.type
        }));
    });
    console.log('COLLECT', JSON.stringify(collected, null, 2));

    const profile = {
        first_name: 'Alex',
        last_name: 'Testuser',
        email: 'alex.testuser@example.com',
        phone: '3182028037',
        country: 'United States',
        degree: 'Bachelor of Science',
        discipline: 'Computer Science',
        requires_sponsorship: 'No',
        linkedin_url: 'https://www.linkedin.com/in/x',
        notice_period: '2 weeks',
        salary_range: '120000'
    };

    const fill = await page.evaluate(async (profile) => {
        const listeners = window.__chromeListeners || [];
        const send = (msg) => new Promise((resolve) => {
            let done = false;
            const respond = (p) => { if (!done) { done = true; resolve(p); } };
            for (const fn of listeners) {
                try {
                    if (fn(msg, {}, respond) === true) return;
                } catch (e) {
                    respond({ ok: false, error: String(e) });
                    return;
                }
            }
            setTimeout(() => respond({ ok: false, error: 'timeout' }), 180000);
        });
        const c = await send({ type: 'COLLECT_FORM' });
        const f = await send({
            type: 'FILL_FORM',
            payload: {
                fields: c.data.fields,
                answers: [],
                profile,
                jobDescription: 'Compensation $90,000 - $120,000'
            }
        });
        await new Promise((r) => setTimeout(r, 28000));
        const singles = [...document.querySelectorAll('.select__single-value')]
            .map((n) => n.textContent.trim())
            .filter((t) => t && t !== 'Select...');
        return {
            fillStats: f?.fillStats,
            phone: document.getElementById('phone')?.value || '',
            sponsor: (() => {
                const el = document.getElementById('question_18229280008');
                const root = el?.closest('.select-shell, [class*="select"]') || el?.parentElement;
                const sv = root?.querySelector('.select__single-value');
                return (sv?.textContent || el?.value || '').trim();
            })(),
            country: (() => {
                const el = document.getElementById('country');
                const root = el?.closest('.select-shell, [class*="select"]') || el?.parentElement;
                const sv = root?.querySelector('.select__single-value');
                return (sv?.textContent || el?.value || '').trim();
            })(),
            singles,
            openMenus: [...document.querySelectorAll('.select__menu, .iti__dropdown-content, [class*="menu"]')]
                .filter((m) => m.offsetParent !== null)
                .map((m) => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80))
        };
    }, profile);

    console.log('FILL', JSON.stringify(fill, null, 2));
    await browser.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
