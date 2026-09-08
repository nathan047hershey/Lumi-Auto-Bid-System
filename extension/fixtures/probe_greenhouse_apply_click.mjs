/** Click Greenhouse Apply and report whether viewport shows the form. */
export default async function run(page) {
    await page.waitForTimeout(2000);
    const before = await page.evaluate(() => {
        const first = document.querySelector('#first_name, [name=first_name]');
        const r = first?.getBoundingClientRect();
        return {
            scrollY: window.scrollY,
            firstTop: r?.top ?? null,
            applyVisible: !![...document.querySelectorAll('button,a')].find((el) =>
                /^\s*apply\s*$/i.test((el.innerText || '').trim())
            )
        };
    });

    await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a')].find((el) =>
            /^\s*apply\s*$/i.test((el.innerText || '').trim())
            || /apply for this job/i.test((el.innerText || '').trim())
        );
        if (btn) btn.click();
        const form = document.querySelector('#application, #application-form, form#application-form');
        if (form) form.scrollIntoView({ block: 'start', behavior: 'instant' });
        else {
            const first = document.querySelector('#first_name, [name=first_name]');
            first?.scrollIntoView({ block: 'center', behavior: 'instant' });
        }
    });
    await page.waitForTimeout(1500);

    const after = await page.evaluate(() => {
        const first = document.querySelector('#first_name, [name=first_name]');
        const r = first?.getBoundingClientRect();
        const val = first ? String(first.value || '') : '';
        return {
            scrollY: window.scrollY,
            firstTop: r?.top ?? null,
            firstInViewport: !!(r && r.top >= 0 && r.top < window.innerHeight),
            firstNameEmpty: val === ''
        };
    });

    return { before, after };
}
