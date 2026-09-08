(() => {
    if (window.__JOB_APPLY_BIDDER_SCRAPE__) return;
    window.__JOB_APPLY_BIDDER_SCRAPE__ = true;

    function textOf(el) {
        if (!el) return '';
        return (el.innerText || el.textContent || '').replace(/\s+\n/g, '\n').trim();
    }

    function firstMatch(selectors, { minLen = 1 } = {}) {
        for (const sel of selectors) {
            try {
                const el = document.querySelector(sel);
                if (el) {
                    const t = textOf(el);
                    if (t && t.length >= minLen) return { text: t, el };
                }
            } catch (_) { /* ignore bad selectors */ }
        }
        return null;
    }

    function meta(name) {
        const el =
            document.querySelector(`meta[property="${name}"]`)
            || document.querySelector(`meta[name="${name}"]`);
        return el?.getAttribute('content')?.trim() || '';
    }

    function getSelectionText() {
        try {
            const t = (window.getSelection()?.toString() || '').trim();
            return t.length >= 80 ? t : '';
        } catch (_) {
            return '';
        }
    }

    function scrapeJobPage() {
        const title =
            firstMatch([
                'h1',
                '[data-testid="job-title"]',
                '.job-title',
                '.posting-headline h2',
                '.posting-headline h1',
                '[class*="JobTitle"]',
                '[class*="jobTitle"]',
                'h2.job-title'
            ])?.text
            || meta('og:title')
            || document.title
            || '';

        const company =
            firstMatch([
                '[data-testid="company-name"]',
                '.company-name',
                '.company',
                '[class*="CompanyName"]',
                '[class*="companyName"]',
                'a[data-company-name]',
                '.employer'
            ])?.text
            || meta('og:site_name')
            || '';

        // 1) Manual selection wins — avoids nav/footer/sidebar junk.
        const selected = getSelectionText();
        let description = selected;
        let source = selected ? 'selection' : '';

        // 2) Remembered pick from click-to-capture mode.
        if (!description && window.__JOB_APPLY_BIDDER_JD_PICK__) {
            description = String(window.__JOB_APPLY_BIDDER_JD_PICK__).trim();
            if (description.length >= 80) source = 'picked';
            else description = '';
        }

        // 3) Known JD containers only (never whole <body>/<main>).
        if (!description) {
            const hit = firstMatch([
                // Greenhouse job boards / embed apply
                '.job__description',
                '.job__description.body',
                '#content .job__description',
                '.job-post .job__description',
                // Ashby hosted jobs
                '.ashby-job-posting-description',
                '.ashby-job-posting-description-container',
                '#overview.ashby-job-posting-description-container',
                '#overview [class*="descriptionText"]',
                '[data-testid="job-description"]',
                '#job-description',
                '.job-description',
                '.jobDescription',
                '[class*="jobDescription"]',
                '[class*="JobDescription"]',
                '.description__text',
                '.posting-description',
                '#content .content',
                '[data-qa="job-description"]',
                '.jobs-description',
                '.jobs-description__content',
                '#jobDescriptionText',
                '.jobsearch-JobComponent-description'
            ], { minLen: 80 });
            if (hit) {
                description = hit.text;
                source = 'selector';
            }
        }

        // Cap payload size.
        const trimmedDesc = description.length > 60000
            ? description.slice(0, 60000)
            : description;

        return {
            url: location.href,
            title: String(title).slice(0, 300),
            company: String(company).slice(0, 200),
            description: trimmedDesc,
            source: source || 'none',
            needsSelection: !trimmedDesc || trimmedDesc.length < 80,
            scrapedAt: new Date().toISOString()
        };
    }

    function removePickUi() {
        document.getElementById('__job_apply_bidder_jd_banner')?.remove();
        document.getElementById('__job_apply_bidder_jd_hl')?.remove();
        document.removeEventListener('mousemove', onPickMove, true);
        document.removeEventListener('click', onPickClick, true);
        document.removeEventListener('keydown', onPickKey, true);
        window.__JOB_APPLY_BIDDER_JD_PICKING__ = false;
    }

    function onPickMove(e) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el.closest('#__job_apply_bidder_jd_banner')) return;
        let target = el;
        // Prefer a reasonably large text block.
        for (let i = 0; i < 6 && target; i += 1) {
            const t = textOf(target);
            if (t.length >= 120 && t.length < 80000) break;
            target = target.parentElement;
        }
        if (!target) return;
        let hl = document.getElementById('__job_apply_bidder_jd_hl');
        if (!hl) {
            hl = document.createElement('div');
            hl.id = '__job_apply_bidder_jd_hl';
            Object.assign(hl.style, {
                position: 'fixed',
                pointerEvents: 'none',
                zIndex: '2147483646',
                border: '2px solid #2563eb',
                background: 'rgba(37,99,235,0.12)',
                borderRadius: '4px'
            });
            document.documentElement.appendChild(hl);
        }
        const r = target.getBoundingClientRect();
        Object.assign(hl.style, {
            top: `${r.top}px`,
            left: `${r.left}px`,
            width: `${r.width}px`,
            height: `${r.height}px`
        });
        window.__JOB_APPLY_BIDDER_JD_HOVER__ = target;
    }

    function onPickClick(e) {
        if (e.target?.closest?.('#__job_apply_bidder_jd_banner')) return;
        e.preventDefault();
        e.stopPropagation();
        const target = window.__JOB_APPLY_BIDDER_JD_HOVER__;
        const t = textOf(target);
        if (!t || t.length < 80) {
            showBanner('Block too short — highlight a larger JD section, or select text then Alt+Shift+G', true);
            return;
        }
        window.__JOB_APPLY_BIDDER_JD_PICK__ = t;
        removePickUi();
        showBanner(`JD captured (${t.length} chars). Press Alt+Shift+G to generate.`, false);
        try {
            chrome.runtime.sendMessage({
                type: 'JD_PICKED',
                job: {
                    url: location.href,
                    title: document.title,
                    description: t,
                    source: 'picked'
                }
            });
        } catch (_) { /* ignore */ }
    }

    function onPickKey(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            removePickUi();
            showBanner('JD pick cancelled', true);
        }
    }

    function showBanner(text, isError) {
        let el = document.getElementById('__job_apply_bidder_jd_banner');
        if (!el) {
            el = document.createElement('div');
            el.id = '__job_apply_bidder_jd_banner';
            Object.assign(el.style, {
                position: 'fixed',
                zIndex: '2147483647',
                top: '12px',
                left: '50%',
                transform: 'translateX(-50%)',
                maxWidth: '520px',
                padding: '10px 14px',
                borderRadius: '10px',
                fontFamily: 'system-ui,Segoe UI,sans-serif',
                fontSize: '13px',
                lineHeight: '1.35',
                boxShadow: '0 8px 24px rgba(0,0,0,.28)',
                color: '#fff',
                textAlign: 'center'
            });
            document.documentElement.appendChild(el);
        }
        el.style.background = isError ? '#b91c1c' : '#1d4ed8';
        el.textContent = String(text || '').slice(0, 320);
        clearTimeout(el.__hide);
        el.__hide = setTimeout(() => {
            try { el.remove(); } catch (_) { /* ignore */ }
        }, 7000);
    }

    function startJdPickMode() {
        if (window.__JOB_APPLY_BIDDER_JD_PICKING__) {
            removePickUi();
            return { ok: true, cancelled: true };
        }
        window.__JOB_APPLY_BIDDER_JD_PICKING__ = true;
        const banner = document.createElement('div');
        banner.id = '__job_apply_bidder_jd_banner';
        Object.assign(banner.style, {
            position: 'fixed',
            zIndex: '2147483647',
            top: '12px',
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: '560px',
            padding: '12px 16px',
            borderRadius: '10px',
            fontFamily: 'system-ui,Segoe UI,sans-serif',
            fontSize: '13px',
            lineHeight: '1.4',
            boxShadow: '0 8px 24px rgba(0,0,0,.28)',
            color: '#fff',
            background: '#1d4ed8',
            textAlign: 'center'
        });
        banner.innerHTML =
            '<strong>Select the job description</strong><br/>'
            + 'Click the JD block (or drag-select text), then press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>. Esc to cancel.';
        document.documentElement.appendChild(banner);
        document.addEventListener('mousemove', onPickMove, true);
        document.addEventListener('click', onPickClick, true);
        document.addEventListener('keydown', onPickKey, true);
        return { ok: true, picking: true };
    }

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'SCRAPE_JOB') {
            try {
                sendResponse({ ok: true, data: scrapeJobPage() });
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'START_JD_PICK') {
            try {
                sendResponse(startJdPickMode());
            } catch (err) {
                sendResponse({ ok: false, error: err?.message || String(err) });
            }
            return true;
        }
        if (msg?.type === 'CLEAR_JD_PICK') {
            window.__JOB_APPLY_BIDDER_JD_PICK__ = '';
            removePickUi();
            sendResponse({ ok: true });
            return true;
        }
        return false;
    });
})();
