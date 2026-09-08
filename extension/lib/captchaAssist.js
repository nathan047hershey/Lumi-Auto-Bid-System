/**
 * CAPTCHA helper assist — nudge NopeCHA / Buster / widget checkboxes.
 * Runs in page frames via chrome.scripting (no paid API).
 */

/**
 * Pure function injected into every frame. Returns { clicked, tried }.
 * @param {string} vendorArg
 */
export function assistCaptchaInFrame(vendorArg) {
    const tried = [];
    const fireClick = (el) => {
        if (!el || el.disabled) return false;
        try {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        } catch (_) { /* ignore */ }
        try { el.focus({ preventScroll: true }); } catch (_) {
            try { el.focus(); } catch (_) { /* ignore */ }
        }
        try {
            const r = el.getBoundingClientRect();
            const x = r.left + Math.min(r.width / 2, 24);
            const y = r.top + Math.min(r.height / 2, 24);
            const opts = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                button: 0
            };
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            if (typeof el.click === 'function') el.click();
            return true;
        } catch (_) {
            try { el.click(); return true; } catch (_) { return false; }
        }
    };
    const clickEl = (el, label) => {
        if (!el) return false;
        if (fireClick(el)) {
            tried.push(label);
            return true;
        }
        return false;
    };

    const v = String(vendorArg || '').toLowerCase();

    // —— reCAPTCHA (NopeCHA + Buster) ——
    if (!v || /recaptcha|generic|none|login/i.test(v)) {
        const anchors = document.querySelectorAll(
            '#recaptcha-anchor, #recaptcha-anchor-label, .recaptcha-checkbox-border, '
            + '.recaptcha-checkbox, span.recaptcha-checkbox, span[role="checkbox"][id*="recaptcha"], '
            + '.rc-anchor-checkbox, #rc-anchor-container'
        );
        for (const box of anchors) {
            if (clickEl(box, 'recaptcha-anchor')) break;
        }

        // Buster solver button (open shadow when present)
        const busterHosts = document.querySelectorAll(
            '.button-holder.help-button-holder, .help-button-holder, div.button-holder, '
            + '[class*="buster"], [id*="buster"]'
        );
        for (const host of busterHosts) {
            tried.push('buster-host');
            try {
                const root = host.shadowRoot;
                if (root) {
                    const btn = root.querySelector(
                        '#solver-button, button.solver-button, button, [role="button"]'
                    );
                    if (clickEl(btn, 'buster-solver')) break;
                }
            } catch (_) { /* closed shadow */ }
            clickEl(host, 'buster-host-click');
        }

        const audioBtn = document.querySelector(
            '#recaptcha-audio-button, .rc-button-audio, button#recaptcha-audio-button, '
            + 'button[title*="audio" i], button[aria-label*="audio" i]'
        );
        clickEl(audioBtn, 'recaptcha-audio');

        const iframes = document.querySelectorAll(
            'iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i], .g-recaptcha iframe, '
            + 'iframe[src*="google.com/recaptcha"]'
        );
        for (const iframe of iframes) {
            tried.push('found-recaptcha-iframe');
            try {
                iframe.scrollIntoView({ block: 'center', inline: 'nearest' });
                iframe.click();
                tried.push('recaptcha-iframe-click');
            } catch (_) { /* ignore */ }
        }

        // Visible g-recaptcha container — click helps some helpers attach
        const g = document.querySelector('.g-recaptcha, [data-sitekey]');
        if (g && !g.closest('iframe')) clickEl(g, 'g-recaptcha-container');
    }

    // —— hCaptcha (NopeCHA) ——
    if (!v || /hcaptcha|generic|none/i.test(v)) {
        const hBoxes = document.querySelectorAll(
            '#checkbox, .challenge-container [role="checkbox"], '
            + 'div#cf-stage, [data-hcaptcha-widget-id], .h-captcha'
        );
        for (const hBox of hBoxes) {
            if (hBox.tagName !== 'IFRAME') clickEl(hBox, 'hcaptcha-checkbox');
        }
        const hIframes = document.querySelectorAll(
            'iframe[src*="hcaptcha"], iframe[title*="hCaptcha" i]'
        );
        for (const hIframe of hIframes) {
            try {
                hIframe.scrollIntoView({ block: 'center' });
                hIframe.click();
                tried.push('hcaptcha-iframe');
            } catch (_) { /* ignore */ }
        }
    }

    // —— Turnstile / Cloudflare (NopeCHA) ——
    if (!v || /turnstile|cloudflare|generic|none/i.test(v)) {
        const tsNodes = document.querySelectorAll(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], '
            + '.cf-turnstile, [data-sitekey].cf-turnstile, div[id*="cf-"]'
        );
        for (const ts of tsNodes) {
            try {
                ts.scrollIntoView({ block: 'center' });
                ts.click();
                tried.push('turnstile-widget');
            } catch (_) { /* ignore */ }
        }
    }

    // —— NopeCHA / helper UI chrome (if injected into page) ——
    const helperUi = document.querySelectorAll(
        '[class*="nopecha" i], [id*="nopecha" i], [class*="captcha-solver" i], '
        + 'button[aria-label*="solve" i], button[title*="solve" i]'
    );
    for (const el of helperUi) {
        clickEl(el, 'helper-ui');
    }

    // —— Generic “I'm not a robot” ——
    const btn = [...document.querySelectorAll('button, div[role="button"], label, span, a')]
        .find((n) => /i.?m not a robot|verify you are human|human verification/i.test(
            `${n.textContent || ''} ${n.getAttribute('aria-label') || ''} ${n.getAttribute('title') || ''}`
        ));
    clickEl(btn, 'not-a-robot-label');

    const clicked = tried.some((t) =>
        /anchor|solver|audio|iframe-click|checkbox|turnstile|hcaptcha|not-a-robot|buster-host-click|helper-ui|g-recaptcha/i.test(t)
    );
    return { clicked, tried, vendor: vendorArg || null };
}

