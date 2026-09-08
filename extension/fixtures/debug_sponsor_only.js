const { loadPuppeteer, chromePath, loadFillScript, injectAutofill } = require('./lib/autofill_test_harness');

(async () => {
    const puppeteer = await loadPuppeteer();
    const browser = await puppeteer.launch({
        executablePath: chromePath(),
        headless: 'new',
        args: ['--no-sandbox']
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    await page.goto(
        'https://job-boards.greenhouse.io/embed/job_app?for=gruve&token=5385111008',
        { waitUntil: 'domcontentloaded' }
    );
    await new Promise((r) => setTimeout(r, 5000));
    await injectAutofill(page, loadFillScript());

    const result = await page.evaluate(async () => {
        const el = document.getElementById('question_18229280008');
        if (!el) return { error: 'no sponsor el' };

        // Open and list options using injected helpers via FILL of one field
        const listeners = window.__chromeListeners || [];
        const send = (msg) => new Promise((resolve) => {
            let done = false;
            const respond = (p) => { if (!done) { done = true; resolve(p); } };
            for (const fn of listeners) {
                try { if (fn(msg, {}, respond) === true) return; } catch (e) {
                    respond({ ok: false, error: String(e) }); return;
                }
            }
            setTimeout(() => respond({ ok: false, error: 'timeout' }), 90000);
        });

        const fields = [{
            id: 'question_18229280008',
            label: 'Do you currently, or will you in the future, require visa sponsorship to work here?*',
            kind: 'requires_sponsorship',
            type: 'text',
            name: '',
            autoId: '',
            tag: 'input',
            combobox: true
        }];

        const fill = await send({
            type: 'FILL_FORM',
            payload: {
                fields,
                answers: [],
                profile: { requires_sponsorship: 'No' },
                jobDescription: ''
            }
        });

        await new Promise((r) => setTimeout(r, 3000));
        const shell = el.closest('.select-shell') || el.parentElement;
        return {
            fillStats: fill?.fillStats,
            fillOk: fill?.ok,
            error: fill?.error,
            shellText: (shell?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
            singles: [...document.querySelectorAll('.select__single-value')].map((n) => n.textContent.trim()),
            openOptionCount: document.querySelectorAll('[role="option"]').length
        };
    });

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
