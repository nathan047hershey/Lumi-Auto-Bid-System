/**
 * Browser smoke: Flexential select shows No; phone empty.
 * Reads DOM the same way the fill engine does (no reliance on page scripts).
 */
export default async function (page) {
    const snap = await page.evaluate(() => {
        const phoneVal = document.getElementById('phone')?.value || '';
        const hasSingle = !!document.querySelector('.select__single-value');
        const hasHasValue = !!document.querySelector('.select__value-container--has-value');
        const selectVal = (document.querySelector('#field-flexential .select__single-value')?.textContent || '').trim();

        const el = document.querySelector('#flexential_select');
        const shell = el?.closest(
            '.select-shell, .select__container, .select, .select__control'
        ) || el?.parentElement;
        const single = shell?.querySelector('.select__single-value');
        const readLikeEngine = (single?.textContent || '').trim();

        return { phoneVal, hasSingle, hasHasValue, selectVal, readLikeEngine };
    });

    const ok =
        snap.selectVal === 'No'
        && snap.readLikeEngine === 'No'
        && snap.hasSingle
        && snap.hasHasValue
        && snap.phoneVal === '';

    return {
        ok,
        ...snap,
        note: 'Phone intentionally empty; Flexential No must be readable like production engine'
    };
}