/**
 * Detect solved CAPTCHA tokens / checked anchors in a frame (pure, injectable).
 */
export function detectCaptchaSolvedInFrame() {
    const signals = [];
    try {
        const ta = document.querySelector('textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
        if (ta && String(ta.value || '').trim().length > 20) signals.push('recaptcha-response');
    } catch (_) { /* ignore */ }
    try {
        const h = document.querySelector('textarea[name="h-captcha-response"], [name="h-captcha-response"]');
        if (h && String(h.value || '').trim().length > 20) signals.push('hcaptcha-response');
    } catch (_) { /* ignore */ }
    try {
        const cf = document.querySelector('[name="cf-turnstile-response"], input[name*="turnstile" i]');
        if (cf && String(cf.value || '').trim().length > 10) signals.push('turnstile-response');
    } catch (_) { /* ignore */ }
    try {
        const checked = document.querySelector(
            '#recaptcha-anchor[aria-checked="true"], .recaptcha-checkbox-checked, '
            + '[aria-checked="true"].recaptcha-checkbox, .rc-anchor-checkbox-checked'
        );
        if (checked) signals.push('recaptcha-checked');
    } catch (_) { /* ignore */ }
    return { solved: signals.length > 0, signals };
}

/**
 * Run assist across all frames; merge results.
 */
export async function assistCaptchaHelpers(tabId, vendorHint = '') {
    const vendor = String(vendorHint || '').toLowerCase();
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            args: [vendor],
            func: assistCaptchaInFrame
        });
        const tried = [];
        let clicked = false;
        let frames = 0;
        for (const row of results || []) {
            frames += 1;
            const r = row?.result;
            if (!r) continue;
            if (Array.isArray(r.tried)) tried.push(...r.tried.map((t) => `f${frames}:${t}`));
            if (r.clicked) clicked = true;
        }
        return { clicked, tried, frames, vendor: vendor || null, engine: 'captcha-assist-v3' };
    } catch (err) {
        return {
            clicked: false,
            tried: [],
            error: true,
            message: err?.message || String(err),
            engine: 'captcha-assist-v3'
        };
    }
}

/** Check whether helpers already produced a token / checked state. */
export async function detectCaptchaSolved(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: detectCaptchaSolvedInFrame
        });
        const signals = [];
        for (const row of results || []) {
            const r = row?.result;
            if (r?.solved && Array.isArray(r.signals)) signals.push(...r.signals);
        }
        return { solved: signals.length > 0, signals };
    } catch (err) {
        return { solved: false, signals: [], error: err?.message || String(err) };
    }
}

/**
 * Brief focus pulse (helpers often need a focused tab) + re-assist loop.
 * Pulses focus then restores the previous tab when possible.
 */
export async function assistCaptchaHelpersWithRetry(tabId, vendorHint = '', {
    attempts = 3,
    gapMs = 1200,
    focusPulse = true
} = {}) {
    let last = { clicked: false, tried: [], engine: 'captcha-assist-v3' };
    let prevTabId = null;
    let prevWindowId = null;
    if (focusPulse) {
        try {
            const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            prevTabId = active?.id || null;
            prevWindowId = active?.windowId || null;
            const tab = await chrome.tabs.get(tabId);
            if (tab?.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
            }
            await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        } catch (_) { /* ignore */ }
    }
    try {
        for (let i = 0; i < Math.max(1, attempts); i += 1) {
            const solved = await detectCaptchaSolved(tabId);
            if (solved.solved) {
                return {
                    ...last,
                    clicked: true,
                    solved: true,
                    signals: solved.signals,
                    attempts: i + 1
                };
            }
            last = await assistCaptchaHelpers(tabId, vendorHint);
            last.attempts = i + 1;
            if (i < attempts - 1) {
                await new Promise((r) => setTimeout(r, gapMs));
            }
        }
        const finalSolved = await detectCaptchaSolved(tabId);
        return {
            ...last,
            solved: !!finalSolved.solved,
            signals: finalSolved.signals || []
        };
    } finally {
        if (focusPulse && prevTabId) {
            try {
                if (prevWindowId) await chrome.windows.update(prevWindowId, { focused: true }).catch(() => {});
                await chrome.tabs.update(prevTabId, { active: true }).catch(() => {});
            } catch (_) { /* ignore */ }
        }
    }
}
