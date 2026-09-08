/**
 * Focused Gruve: phone + sponsorship only.
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
    await injectAutofill(page, loadFillScript());

    const result = await page.evaluate(async () => {
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
            setTimeout(() => respond({ ok: false, error: 'timeout' }), 120000);
        });

        const profile = {
            first_name: 'Alex',
            last_name: 'Testuser',
            email: 'alex.testuser@example.com',
            phone: '3182028037',
            country: 'United States',
            degree: "Bachelor's Degree",
            discipline: 'Computer Science',
            requires_sponsorship: 'No',
            linkedin_url: 'https://linkedin.com/in/x',
            notice_period: '2 weeks',
            salary_range: '120000'
        };

        const collect = await send({ type: 'COLLECT_FORM' });
        const hasCountry = (collect.data.fields || []).some((f) => f.kind === 'country');
        const hasPhone = (collect.data.fields || []).some((f) => f.kind === 'phone');
        const hasSponsor = (collect.data.fields || []).some((f) => f.kind === 'requires_sponsorship');

        const fill = await send({
            type: 'FILL_FORM',
            payload: { fields: collect.data.fields, answers: [], profile, jobDescription: '' }
        });

        // Snapshot right after fill resolves (combos should be done)
        const snap = () => {
            const phone = document.getElementById('phone');
            const sponsor = document.getElementById('question_18229280008');
            const shell = sponsor?.closest('.select-shell, [class*="select-shell"]')
                || sponsor?.closest('[class*="select"]');
            const singles = [...document.querySelectorAll('.select__single-value')]
                .map((n) => n.textContent.trim());
            return {
                phoneValue: phone?.value || '',
                phoneDigits: String(phone?.value || '').replace(/\D/g, ''),
                sponsorInput: sponsor?.value || '',
                sponsorShellText: (shell?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                singles,
                fillStats: fill?.fillStats
            };
        };

        const immediate = snap();
        await new Promise((r) => setTimeout(r, 2000));
        const later = snap();

        return { hasCountry, hasPhone, hasSponsor, fieldCount: collect.data.fields.length, immediate, later };
    });

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
